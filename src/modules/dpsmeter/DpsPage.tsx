import {
  memo,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { Page, PageHeader } from "../../components/page";
import {
  ChevronsLeftRight,
  Columns2,
  Layers,
  Pause,
  Play,
  Repeat,
  Rows2,
  Square,
  ZoomOut,
} from "lucide-react";
import { ModuleActiveContext } from "../../components/moduleActiveContext";
import {
  dpsListLogs,
  dpsLogSummary,
  dpsPause,
  dpsPlayback,
  dpsResume,
  dpsStart,
  dpsStop,
  errorMessage,
  onDpsDone,
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

/** Readout formatting: keep one decimal under 100 (so small logi/cap/mining
 *  rates aren't lost to rounding — a 4.6 rep/s no longer reads as "5"), plain
 *  thousands-separated integer above. */
function formatRate(v: number): string {
  if (v <= 0) return "0";
  return v < 100 ? v.toFixed(1) : formatInt(Math.round(v));
}

/** How the two damage series are laid out: two panels side by side, two
 *  panels stacked vertically, or both overlaid in one combined panel. */
type ChartLayout = "side" | "stacked" | "combined";

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

/** Playback overview (#dps-timeline): a density strip over the log's time
 *  span — three thin rows (dealt / taken / mined), each bucket scaled to its
 *  own category's busiest moment. Two independent gestures:
 *   - the slider underneath seeks (sets the play position); releasing
 *     restarts playback from there with the window pre-warmed;
 *   - dragging across the strip selects a fight region: the strip + slider
 *     re-scope to it and playback loops within it (see the Loop button).
 *     Reset clears the region. The strip itself no longer seeks. */
function PlaybackTimeline({
  summary,
  position,
  region,
  onSeek,
  onSelectRegion,
  onClearRegion,
}: {
  summary: DpsLogSummary;
  position: number | null;
  region: { start: number; end: number } | null;
  onSeek: (ts: number) => void;
  onSelectRegion: (start: number, end: number) => void;
  onClearRegion: () => void;
}) {
  const [preview, setPreview] = useState<number | null>(null);

  const w = 960;
  const h = 36;
  const rowH = h / 3;

  const fullStart = summary.start;
  const fullEnd = summary.end;
  const fullSpan = Math.max(1, fullEnd - fullStart);
  const n = summary.buckets.length;

  // Displayed window = the selected region, else the whole log.
  const start = region?.start ?? fullStart;
  const end = region?.end ?? fullEnd;
  const span = Math.max(1, end - start);

  // Slice the density strip to the displayed window (buckets are evenly
  // spaced over the full span). Display-only; the region bounds stay exact.
  const buckets = useMemo(() => {
    if (!region) return summary.buckets;
    const i0 = Math.max(0, Math.floor(((start - fullStart) / fullSpan) * n));
    const i1 = Math.min(n, Math.ceil(((end - fullStart) / fullSpan) * n));
    const shown = summary.buckets.slice(i0, Math.max(i0 + 1, i1));
    return shown.length > 0 ? shown : summary.buckets;
  }, [region, summary.buckets, start, end, fullStart, fullSpan, n]);

  const value = preview ?? position ?? start;
  const barW = w / Math.max(1, buckets.length);

  const svgRef = useRef<SVGSVGElement | null>(null);
  const { drag, handlers } = useDragZoom(svgRef, w, (f0, f1) =>
    onSelectRegion(
      Math.round(start + f0 * span),
      Math.round(start + f1 * span),
    ),
  );

  return (
    <div className="mt-4 rounded border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="mb-1 flex items-center justify-between text-[11px] tabular-nums text-zinc-500">
        <span>{formatClock(start)}</span>
        <span className="flex items-center gap-3 normal-case tracking-normal text-zinc-400">
          <TimelineLegend color={TIMELINE_COLORS.damageOut} label="dmg out" />
          <TimelineLegend color={TIMELINE_COLORS.damageIn} label="dmg in" />
          <TimelineLegend color={TIMELINE_COLORS.mining} label="mining" />
          {region ? (
            <>
              <button
                onClick={() =>
                  onSelectRegion(
                    Math.max(fullStart, region.start - 10),
                    Math.min(fullEnd, region.end + 10),
                  )
                }
                disabled={region.start <= fullStart && region.end >= fullEnd}
                title="Widen the selection by 10s on each side"
                className="flex items-center gap-1 rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-zinc-800 disabled:hover:text-zinc-400"
              >
                <ChevronsLeftRight size={11} /> +10s
              </button>
              <button
                onClick={onClearRegion}
                className="flex items-center gap-1 rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
              >
                <ZoomOut size={11} /> reset
              </button>
            </>
          ) : (
            <span className="italic text-zinc-600">drag to select a fight</span>
          )}
        </span>
        <span>{formatClock(end)}</span>
      </div>
      <svg
        ref={svgRef}
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        className="w-full cursor-crosshair touch-none"
        style={{ height: h }}
        {...handlers}
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
        {drag && (
          <rect
            x={Math.min(drag.x0, drag.x1)}
            y={0}
            width={Math.max(0, Math.abs(drag.x1 - drag.x0))}
            height={h}
            fill="rgba(99,102,241,0.18)"
            stroke="rgba(99,102,241,0.5)"
            strokeWidth="1"
            pointerEvents="none"
          />
        )}
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
        aria-label="Playback position"
        min={start}
        max={end}
        step={1}
        value={Math.min(Math.max(value, start), end)}
        onChange={(e) => setPreview(Number(e.currentTarget.value))}
        onMouseUp={(e) => {
          onSeek(Number(e.currentTarget.value));
          setPreview(null);
        }}
        onTouchEnd={(e) => {
          onSeek(Number(e.currentTarget.value));
          setPreview(null);
        }}
        className="mt-1 w-full cursor-pointer accent-zinc-300"
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
  // Playback: paused state + saved position for resume; looping restarts
  // playback automatically when it ends naturally.
  const [paused, setPaused] = useState(false);
  const pausedAtRef = useRef<number | null>(null);
  const [looping, setLooping] = usePersistentState<boolean>(
    STORAGE_KEYS.dpsLooping,
    false,
  );
  // Selected fight region (playback bounds + overview zoom); null = whole log.
  const [region, setRegion] = useState<{ start: number; end: number } | null>(
    null,
  );
  // Scrubber cursor: where a slider seek parked the playhead while stopped
  // (seeking no longer autoplays). Cleared once playback takes over.
  const [seekPos, setSeekPos] = useState<number | null>(null);

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

  // Stable ref for loop: always holds the current playback params so the
  // done-handler can restart without capturing stale closure values.
  const loopParamsRef = useRef({ file, speed, windowSecs, looping, region });
  loopParamsRef.current = { file, speed, windowSecs, looping, region };

  // When playback ends naturally, mark as stopped and auto-loop if enabled.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onDpsDone(() => {
      setRunning(false);
      const p = loopParamsRef.current;
      if (!p.looping) return;
      // Small pause so the final tick renders before the restart clears ticks.
      setTimeout(() => {
        setTicks([]);
        peaksRef.current = { out: 0, in: 0 };
        miningRef.current = { buckets: new Map(), lastAt: null };
        setSelectedPilot(null);
        setPaused(false);
        void dpsPlayback({
          file: p.file,
          speed: p.speed,
          windowSecs: p.windowSecs,
          // Loop within the selected fight region if one is set, else replay
          // the whole log. Both bounds are i64 in Rust — round them.
          seekTs: p.region ? Math.round(p.region.start) : undefined,
          stopTs: p.region ? Math.round(p.region.end) : undefined,
        })
          .then(() => setRunning(true))
          .catch((e) => setError(errorMessage(e)));
      }, 350);
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

  async function start(win = windowSecs) {
    setError(null);
    persistDir();
    localStorage.setItem(STORAGE_KEYS.dpsWindowSecs, String(win));
    peaksRef.current = { out: 0, in: 0 };
    miningRef.current = { buckets: new Map(), lastAt: null };
    setSelectedPilot(null);
    setPaused(false);
    setRegion(null);
    setSeekPos(null);
    pausedAtRef.current = null;
    try {
      await dpsStart({ gamelogsDir: dir, windowSecs: win });
      setRunning(true);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  async function stop() {
    // Remember where playback stopped so Play / Space resumes there instead of
    // restarting from the beginning (live capture has no position to resume).
    if (mode === "playback" && latest) {
      pausedAtRef.current = latest.at;
      setSeekPos(latest.at);
    }
    await dpsStop();
    setRunning(false);
    setPaused(false);
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

  /** Replay the log. `seekTs` starts the virtual clock mid-file (the backend
   *  pre-warms the window so the readout isn't cold); `stopTs` ends playback
   *  at a fight region's boundary; `win` overrides the averaging window so a
   *  live window change can restart cleanly. */
  async function playback(seekTs?: number, stopTs?: number, win = windowSecs) {
    setError(null);
    setTicks([]);
    peaksRef.current = { out: 0, in: 0 };
    miningRef.current = { buckets: new Map(), lastAt: null };
    setSelectedPilot(null);
    setPaused(false);
    setSeekPos(null);
    try {
      await dpsPlayback({
        file,
        speed,
        windowSecs: win,
        // Both bounds are i64 in Rust — the region/scrubber emit fractional
        // timestamps, so round before crossing the bridge.
        seekTs: seekTs == null ? undefined : Math.round(seekTs),
        stopTs: stopTs == null ? undefined : Math.round(stopTs),
      });
      setRunning(true);
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  /** Play the current context: the selected fight region, else the whole log
   *  (resuming from a parked scrubber cursor if there is one). */
  function playCurrent() {
    const from = seekPos ?? pausedAtRef.current ?? region?.start;
    void playback(from ?? undefined, region?.end);
  }

  /** Drag-select a fight on the overview: zoom to it and play (loop, if on)
   *  within it. */
  function selectRegion(regionStart: number, regionEnd: number) {
    setRegion({ start: regionStart, end: regionEnd });
    void playback(regionStart, regionEnd);
  }

  /** Clear the region — overview back to the whole log. */
  function clearRegion() {
    setRegion(null);
  }

  /** Scrub to a time WITHOUT starting playback — stop the loop (if any) and
   *  park the playhead so Play (or Space) starts from there. Not a frozen
   *  pause: the loop is torn down, so this shows Play, not Resume. */
  function seekTo(ts: number) {
    setSeekPos(ts);
    pausedAtRef.current = ts;
    if (running) {
      void dpsStop();
      setRunning(false);
    }
    setPaused(false);
  }

  /** Change the moving-average window. Applies live by restarting the current
   *  capture/playback (the window is baked into the backend loop). */
  function setWindow(win: number) {
    setWindowSecs(win);
    localStorage.setItem(STORAGE_KEYS.dpsWindowSecs, String(win));
    if (!running) return;
    if (mode === "live") void start(win);
    else void playback(latest?.at ?? region?.start, region?.end, win);
  }

  /** True pause: freeze the backend loop in place (the graph + window are kept
   *  intact). Resume continues from the exact same point — no re-seek, so the
   *  DPS doesn't jump. */
  async function pause() {
    pausedAtRef.current = latest?.at ?? null;
    setPaused(true);
    try {
      await dpsPause();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  /** Continue a paused replay exactly where it froze. */
  async function resume() {
    setPaused(false);
    try {
      await dpsResume();
    } catch (e) {
      setError(errorMessage(e));
    }
  }

  /** Space-bar transport: resume if paused, else pause (playback) / stop
   *  (live) if running, else start (live) / play the current context. `paused`
   *  is checked first because a true-paused loop is still "running". */
  function toggleTransport() {
    if (paused) {
      void resume();
    } else if (running) {
      if (mode === "live") void stop();
      else void pause();
    } else if (mode === "live") {
      if (dir.trim()) void start();
    } else if (file) {
      playCurrent();
    }
  }
  // Keep a live ref so the once-registered key listener never goes stale.
  const toggleTransportRef = useRef(toggleTransport);
  toggleTransportRef.current = toggleTransport;

  // Space toggles start/stop while the meter is the visible module and focus
  // isn't in a text field (so typing a folder path still inserts spaces).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" && e.key !== " ") return;
      if (!activeRef.current) return;
      const el = document.activeElement as HTMLElement | null;
      const tag = el?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        el?.isContentEditable
      )
        return;
      e.preventDefault();
      toggleTransportRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Load the selected file's activity summary for the timeline scrubber
  // whenever it changes; cleared outside playback mode or on failure (the
  // timeline just doesn't render — it's a bonus, not required to play).
  useEffect(() => {
    // A new file (or leaving playback) invalidates any selected fight region
    // and the parked resume position.
    setRegion(null);
    setSeekPos(null);
    pausedAtRef.current = null;
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

  // Combined layout: both series in one panel. Suffix the ids so out/in lines
  // never collide on their React key (they share the pilot name in by-source
  // mode), keeping colours as-is (green/red totals, or per-pilot).
  const combinedSeries = useMemo(
    () => [
      ...outSeries.map((s) => ({ ...s, id: `${s.id} out` })),
      ...inSeries.map((s) => ({ ...s, id: `${s.id} in` })),
    ],
    [outSeries, inSeries],
  );

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

  // Tackle status from the newest tick: who is holding you down (scram/point
  // in) and who you are holding (out). Drives the warning banner.
  const tackledBy = latest?.byPilot.filter((p) => p.scramIn || p.pointIn) ?? [];
  const tackling =
    latest?.byPilot.filter((p) => p.scramOut || p.pointOut) ?? [];

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
        <div>
          <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-500">
            Window (s)
          </span>
          <div className="flex overflow-hidden rounded border border-zinc-800 text-sm">
            {([10, 20, 30, 60] as const).map((s) => (
              <button
                key={s}
                onClick={() => setWindow(s)}
                aria-pressed={windowSecs === s}
                className={`px-2.5 py-1.5 tabular-nums ${
                  windowSecs === s
                    ? "bg-zinc-700 text-zinc-100"
                    : "bg-zinc-900 text-zinc-500 hover:text-zinc-300"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>

        {mode === "playback" && (
          <>
            <LogFilePicker logs={logs} file={file} onPick={setFile} />
            <label className="min-w-[9rem]">
              <span className="mb-1 flex items-center justify-between text-xs uppercase tracking-wide text-zinc-500">
                <span>Speed ×</span>
                <span className="tabular-nums text-zinc-300">
                  {speed.toFixed(1)}×
                </span>
              </span>
              <input
                type="range"
                aria-label="Playback speed"
                min={0.1}
                max={10}
                step={0.1}
                value={speed}
                onChange={(e) => setSpeed(Number(e.currentTarget.value))}
                className="mt-2 w-32 accent-emerald-500"
              />
            </label>
          </>
        )}

        {/* Playback-mode transport: Pause (while running), Resume (while
            paused), Stop, and Loop toggle. Live mode shows Start/Stop only. */}
        {mode === "playback" && running && !paused && (
          <button
            onClick={() => void pause()}
            className="flex items-center gap-1.5 rounded bg-amber-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-amber-500"
          >
            <Pause size={14} /> Pause
          </button>
        )}
        {mode === "playback" && paused && (
          <button
            onClick={resume}
            disabled={!file}
            className="flex items-center gap-1.5 rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            <Play size={14} /> Resume
          </button>
        )}
        {running || paused ? (
          <button
            onClick={() => void stop()}
            className="flex items-center gap-1.5 rounded bg-rose-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-rose-500"
          >
            <Square size={14} /> Stop
          </button>
        ) : (
          <button
            onClick={() => (mode === "live" ? void start() : playCurrent())}
            disabled={mode === "live" ? !dir.trim() : !file}
            className="flex items-center gap-1.5 rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            <Play size={14} /> {mode === "live" ? "Start" : "Play"}
          </button>
        )}
        {mode === "playback" && (
          <button
            onClick={() => setLooping(!looping)}
            title={looping ? "Loop: on" : "Loop: off"}
            aria-pressed={looping}
            className={`flex items-center gap-1.5 rounded px-3 py-1.5 text-sm font-medium transition-colors ${
              looping
                ? "bg-indigo-700 text-white hover:bg-indigo-600"
                : "bg-zinc-800 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200"
            }`}
          >
            <Repeat size={14} /> Loop
          </button>
        )}
      </div>

      {mode === "playback" && summary && (
        <PlaybackTimeline
          summary={summary}
          position={seekPos ?? latest?.at ?? null}
          region={region}
          onSeek={seekTo}
          onSelectRegion={selectRegion}
          onClearRegion={clearRegion}
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
              {filteredLatest ? formatRate(filteredLatest[s.key]) : "—"}
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

      {/* Tackle warning — you can't warp out while scrambled/pointed, so
          surface it prominently. Incoming (on you) is a red alarm; outgoing
          (you holding a target) is a calmer confirmation. */}
      {tackledBy.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded border border-rose-500/40 bg-rose-500/10 px-3 py-2 text-sm text-rose-200">
          <span className="font-semibold uppercase tracking-wide text-rose-300">
            Tackled
          </span>
          {tackledBy.map((p) => (
            <span key={p.name} className="flex items-center gap-1">
              {p.name}
              <TackleTags scram={p.scramIn} point={p.pointIn} />
            </span>
          ))}
          <span className="text-xs text-rose-300/70">— you can't warp out</span>
        </div>
      )}
      {tackling.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-zinc-400">
          <span className="font-medium uppercase tracking-wide text-zinc-500">
            Holding
          </span>
          {tackling.map((p) => (
            <span key={p.name} className="flex items-center gap-1">
              {p.name}
              <TackleTags scram={p.scramOut} point={p.pointOut} />
            </span>
          ))}
        </div>
      )}

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

      {/* Graphs — outgoing and incoming; layout + breakdown toggles + zoom */}
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
              {
                value: "combined",
                label: "Combined (one panel)",
                Icon: Layers,
              },
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
        {chartLayout === "combined" ? (
          <DpsChart
            ticks={filteredTicks}
            series={combinedSeries}
            title="Damage — out + in"
          />
        ) : (
          <>
            <DpsChart
              ticks={filteredTicks}
              series={outSeries}
              title="Outgoing"
            />
            <DpsChart
              ticks={filteredTicks}
              series={inSeries}
              title="Incoming"
            />
          </>
        )}
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
                <td className="py-1 pr-2 text-zinc-200">
                  {r.name}
                  {r.kind ? (
                    <span className="text-zinc-500"> · {r.kind}</span>
                  ) : null}
                  {r.damage ? (
                    <span className="text-zinc-600"> [{r.damage}]</span>
                  ) : null}
                </td>
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

/** Hit-quality tiers worst→best, with the colour each segment gets in the
 *  per-combatant distribution bar. Keys match {@link HitQuality}. */
const QUALITY_TIERS = [
  { key: "misses", label: "Miss", color: "#6b7280" },
  { key: "glances", label: "Glance", color: "#94a3b8" },
  { key: "grazes", label: "Graze", color: "#38bdf8" },
  { key: "hits", label: "Hit", color: "#22d3ee" },
  { key: "penetrates", label: "Pen", color: "#34d399" },
  { key: "smashes", label: "Smash", color: "#a3e635" },
  { key: "wrecks", label: "Wreck", color: "#f472b6" },
] as const satisfies readonly {
  key: keyof HitQuality;
  label: string;
  color: string;
}[];

/** Compact stacked bar of a combatant's hit-quality distribution, worst
 *  (left) → best (right), with a labelled legend of the present tiers below
 *  (colour dot + name + count) so the tiers read clearly and aren't mistaken
 *  for damage-type badges. Renders nothing when there were no tracked hits. */
function QualityBar({ q }: { q?: HitQuality }) {
  if (!q) return null;
  const total = QUALITY_TIERS.reduce((s, t) => s + q[t.key], 0);
  if (total === 0) return null;
  const present = QUALITY_TIERS.filter((t) => q[t.key] > 0);
  return (
    <div className="mt-1">
      <span className="flex h-2 w-full overflow-hidden rounded-sm bg-zinc-800">
        {present.map((t) => (
          <span
            key={t.key}
            style={{
              width: `${(q[t.key] / total) * 100}%`,
              background: t.color,
            }}
          />
        ))}
      </span>
      <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] tabular-nums text-zinc-400">
        {present.map((t) => (
          <span key={t.key} className="flex items-center gap-1">
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-[2px]"
              style={{ background: t.color }}
            />
            {t.label} {q[t.key]}
          </span>
        ))}
      </span>
    </div>
  );
}

/** Per-source damage breakdown for a combatant row: one line per weapon/ammo/
 *  drone with its dps, source kind, and (where the SDE knows it) damage type. */
function WeaponLines({ weapons }: { weapons?: WeaponRate[] }) {
  if (!weapons || weapons.length === 0) return null;
  return (
    <div className="mt-0.5 space-y-px">
      {weapons.map((wpn) => (
        <div
          key={wpn.name}
          className="flex items-baseline justify-between gap-2 text-[10px] text-zinc-500"
        >
          <span className="truncate">
            {wpn.name}
            {wpn.kind ? ` · ${wpn.kind}` : ""}
            {wpn.damage ? (
              <span className="text-zinc-600"> [{wpn.damage}]</span>
            ) : null}
          </span>
          <span className="shrink-0 tabular-nums">
            {formatInt(Math.round(wpn.dps))}
          </span>
        </div>
      ))}
    </div>
  );
}

/** Tackle chips for a combatant row: scram (warp scrambler — stops warp and
 *  MWD) and point (warp disruptor) active within the window. Distinct warm
 *  colours so they stand apart from the cool quality ramp. */
function TackleTags({ scram, point }: { scram?: boolean; point?: boolean }) {
  if (!scram && !point) return null;
  return (
    <span className="ml-1 inline-flex gap-1 align-middle">
      {scram ? (
        <span
          className="rounded bg-rose-500/20 px-1 text-[9px] font-semibold uppercase tracking-wide text-rose-300"
          title="Warp scrambler active"
        >
          scram
        </span>
      ) : null}
      {point ? (
        <span
          className="rounded bg-amber-500/20 px-1 text-[9px] font-semibold uppercase tracking-wide text-amber-300"
          title="Warp disruptor (point) active"
        >
          point
        </span>
      ) : null}
    </span>
  );
}

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
                <td className="py-1 pr-2 align-top text-zinc-200">
                  <span className="flex items-center gap-1.5">
                    <span
                      aria-hidden
                      className="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ background: colors.get(r.name) }}
                    />
                    {r.name}
                    <TackleTags scram={r.scramOut} point={r.pointOut} />
                  </span>
                  <WeaponLines weapons={r.weaponsOut} />
                  <QualityBar q={r.qualityOut} />
                </td>
                <td className="py-1 pl-2 text-right align-top tabular-nums text-emerald-400">
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
                <td className="py-1 pr-2 align-top text-zinc-200">
                  <span className="flex items-center gap-1.5">
                    <span
                      aria-hidden
                      className="inline-block h-2 w-2 shrink-0 rounded-full"
                      style={{ background: colors.get(r.name) }}
                    />
                    {r.name}
                    <TackleTags scram={r.scramIn} point={r.pointIn} />
                  </span>
                  <WeaponLines weapons={r.weaponsIn} />
                  <QualityBar q={r.qualityIn} />
                </td>
                <td className="py-1 pl-2 text-right align-top tabular-nums text-rose-400">
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

/** Drag-to-select a horizontal range on the playback overview strip. On
 *  release it reports the selected range as start/end **fractions** (0..1)
 *  across the SVG width via `onSelect` — the caller maps those to log
 *  timestamps against whatever window it's currently showing (so selecting
 *  works precisely, and nests when already zoomed).
 *
 *  Uses Pointer Events with `setPointerCapture`, not mouse events: capture
 *  routes every subsequent `pointermove`/`pointerup` back to the SVG even
 *  when the pointer leaves its bounds, and it behaves identically across
 *  WebKit (Tauri's Linux/macOS webview), Blink and Gecko — unlike the
 *  `document`-level mouse-listener pattern, which WebKitGTK does not track
 *  reliably through a drag that started with `preventDefault`.
 *
 *  Returns the live drag box in viewBox x-coordinates (for the highlight
 *  rect) plus the pointer handlers to spread onto the `<svg>`. */
function useDragZoom(
  svgRef: { current: SVGSVGElement | null },
  w: number,
  onSelect?: (startFrac: number, endFrac: number) => void,
) {
  const [drag, setDrag] = useState<{ x0: number; x1: number } | null>(null);
  const x0Ref = useRef(0);
  const draggingRef = useRef(false);
  const onSelectRef = useRef(onSelect);
  onSelectRef.current = onSelect;

  const toSvgX = (clientX: number) => {
    const svg = svgRef.current;
    if (!svg) return 0;
    const r = svg.getBoundingClientRect();
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width)) * w;
  };

  const handlers = onSelect
    ? {
        onPointerDown: (e: ReactPointerEvent<SVGSVGElement>) => {
          if (e.button !== 0) return; // left button only
          e.currentTarget.setPointerCapture(e.pointerId);
          const x = toSvgX(e.clientX);
          x0Ref.current = x;
          draggingRef.current = true;
          setDrag({ x0: x, x1: x });
          e.preventDefault();
        },
        onPointerMove: (e: ReactPointerEvent<SVGSVGElement>) => {
          if (!draggingRef.current) return;
          setDrag({ x0: x0Ref.current, x1: toSvgX(e.clientX) });
        },
        onPointerUp: (e: ReactPointerEvent<SVGSVGElement>) => {
          if (!draggingRef.current) return;
          draggingRef.current = false;
          const x1 = toSvgX(e.clientX);
          setDrag(null);
          const lo = Math.min(x0Ref.current, x1);
          const hi = Math.max(x0Ref.current, x1);
          // Ignore a click / hair-thin drag (< 1% of width).
          if (hi - lo < w * 0.01) return;
          onSelectRef.current?.(lo / w, hi / w);
        },
        onPointerCancel: () => {
          draggingRef.current = false;
          setDrag(null);
        },
      }
    : undefined;

  return { drag, handlers };
}

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
  // The notable high-end tiers, drawn with the same colours as the QualityBar
  // so quality reads consistently and never like a damage-type badge.
  const notable = QUALITY_TIERS.filter(
    (t) => t.key === "penetrates" || t.key === "smashes" || t.key === "wrecks",
  );
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] tabular-nums">
      <span className="text-zinc-500" title="Session peak">
        max {formatInt(Math.round(peak))}
      </span>
      {notable.map((t) => {
        const n = q[t.key];
        return (
          <span
            key={t.key}
            className={`flex items-center gap-1 ${n > 0 ? "text-zinc-300" : "text-zinc-600"}`}
            title={`${t.label}ing hits in the window`}
          >
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-[2px]"
              style={{ background: n > 0 ? t.color : "#3f3f46" }}
            />
            {t.label} {n}
          </span>
        );
      })}
    </div>
  );
}

/** One hover-tooltip block: a character (with optional ship) and its total for
 *  the moment, then one indented line per damage source (drones, each weapon)
 *  below it. Reused for both the Dealt and Taken sections. */
function HoverPilotRow({
  name,
  ship,
  total,
  weapons,
}: {
  name: string;
  ship?: string;
  total: number;
  weapons?: WeaponRate[];
}) {
  return (
    <div className="mt-0.5">
      <div className="flex justify-between gap-3">
        <span className="max-w-[12rem] truncate text-zinc-300">
          {name}
          {ship ? <span className="text-zinc-500"> ({ship})</span> : null}
        </span>
        <span className="tabular-nums text-zinc-300">
          {formatInt(Math.round(total))}
        </span>
      </div>
      {weapons?.map((wpn) => (
        <div
          key={wpn.name}
          className="flex justify-between gap-3 pl-3 text-zinc-500"
        >
          <span className="max-w-[11rem] truncate">
            {wpn.name}
            {wpn.kind ? (
              <span className="text-zinc-600"> · {wpn.kind}</span>
            ) : null}
            {wpn.damage ? (
              <span className="text-zinc-600"> [{wpn.damage}]</span>
            ) : null}
          </span>
          <span className="tabular-nums">{formatInt(Math.round(wpn.dps))}</span>
        </div>
      ))}
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

  // Hover: tick index under the cursor. The tooltip always shows BOTH
  // directions for that moment (dealt + taken), whatever this chart draws, so
  // e.g. the stacked layout still gives the full picture from one hover.
  const [hover, setHover] = useState<number | null>(null);
  const hoverTick = hover != null ? ticks[hover] : undefined;
  const hoverFrac = hover != null && n > 1 ? hover / (n - 1) : 0;
  const dealt = hoverTick
    ? [...hoverTick.byPilot]
        .filter((p) => p.dpsOut > 0)
        .sort((a, b) => b.dpsOut - a.dpsOut)
        .slice(0, 5)
    : [];
  const taken = hoverTick
    ? [...hoverTick.byPilot]
        .filter((p) => p.dpsIn > 0)
        .sort((a, b) => b.dpsIn - a.dpsIn)
        .slice(0, 5)
    : [];

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
        <div className="relative min-w-0 flex-1">
          <svg
            viewBox={`0 0 ${w} ${h}`}
            preserveAspectRatio="none"
            className={`block w-full ${n > 1 ? "cursor-crosshair" : ""}`}
            style={{ height: h }}
            onPointerMove={
              n > 1
                ? (e) => {
                    const rect = e.currentTarget.getBoundingClientRect();
                    const frac = Math.max(
                      0,
                      Math.min(1, (e.clientX - rect.left) / rect.width),
                    );
                    setHover(Math.round(frac * (n - 1)));
                  }
                : undefined
            }
            onPointerLeave={() => setHover(null)}
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
            {hover != null && n > 1 && (
              <line
                x1={padX + hoverFrac * (w - 2 * padX)}
                x2={padX + hoverFrac * (w - 2 * padX)}
                y1={padY}
                y2={h - padB}
                stroke="#a1a1aa"
                strokeWidth="0.75"
                strokeDasharray="4 3"
              />
            )}
          </svg>
          {hoverTick && (dealt.length > 0 || taken.length > 0) && (
            <div
              className="pointer-events-none absolute top-1 z-10 w-64 -translate-x-1/2 rounded border border-zinc-700 bg-zinc-900/95 px-2 py-1 text-[11px] shadow-lg"
              style={{
                left: `${Math.max(14, Math.min(86, ((padX + hoverFrac * (w - 2 * padX)) / w) * 100))}%`,
              }}
            >
              <div className="mb-0.5 tabular-nums text-zinc-500">
                {formatClock(hoverTick.at)}
              </div>
              {dealt.length > 0 && (
                <>
                  <div className="mt-0.5 flex justify-between font-medium text-emerald-400">
                    <span>Dealt</span>
                    <span className="tabular-nums">
                      {formatInt(Math.round(hoverTick.dpsOut))}
                    </span>
                  </div>
                  {dealt.map((p) => (
                    <HoverPilotRow
                      key={`o-${p.name}`}
                      name={p.name}
                      ship={p.ship}
                      total={p.dpsOut}
                      weapons={p.weaponsOut}
                    />
                  ))}
                </>
              )}
              {taken.length > 0 && (
                <>
                  <div className="mt-1 flex justify-between font-medium text-rose-400">
                    <span>Taken</span>
                    <span className="tabular-nums">
                      {formatInt(Math.round(hoverTick.dpsIn))}
                    </span>
                  </div>
                  {taken.map((p) => (
                    <HoverPilotRow
                      key={`i-${p.name}`}
                      name={p.name}
                      ship={p.ship}
                      total={p.dpsIn}
                      weapons={p.weaponsIn}
                    />
                  ))}
                </>
              )}
            </div>
          )}
        </div>
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
