import { memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Page, PageHeader } from "../../components/page";
import { Columns2, Play, Rows2, Square } from "lucide-react";
import { ModuleActiveContext } from "../../components/moduleActiveContext";
import {
  dpsListLogs,
  dpsLogSummary,
  dpsPlayback,
  dpsStart,
  dpsStop,
  errorMessage,
  onDpsTick,
  type DpsLogFile,
  type DpsLogSummary,
  type DpsTick,
  type HitQuality,
  type PilotRate,
  type WeaponRate,
} from "../../lib/api";
import { formatInt } from "../../lib/format";
import { STORAGE_KEYS } from "../../lib/storageKeys";
import { useEveLogDir } from "../../lib/useEveLogDir";
import { usePersistentState } from "../../lib/usePersistentState";

type Mode = "live" | "playback";

/** How the two charts are arranged: side by side or stacked vertically. */
type ChartLayout = "side" | "stacked";

// How many ticks to keep on screen (~2 min at the 500 ms backend cadence).
const BUFFER = 240;

// The series we graph + read out. `out` series share warm colours, `in` cool.
const SERIES = [
  { key: "dpsOut", label: "DPS out", color: "#34d399", primary: true },
  { key: "dpsIn", label: "DPS in", color: "#f87171", primary: true },
  { key: "logiOut", label: "Logi out", color: "#38bdf8", primary: false },
  { key: "logiIn", label: "Logi in", color: "#a78bfa", primary: false },
  {
    key: "capWarfareOut",
    label: "Cap warfare out",
    color: "#fbbf24",
    primary: false,
  },
  {
    key: "capWarfareIn",
    label: "Cap warfare in",
    color: "#fb923c",
    primary: false,
  },
  {
    key: "capTransferOut",
    label: "Cap xfer out",
    color: "#2dd4bf",
    primary: false,
  },
  {
    key: "capTransferIn",
    label: "Cap xfer in",
    color: "#c084fc",
    primary: false,
  },
] as const satisfies readonly {
  key: keyof DpsTick;
  label: string;
  color: string;
  primary: boolean;
}[];

/** A chart line: identity + colour + a per-tick value accessor. The accessor
 *  lets the same chart draw aggregate series (tick fields) and per-source
 *  series (rows inside `byPilot`) without special-casing either. */
type ChartSeries = {
  id: string;
  color: string;
  primary: boolean;
  get: (t: DpsTick) => number;
};

/** Series drawn on the outgoing (dealt) chart. */
const SERIES_OUT: ChartSeries[] = SERIES.filter((s) =>
  (
    ["dpsOut", "logiOut", "capWarfareOut", "capTransferOut"] as string[]
  ).includes(s.key),
).map((s) => ({
  id: s.key,
  color: s.color,
  primary: s.primary,
  get: (t) => t[s.key],
}));
/** Series drawn on the incoming (taken) chart. */
const SERIES_IN: ChartSeries[] = SERIES.filter((s) =>
  (["dpsIn", "logiIn", "capWarfareIn", "capTransferIn"] as string[]).includes(
    s.key,
  ),
).map((s) => ({
  id: s.key,
  color: s.color,
  primary: s.primary,
  get: (t) => t[s.key],
}));

// Palette for per-source (by-pilot) lines — distinct hues, assigned to each
// source on first sighting and kept for the session so a source never changes
// colour mid-fight. Wraps past 10 concurrent sources.
const SOURCE_COLORS = [
  "#60a5fa", // blue
  "#f472b6", // pink
  "#4ade80", // green
  "#facc15", // yellow
  "#22d3ee", // cyan
  "#fb923c", // orange
  "#a78bfa", // violet
  "#f87171", // red
  "#2dd4bf", // teal
  "#e879f9", // fuchsia
];

/** Append a tick to the rolling buffer, dropping the oldest past `BUFFER`. */
function appendTick(prev: DpsTick[], t: DpsTick): DpsTick[] {
  const next = prev.length >= BUFFER ? prev.slice(1) : prev.slice();
  next.push(t);
  return next;
}

// Finest mining bucket granularity (s). Volumes accumulate at this resolution;
// the panel's 30 s view merges adjacent pairs, so both intervals share one store.
const MINING_BUCKET_SECS = 15;
// How many intervals the mining rate line shows.
const MINING_BARS = 24;
// Trailing window (s) each mining-rate point averages over. Mining lasers book
// ore in cycle-sized chunks (a strip miner ~1000 m³ every ~60 s), so anything
// shorter than a cycle would show spikes instead of the sustained rate.
const MINING_SMOOTH_SECS = 60;

/** Compact local date/time for a gamelog's mtime, e.g. "Aug 6, 15:32" — so
 *  picking a file from the list tells you which session it was (#dps-search). */
function formatLogDate(epochSecs: number): string {
  return new Date(epochSecs * 1000).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Bare time-of-day for a playback timestamp, e.g. "15:32:07" — playback
 *  never spans more than one gamelog session, so the date doesn't matter. */
function formatClock(epochSecs: number): string {
  return new Date(epochSecs * 1000).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Searchable gamelog picker: type to filter by filename; each row (and the
 *  collapsed field once picked) shows the file's modified date, so you can
 *  tell sessions apart at a glance instead of reading raw filenames (#719). */
function LogFilePicker({
  logs,
  file,
  onPick,
}: {
  logs: DpsLogFile[];
  file: string;
  onPick: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [open, setOpen] = useState(false);
  const selected = logs.find((l) => l.path === file) ?? null;
  const label = selected
    ? `${selected.name} — ${formatLogDate(selected.modified)}`
    : "";
  const q = query.trim().toLowerCase();
  const matches = q
    ? logs.filter((l) => l.name.toLowerCase().includes(q))
    : logs;

  return (
    <div className="relative flex-1 min-w-[16rem]">
      <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-500">
        Log file
      </span>
      <input
        value={open ? query : label}
        onChange={(e) => setQuery(e.currentTarget.value)}
        onFocus={() => {
          setQuery("");
          setOpen(true);
        }}
        onBlur={() => setOpen(false)}
        placeholder={
          logs.length === 0 ? "No logs found" : "search by filename…"
        }
        className="w-full rounded bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
      />
      {open && (
        // Keep focus on the input on mousedown (no default) so blur never
        // fires before the row's onClick runs — the dropdown closes there.
        <div
          onMouseDown={(e) => e.preventDefault()}
          className="absolute z-10 mt-1 max-h-60 w-full overflow-auto rounded border border-zinc-700 bg-zinc-900 text-sm shadow-lg"
        >
          {matches.length === 0 && (
            <div className="px-2 py-1.5 text-xs text-zinc-500">No matches.</div>
          )}
          {matches.map((l) => (
            <button
              key={l.path}
              onClick={() => {
                onPick(l.path);
                setQuery("");
                setOpen(false);
              }}
              className={`flex w-full items-center justify-between gap-2 px-2 py-1.5 text-left hover:bg-zinc-800 ${
                l.path === file
                  ? "bg-zinc-800/70 text-zinc-100"
                  : "text-zinc-300"
              }`}
            >
              <span className="truncate">{l.name}</span>
              <span className="ml-2 shrink-0 text-[11px] tabular-nums text-zinc-500">
                {formatLogDate(l.modified)}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** Timeline swatch color per event category — reused from the primary
 *  readouts (dpsOut/dpsIn) and the mining panel's amber, so the same color
 *  means the same thing everywhere on this page. */
const TIMELINE_COLORS = {
  damageOut: "#34d399",
  damageIn: "#f87171",
  mining: "#fcd34d",
} as const;

function TimelineLegend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <span
        className="inline-block h-1.5 w-1.5 rounded-sm"
        style={{ background: color }}
      />
      {label}
    </span>
  );
}

/** Playback scrubber (#dps-timeline): a slider over the log's full time span,
 *  with a density strip underneath roughly showing where damage/mining
 *  happened — three thin rows (dealt / taken / mined), each bucket's height
 *  scaled to its own category's busiest moment in the file. Dragging the
 *  slider or clicking the strip both seek; releasing restarts playback from
 *  that point with the moving-average window pre-warmed (backend side). */
function PlaybackTimeline({
  summary,
  position,
  onSeek,
}: {
  summary: DpsLogSummary;
  position: number | null;
  onSeek: (ts: number) => void;
}) {
  const [preview, setPreview] = useState<number | null>(null);
  const { start, end, buckets } = summary;
  const span = Math.max(1, end - start);
  const value = preview ?? position ?? start;

  const w = 960;
  const h = 36;
  const rowH = h / 3;
  const barW = w / Math.max(1, buckets.length);

  const seekFromClientX = (clientX: number, el: Element) => {
    const rect = el.getBoundingClientRect();
    const frac = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return Math.round(start + frac * span);
  };

  return (
    <div className="mt-4 rounded border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="mb-1 flex items-center justify-between text-[11px] tabular-nums text-zinc-500">
        <span>{formatClock(start)}</span>
        <span className="flex items-center gap-3 normal-case tracking-normal text-zinc-400">
          <TimelineLegend color={TIMELINE_COLORS.damageOut} label="dmg out" />
          <TimelineLegend color={TIMELINE_COLORS.damageIn} label="dmg in" />
          <TimelineLegend color={TIMELINE_COLORS.mining} label="mining" />
        </span>
        <span>{formatClock(end)}</span>
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        className="w-full cursor-pointer"
        style={{ height: h }}
        onClick={(e) => onSeek(seekFromClientX(e.clientX, e.currentTarget))}
      >
        <g fill={TIMELINE_COLORS.damageOut}>
          {buckets.map((b, i) => (
            <rect
              key={i}
              x={i * barW}
              y={rowH * (1 - b.damageOut)}
              width={Math.max(1, barW - 0.5)}
              height={rowH * b.damageOut}
            />
          ))}
        </g>
        <g fill={TIMELINE_COLORS.damageIn}>
          {buckets.map((b, i) => (
            <rect
              key={i}
              x={i * barW}
              y={rowH + rowH * (1 - b.damageIn)}
              width={Math.max(1, barW - 0.5)}
              height={rowH * b.damageIn}
            />
          ))}
        </g>
        <g fill={TIMELINE_COLORS.mining}>
          {buckets.map((b, i) => (
            <rect
              key={i}
              x={i * barW}
              y={rowH * 2 + rowH * (1 - b.mining)}
              width={Math.max(1, barW - 0.5)}
              height={rowH * b.mining}
            />
          ))}
        </g>
        <line
          x1={((value - start) / span) * w}
          x2={((value - start) / span) * w}
          y1={0}
          y2={h}
          stroke="#e4e4e7"
          strokeWidth="1.5"
        />
      </svg>
      <input
        type="range"
        min={start}
        max={end}
        step={1}
        value={value}
        onChange={(e) => setPreview(Number(e.currentTarget.value))}
        onMouseUp={(e) => {
          onSeek(Number(e.currentTarget.value));
          setPreview(null);
        }}
        onTouchEnd={(e) => {
          onSeek(Number(e.currentTarget.value));
          setPreview(null);
        }}
        className="mt-1 w-full accent-indigo-500"
      />
      <div className="mt-0.5 text-center text-[11px] tabular-nums text-zinc-400">
        {formatClock(value)}
      </div>
    </div>
  );
}

export function DpsPage() {
  const [dir, setDir, persistDir] = useEveLogDir("gamelogs");
  const [windowSecs, setWindowSecs] = useState(() =>
    Number(localStorage.getItem(STORAGE_KEYS.dpsWindowSecs) ?? 10),
  );
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ticks, setTicks] = useState<DpsTick[]>([]);
  const [mode, setMode] = useState<Mode>("live");
  const [logs, setLogs] = useState<DpsLogFile[]>([]);
  const [file, setFile] = useState("");
  const [speed, setSpeed] = useState(4);
  const [selectedPilot, setSelectedPilot] = useState<string | null>(null);
  // Timeline summary for the selected playback file — activity buckets for
  // the scrubber's density strip; null while loading/unavailable (no chart).
  const [summary, setSummary] = useState<DpsLogSummary | null>(null);
  // Chart arrangement + breakdown mode — persisted so the meter opens how you
  // left it.
  const [chartLayout, setChartLayout] = usePersistentState<ChartLayout>(
    STORAGE_KEYS.dpsChartLayout,
    "side",
  );
  const [bySource, setBySource] = usePersistentState<boolean>(
    STORAGE_KEYS.dpsChartBySource,
    false,
  );
  const [miningInterval, setMiningInterval] = usePersistentState<15 | 30>(
    STORAGE_KEYS.dpsMiningInterval,
    30,
  );

  // The page stays mounted while backgrounded (ModuleHost), so without this it
  // would keep re-rendering ~2×/s off the tick feed while invisible. Track the
  // active flag in a ref so the single subscription reads the latest value
  // without resubscribing, and buffer ticks that arrive while hidden.
  const active = useContext(ModuleActiveContext);
  const activeRef = useRef(active);
  activeRef.current = active;
  const bufferedRef = useRef<DpsTick[]>([]);
  // Session peaks for the two primary readouts (reset on Start / Play).
  const peaksRef = useRef({ out: 0, in: 0 });
  // Mined volume per 15 s bucket (bucket start-epoch → m³), session-lifetime.
  // Accumulated in the tick subscription (not from the `ticks` state) so mining
  // history is not capped by the 2-min chart buffer and keeps counting while
  // the page is hidden. Reset on Start / Play.
  const miningRef = useRef<{
    buckets: Map<number, number>;
    lastAt: number | null;
  }>({
    buckets: new Map(),
    lastAt: null,
  });

  // Subscribe once; the feed survives navigation. Ticks only arrive while a
  // capture is running.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onDpsTick((t) => {
      const peaks = peaksRef.current;
      peaks.out = Math.max(peaks.out, t.dpsOut);
      peaks.in = Math.max(peaks.in, t.dpsIn);
      // Integrate the windowed mining rate into interval buckets: rate × the
      // gap since the previous tick (clamped — a stall must not book a huge
      // spurious volume into one bucket).
      const mining = miningRef.current;
      const dt =
        mining.lastAt == null
          ? 0
          : Math.min(Math.max(t.at - mining.lastAt, 0), 5);
      mining.lastAt = t.at;
      if (t.miningM3 > 0 && dt > 0) {
        const bucket =
          Math.floor(t.at / MINING_BUCKET_SECS) * MINING_BUCKET_SECS;
        mining.buckets.set(
          bucket,
          (mining.buckets.get(bucket) ?? 0) + t.miningM3 * dt,
        );
      }
      if (!activeRef.current) {
        // Hidden: accumulate without triggering a render; flushed on re-show.
        const buf = bufferedRef.current;
        buf.push(t);
        if (buf.length > BUFFER) buf.splice(0, buf.length - BUFFER);
        return;
      }
      setTicks((prev) => appendTick(prev, t));
    }).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, []);

  // On becoming visible again, flush whatever arrived while hidden in one update.
  useEffect(() => {
    if (!active || bufferedRef.current.length === 0) return;
    const buffered = bufferedRef.current;
    bufferedRef.current = [];
    setTicks((prev) => {
      const merged = prev.concat(buffered);
      return merged.length > BUFFER
        ? merged.slice(merged.length - BUFFER)
        : merged;
    });
  }, [active]);

  async function start() {
    setError(null);
    persistDir();
    localStorage.setItem(STORAGE_KEYS.dpsWindowSecs, String(windowSecs));
    peaksRef.current = { out: 0, in: 0 };
    miningRef.current = { buckets: new Map(), lastAt: null };
    setSelectedPilot(null);
    try {
      await dpsStart({ gamelogsDir: dir, windowSecs });
      setRunning(true);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function stop() {
    await dpsStop();
    setRunning(false);
  }

  // Load the gamelog list when switching to playback (or when the folder is set).
  async function refreshLogs() {
    setError(null);
    try {
      const list = await dpsListLogs(dir);
      setLogs(list);
      if (list.length > 0 && !file) setFile(list[0].path);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  /** Play from the start, or (when scrubbing the timeline) jump straight to
   *  `seekTs` — the backend pre-warms the moving-average window so the DPS
   *  readout isn't cold at the seek point. */
  async function playback(seekTs?: number) {
    setError(null);
    setTicks([]);
    peaksRef.current = { out: 0, in: 0 };
    miningRef.current = { buckets: new Map(), lastAt: null };
    setSelectedPilot(null);
    try {
      await dpsPlayback({ file, speed, windowSecs, seekTs });
      setRunning(true);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  // Load the selected file's activity summary for the timeline scrubber
  // whenever it changes; cleared outside playback mode or on failure (the
  // timeline just doesn't render — it's a bonus, not required to play).
  useEffect(() => {
    if (mode !== "playback" || !file) {
      setSummary(null);
      return;
    }
    let cancelled = false;
    dpsLogSummary(file)
      .then((s) => {
        if (!cancelled) setSummary(s);
      })
      .catch(() => {
        if (!cancelled) setSummary(null);
      });
    return () => {
      cancelled = true;
    };
  }, [mode, file]);

  function switchMode(m: Mode) {
    setMode(m);
    if (m === "playback") refreshLogs();
  }

  const latest = ticks[ticks.length - 1];

  // Collect every pilot name seen across the whole buffer so buttons stay
  // visible even after a pilot ages out of the rolling window.
  const knownPilots = useMemo(
    () =>
      [...new Set(ticks.flatMap((t) => t.byPilot.map((p) => p.name)))].sort(),
    [ticks],
  );

  // Stable per-source colours: assigned from SOURCE_COLORS the first time a
  // name is seen and kept for the session (a Map, not per-buffer, so a source
  // that ages out of the rolling window and returns keeps its colour).
  const sourceColorsRef = useRef(new Map<string, string>());
  const sourceColors = sourceColorsRef.current;
  for (const name of knownPilots) {
    if (!sourceColors.has(name)) {
      sourceColors.set(
        name,
        SOURCE_COLORS[sourceColors.size % SOURCE_COLORS.length],
      );
    }
  }

  // Per-source chart series (by-source mode): one line per counterparty —
  // damage dealt to them on the Outgoing chart, taken from them on Incoming.
  // A selected pilot narrows the breakdown to just that engagement.
  const { outSeries, inSeries } = useMemo(() => {
    if (!bySource) return { outSeries: SERIES_OUT, inSeries: SERIES_IN };
    const names = selectedPilot
      ? knownPilots.filter((n) => n === selectedPilot)
      : knownPilots;
    const mk = (field: "dpsOut" | "dpsIn"): ChartSeries[] =>
      names.map((name) => ({
        id: name,
        color: sourceColorsRef.current.get(name) ?? SOURCE_COLORS[0],
        primary: true,
        get: (t) => t.byPilot.find((p) => p.name === name)?.[field] ?? 0,
      }));
    return { outSeries: mk("dpsOut"), inSeries: mk("dpsIn") };
  }, [bySource, knownPilots, selectedPilot]);

  // When a pilot is selected, replace the aggregate dpsOut/dpsIn on each tick
  // with that pilot's per-engagement values so the charts reflect the filter.
  // All other series (logi, cap, mining) are not per-pilot and stay unchanged.
  const filteredTicks = useMemo(() => {
    if (!selectedPilot) return ticks;
    return ticks.map((t) => {
      const p = t.byPilot.find((r) => r.name === selectedPilot);
      return { ...t, dpsOut: p?.dpsOut ?? 0, dpsIn: p?.dpsIn ?? 0 };
    });
  }, [ticks, selectedPilot]);

  const filteredLatest = filteredTicks[filteredTicks.length - 1];

  // byPilot rows scoped to the selection (all rows when unfiltered).
  const pilotRows = selectedPilot
    ? (latest?.byPilot.filter((p) => p.name === selectedPilot) ?? [])
    : (latest?.byPilot ?? []);

  // Mining overview: session total + a normalized rate series over the last
  // MINING_BARS intervals ending at the newest tick. Mining lasers deliver ore
  // in cycle-sized chunks (a strip miner books ~1000 m³ every ~60 s), so the
  // raw per-interval volumes are spiky; each point is instead a trailing
  // average over MINING_SMOOTH_SECS of buckets — chunky input, steady line.
  // The in-progress interval is divided by its elapsed time (not the full
  // step) so the line doesn't droop at the right edge while a bucket fills.
  // Recomputed per tick (`latest` changes) — the buckets live in a ref, so
  // `latest` is the reactive trigger here.
  const { miningPoints, miningTotal } = useMemo(() => {
    const buckets = miningRef.current.buckets;
    let miningTotal = 0;
    for (const v of buckets.values()) miningTotal += v;
    if (miningTotal <= 0 || !latest) {
      return {
        miningPoints: [] as { age: number; rate: number }[],
        miningTotal,
      };
    }
    const step = miningInterval;
    const end = Math.floor(latest.at / step) * step;
    // Raw m³ per interval (30 s = two 15 s buckets merged).
    const raw = Array.from({ length: MINING_BARS }, (_, i) => {
      const t0 = end - (MINING_BARS - 1 - i) * step;
      let m3 = buckets.get(t0) ?? 0;
      if (step === 30) m3 += buckets.get(t0 + MINING_BUCKET_SECS) ?? 0;
      return m3;
    });
    const elapsedCur = Math.max(latest.at - end, 1);
    const span = Math.max(1, Math.round(MINING_SMOOTH_SECS / step));
    const miningPoints = raw.map((_, i) => {
      const j0 = Math.max(0, i - span + 1);
      let m3 = 0;
      for (let j = j0; j <= i; j++) m3 += raw[j];
      // Seconds actually covered: full steps for closed intervals, elapsed
      // time for the still-filling newest one.
      const secs =
        (i - j0) * step + (i === MINING_BARS - 1 ? elapsedCur : step);
      return { age: (MINING_BARS - 1 - i) * step, rate: m3 / secs };
    });
    return { miningPoints, miningTotal };
  }, [latest, miningInterval]);

  return (
    <Page>
      <PageHeader
        title="DPS Meter"
        subtitle="Live combat readout from your EVE gamelog — damage, logistics and capacitor warfare as a moving average. Reads only the logs the client writes (EULA-safe)."
      />

      {/* Mode tabs */}
      <div className="mt-5 flex gap-1 border-b border-zinc-800">
        {(["live", "playback"] as Mode[]).map((m) => (
          <button
            key={m}
            onClick={() => switchMode(m)}
            disabled={running}
            className={`px-3 py-1.5 text-sm capitalize disabled:opacity-50 ${
              mode === m
                ? "border-b-2 border-indigo-500 text-zinc-100"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {m}
          </button>
        ))}
      </div>

      {/* Controls */}
      <div className="mt-4 flex flex-wrap items-end gap-3">
        <label className="flex-1 min-w-[20rem]">
          <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-500">
            Gamelogs folder
          </span>
          <input
            value={dir}
            onChange={(e) => setDir(e.currentTarget.value)}
            onBlur={() => mode === "playback" && refreshLogs()}
            placeholder="…/EVE/logs/Gamelogs"
            className="w-full rounded bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
          />
        </label>
        <label>
          <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-500">
            Window (s)
          </span>
          <input
            type="number"
            min={1}
            max={600}
            value={windowSecs}
            onChange={(e) =>
              setWindowSecs(Math.max(1, Number(e.currentTarget.value)))
            }
            className="w-24 rounded bg-zinc-800 px-2 py-1.5 text-sm tabular-nums text-zinc-100 outline-none"
          />
        </label>

        {mode === "playback" && (
          <>
            <LogFilePicker logs={logs} file={file} onPick={setFile} />
            <label>
              <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-500">
                Speed ×
              </span>
              <input
                type="number"
                min={0.1}
                max={100}
                step={0.5}
                value={speed}
                onChange={(e) =>
                  setSpeed(Math.max(0.1, Number(e.currentTarget.value)))
                }
                className="w-20 rounded bg-zinc-800 px-2 py-1.5 text-sm tabular-nums text-zinc-100 outline-none"
              />
            </label>
          </>
        )}

        {running ? (
          <button
            onClick={stop}
            className="flex items-center gap-1.5 rounded bg-rose-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-rose-500"
          >
            <Square size={14} /> Stop
          </button>
        ) : (
          <button
            onClick={() => (mode === "live" ? start() : playback())}
            disabled={mode === "live" ? !dir.trim() : !file}
            className="flex items-center gap-1.5 rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            <Play size={14} /> {mode === "live" ? "Start" : "Play"}
          </button>
        )}
      </div>

      {mode === "playback" && summary && (
        <PlaybackTimeline
          summary={summary}
          position={latest?.at ?? null}
          onSeek={(ts) => void playback(ts)}
        />
      )}

      {error && <p className="mt-3 text-sm text-rose-400">{error}</p>}

      {/* Readouts */}
      <div className="mt-6 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {SERIES.map((s) => (
          <div
            key={s.key}
            className={`rounded border border-zinc-800 bg-zinc-900/40 p-3 ${
              s.primary ? "col-span-1" : ""
            }`}
          >
            <div className="flex items-center gap-1.5 text-xs text-zinc-400">
              <span
                className="inline-block h-2.5 w-2.5 rounded-sm"
                style={{ background: s.color }}
              />
              {s.label}
            </div>
            <div
              className={`mt-1 tabular-nums ${
                s.primary ? "text-3xl font-semibold" : "text-xl"
              }`}
              style={{ color: s.color }}
            >
              {filteredLatest
                ? formatInt(Math.round(filteredLatest[s.key]))
                : "—"}
            </div>
            {s.key === "dpsOut" && (
              <PrimaryExtras
                peak={peaksRef.current.out}
                quality={latest?.hitsOut}
              />
            )}
            {s.key === "dpsIn" && (
              <PrimaryExtras
                peak={peaksRef.current.in}
                quality={latest?.hitsIn}
              />
            )}
          </div>
        ))}
      </div>

      {/* Pilot filter — buttons appear once any combat is seen; click to
          scope the charts + primary readouts to that engagement */}
      {knownPilots.length > 0 && (
        <div className="mt-4 flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-zinc-500">Filter:</span>
          <button
            onClick={() => setSelectedPilot(null)}
            className={`rounded px-2 py-0.5 text-xs font-medium transition-colors ${
              selectedPilot === null
                ? "bg-zinc-600 text-zinc-100"
                : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
            }`}
          >
            All
          </button>
          {knownPilots.map((name) => (
            <button
              key={name}
              onClick={() =>
                setSelectedPilot(selectedPilot === name ? null : name)
              }
              className={`flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-medium transition-colors ${
                selectedPilot === name
                  ? "bg-indigo-600 text-white"
                  : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
              }`}
            >
              <span
                aria-hidden
                className="inline-block h-2 w-2 rounded-full"
                style={{ background: sourceColors.get(name) }}
              />
              {name}
            </button>
          ))}
        </div>
      )}

      {/* Graphs — outgoing and incoming; layout + breakdown toggles */}
      <div className="mt-6 flex items-center justify-end gap-2">
        <div className="flex overflow-hidden rounded border border-zinc-800 text-xs">
          {(
            [
              { value: false, label: "Totals" },
              { value: true, label: "By source" },
            ] as const
          ).map(({ value, label }) => (
            <button
              key={label}
              onClick={() => setBySource(value)}
              aria-pressed={bySource === value}
              className={`px-2 py-1 ${
                bySource === value
                  ? "bg-zinc-700 text-zinc-100"
                  : "bg-zinc-900 text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex overflow-hidden rounded border border-zinc-800">
          {(
            [
              { value: "side", label: "Side by side", Icon: Columns2 },
              { value: "stacked", label: "Stacked", Icon: Rows2 },
            ] as const
          ).map(({ value, label, Icon }) => (
            <button
              key={value}
              onClick={() => setChartLayout(value)}
              title={label}
              aria-label={label}
              aria-pressed={chartLayout === value}
              className={`p-1.5 ${
                chartLayout === value
                  ? "bg-zinc-700 text-zinc-100"
                  : "bg-zinc-900 text-zinc-500 hover:text-zinc-300"
              }`}
            >
              <Icon size={14} />
            </button>
          ))}
        </div>
      </div>
      <div
        className={`mt-2 grid gap-4 ${
          chartLayout === "side" ? "md:grid-cols-2" : "grid-cols-1"
        }`}
      >
        <DpsChart ticks={filteredTicks} series={outSeries} title="Outgoing" />
        <DpsChart ticks={filteredTicks} series={inSeries} title="Incoming" />
      </div>

      {/* Mining overview — only once this session has actually mined. History
          is bucketed into 15/30 s intervals, independent of the chart buffer. */}
      {miningTotal > 0 && (
        <MiningPanel
          points={miningPoints}
          total={miningTotal}
          rate={latest?.miningM3 ?? 0}
          intervalSecs={miningInterval}
          onSetInterval={setMiningInterval}
        />
      )}

      {/* Breakdowns: weapons you used · targets you shot · attackers on you */}
      {latest && (latest.byWeapon.length > 0 || latest.byPilot.length > 0) && (
        <div className="mt-6 grid gap-4 md:grid-cols-2 lg:grid-cols-3">
          <WeaponTable rows={latest.byWeapon} />
          <TargetsTable rows={pilotRows} colors={sourceColors} />
          <AttackersTable rows={pilotRows} colors={sourceColors} />
        </div>
      )}

      {!running && ticks.length === 0 && (
        <p className="mt-4 text-sm text-zinc-500">
          Point this at your <code>Gamelogs</code> folder and press Start. Only
          combat logged after you start is counted.
        </p>
      )}
    </Page>
  );
}

/** Top weapons by outgoing DPS. Memoized: skips re-render when `rows` is
 *  unchanged (e.g. the page re-renders for an unrelated control change). */
const WeaponTable = memo(function WeaponTable({
  rows,
}: {
  rows: WeaponRate[];
}) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="mb-2 text-xs uppercase tracking-wide text-zinc-500">
        Damage by weapon
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-zinc-500">
          No outgoing damage in the window.
        </p>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className="border-t border-zinc-800/60">
                <td className="py-1 pr-2 text-zinc-200">{r.name}</td>
                <td className="py-1 text-right tabular-nums text-emerald-400">
                  {formatInt(Math.round(r.dps))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
});

/** Enemies you are shooting — ranked by outgoing DPS. Row dots carry the
 *  per-source colour used by the by-source charts and filter chips. */
const TargetsTable = memo(function TargetsTable({
  rows,
  colors,
}: {
  rows: PilotRate[];
  colors: Map<string, string>;
}) {
  const sorted = [...rows]
    .filter((r) => r.dpsOut > 0)
    .sort((a, b) => b.dpsOut - a.dpsOut);
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="mb-2 text-xs uppercase tracking-wide text-zinc-500">
        Targets (dealt)
      </div>
      {sorted.length === 0 ? (
        <p className="text-xs text-zinc-500">
          No outgoing damage in the window.
        </p>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {sorted.map((r) => (
              <tr key={r.name} className="border-t border-zinc-800/60">
                <td className="py-1 pr-2 text-zinc-200">
                  <span className="flex items-center gap-1.5">
                    <span
                      aria-hidden
                      className="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ background: colors.get(r.name) }}
                    />
                    {r.name}
                  </span>
                </td>
                <td className="py-1 text-right tabular-nums text-emerald-400">
                  {formatInt(Math.round(r.dpsOut))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
});

/** Enemies attacking you — ranked by incoming DPS. Row dots carry the
 *  per-source colour used by the by-source charts and filter chips. */
const AttackersTable = memo(function AttackersTable({
  rows,
  colors,
}: {
  rows: PilotRate[];
  colors: Map<string, string>;
}) {
  const sorted = [...rows]
    .filter((r) => r.dpsIn > 0)
    .sort((a, b) => b.dpsIn - a.dpsIn);
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="mb-2 text-xs uppercase tracking-wide text-zinc-500">
        Attackers (taken)
      </div>
      {sorted.length === 0 ? (
        <p className="text-xs text-zinc-500">
          No incoming damage in the window.
        </p>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {sorted.map((r) => (
              <tr key={r.name} className="border-t border-zinc-800/60">
                <td className="py-1 pr-2 text-zinc-200">
                  <span className="flex items-center gap-1.5">
                    <span
                      aria-hidden
                      className="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ background: colors.get(r.name) }}
                    />
                    {r.name}
                  </span>
                </td>
                <td className="py-1 text-right tabular-nums text-rose-400">
                  {formatInt(Math.round(r.dpsIn))}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
});

/** Mining overview: session total, current live rate, and a normalized rate
 *  line (m³/s, newest right). Each point is a trailing MINING_SMOOTH_SECS
 *  average so laser-cycle chunks flatten into the sustained yield. Shown only
 *  once the session has mined anything. */
function MiningPanel({
  points,
  total,
  rate,
  intervalSecs,
  onSetInterval,
}: {
  points: { age: number; rate: number }[];
  total: number;
  rate: number;
  intervalSecs: 15 | 30;
  onSetInterval: (s: 15 | 30) => void;
}) {
  const w = 960;
  const h = 90;
  const pad = 4;
  const max = Math.max(1e-9, ...points.map((p) => p.rate));
  const x = (i: number) =>
    pad + (i / Math.max(points.length - 1, 1)) * (w - 2 * pad);
  const y = (v: number) => pad + (1 - v / max) * (h - 2 * pad);
  const line = points
    .map((p, i) => `${x(i).toFixed(1)},${y(p.rate).toFixed(1)}`)
    .join(" ");
  // Close the polyline down to the baseline for a soft area fill.
  const area = `${pad},${h - pad} ${line} ${w - pad},${h - pad}`;
  return (
    <div className="mt-4 rounded border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1">
        <span className="flex items-center gap-1.5 text-xs uppercase tracking-wide text-zinc-500">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-amber-300" />
          Mining
        </span>
        <span className="text-xs text-zinc-400">
          rate{" "}
          <span className="tabular-nums text-amber-300">
            {rate.toFixed(1)} m³/s
          </span>
        </span>
        <span className="text-xs text-zinc-400">
          session{" "}
          <span className="tabular-nums text-amber-300">
            {formatInt(Math.round(total))} m³
          </span>
        </span>
        <span className="text-xs text-zinc-400">
          peak{" "}
          <span className="tabular-nums text-amber-300">
            {max.toFixed(1)} m³/s
          </span>
        </span>
        <div className="ml-auto flex overflow-hidden rounded border border-zinc-800 text-xs">
          {([15, 30] as const).map((s) => (
            <button
              key={s}
              onClick={() => onSetInterval(s)}
              aria-pressed={intervalSecs === s}
              className={`px-2 py-0.5 ${
                intervalSecs === s
                  ? "bg-zinc-700 text-zinc-100"
                  : "bg-zinc-900 text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {s}s
            </button>
          ))}
        </div>
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height: h }}
      >
        <line
          x1={pad}
          x2={w - pad}
          y1={h - pad}
          y2={h - pad}
          stroke="#27272a"
          strokeWidth="0.75"
        />
        {points.length > 1 && (
          <>
            <polygon points={area} fill="#fcd34d" fillOpacity="0.08" />
            <polyline
              points={line}
              fill="none"
              stroke="#fcd34d"
              strokeWidth="1.75"
            />
          </>
        )}
      </svg>
      <div className="mt-1 flex justify-between text-[10px] tabular-nums text-zinc-500">
        <span>-{points.length * intervalSecs}s</span>
        <span>now</span>
      </div>
    </div>
  );
}

/** Session peak + hit-quality indicators under a primary DPS readout.
 *  "pen"/"smash"/"wreck" count the high-quality hits inside the rolling
 *  window (from the gamelog's hit-quality suffix); dim when zero. */
function PrimaryExtras({
  peak,
  quality,
}: {
  peak: number;
  quality?: HitQuality;
}) {
  const q = quality ?? { penetrates: 0, smashes: 0, wrecks: 0 };
  const chip = (n: number, cls: string) => (n > 0 ? cls : "text-zinc-600");
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2.5 text-[11px] tabular-nums">
      <span className="text-zinc-500" title="Session peak">
        max {formatInt(Math.round(peak))}
      </span>
      <span
        className={chip(q.penetrates, "text-amber-400")}
        title="Penetrating hits in the window"
      >
        pen {q.penetrates}
      </span>
      <span
        className={chip(q.smashes, "text-orange-400")}
        title="Smashing hits in the window"
      >
        smash {q.smashes}
      </span>
      <span
        className={chip(q.wrecks, "text-fuchsia-400 font-semibold")}
        title="Wrecking hits in the window"
      >
        wreck {q.wrecks}
      </span>
    </div>
  );
}

/** Multi-line rolling chart, inline SVG. `series` selects which lines to draw.
 *  Y-axis labels on both sides scale with the live peak so you can read
 *  absolute values without hovering. Memoized — only a new `ticks` array or a
 *  different `series` reference re-runs the path math. */
const DpsChart = memo(function DpsChart({
  ticks,
  series: activeSeries,
  title,
}: {
  ticks: DpsTick[];
  series: readonly ChartSeries[];
  title?: string;
}) {
  const w = 960;
  const h = 280;
  const padX = 8;
  const padY = 10;
  const padB = 24; // room for the time labels along the bottom

  const { max, lines, grid, n, timeMarks, windowSecs } = useMemo(() => {
    const n = ticks.length;
    const max = Math.max(
      1,
      ...ticks.flatMap((t) => activeSeries.map((s) => s.get(t))),
    );
    const x = (i: number) => padX + (i / Math.max(n - 1, 1)) * (w - 2 * padX);
    const y = (v: number) => padY + (1 - v / max) * (h - padY - padB);
    const lines = activeSeries.map((s) => ({
      key: s.id,
      color: s.color,
      primary: s.primary,
      points: ticks
        .map((t, i) => `${x(i).toFixed(1)},${y(s.get(t)).toFixed(1)}`)
        .join(" "),
    }));
    const grid = [0, 0.25, 0.5, 0.75, 1].map(
      (f) => padY + f * (h - padY - padB),
    );

    // Vertical time markers, one per rolling window (coarsened to ≤ 8 labels).
    const windowSecs = ticks[n - 1]?.windowSecs ?? 0;
    const timeMarks: { x: number; label: string }[] = [];
    if (n > 1 && windowSecs > 0) {
      const t0 = ticks[0].at;
      const tN = ticks[n - 1].at;
      const span = Math.max(1, tN - t0);
      const step = windowSecs * Math.max(1, Math.ceil(span / (windowSecs * 8)));
      const xAt = (t: number) => padX + ((t - t0) / span) * (w - 2 * padX);
      for (let back = 0; back <= span; back += step) {
        timeMarks.push({
          x: xAt(tN - back),
          label: back === 0 ? "now" : `-${back}s`,
        });
      }
    }
    return { max, lines, grid, n, timeMarks, windowSecs };
  }, [ticks, activeSeries]);

  // Y-axis labels: top→bottom = max → 0. Five labels aligned to the grid lines.
  // Rendered in CSS divs (not SVG text) so they stay legible regardless of how
  // narrow the chart is (SVG text scales with the viewBox when preserveAspectRatio
  // is "none", which would make them tiny in the split-chart layout).
  const yLabels = [1, 0.75, 0.5, 0.25, 0].map((f) =>
    formatInt(Math.round(max * f)),
  );
  const yAxisStyle = { height: h, paddingTop: padY, paddingBottom: padB };

  return (
    <div className="rounded border border-zinc-800 bg-zinc-900 p-2">
      <div className="mb-1 flex items-center justify-between text-xs text-zinc-400">
        <span>
          {title ?? "Rolling rate"} (per second)
          {windowSecs > 0 ? ` · ${windowSecs}s window` : ""}
        </span>
        <span className="tabular-nums text-zinc-300">
          peak {formatInt(Math.round(max))}
        </span>
      </div>
      <div className="flex items-stretch">
        {/* Left Y-axis */}
        <div
          className="flex shrink-0 flex-col justify-between pr-1 text-right text-[10px] tabular-nums text-zinc-500"
          style={yAxisStyle}
        >
          {yLabels.map((lbl, i) => (
            <span key={i}>{lbl}</span>
          ))}
        </div>
        <svg
          viewBox={`0 0 ${w} ${h}`}
          preserveAspectRatio="none"
          className="min-w-0 flex-1"
          style={{ height: h }}
        >
          {grid.map((gy, i) => (
            <line
              key={i}
              x1={padX}
              x2={w - padX}
              y1={gy}
              y2={gy}
              stroke="#27272a"
              strokeWidth="0.75"
            />
          ))}
          {timeMarks.map((m, i) => (
            <g key={`t${i}`}>
              <line
                x1={m.x}
                x2={m.x}
                y1={padY}
                y2={h - padB}
                stroke="#27272a"
                strokeWidth="0.75"
              />
              <text
                x={m.x}
                y={h - 8}
                textAnchor={i === 0 ? "end" : "middle"}
                fill="#71717a"
                fontSize="11"
              >
                {m.label}
              </text>
            </g>
          ))}
          {n > 1 &&
            lines.map((l) => (
              <polyline
                key={l.key}
                points={l.points}
                fill="none"
                stroke={l.color}
                strokeWidth={l.primary ? 1.75 : 1}
                strokeOpacity={l.primary ? 1 : 0.7}
              />
            ))}
        </svg>
        {/* Right Y-axis */}
        <div
          className="flex shrink-0 flex-col justify-between pl-1 text-left text-[10px] tabular-nums text-zinc-500"
          style={yAxisStyle}
        >
          {yLabels.map((lbl, i) => (
            <span key={i}>{lbl}</span>
          ))}
        </div>
      </div>
    </div>
  );
});
