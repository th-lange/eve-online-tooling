import { memo, useContext, useEffect, useMemo, useRef, useState } from "react";
import { Play, Square } from "lucide-react";
import { ModuleActiveContext } from "../../components/moduleActiveContext";
import {
  dpsListLogs,
  dpsPlayback,
  dpsStart,
  dpsStop,
  eveDefaultLogDir,
  onDpsTick,
  type DpsLogFile,
  type DpsTick,
  type HitQuality,
  type PilotRate,
  type WeaponRate,
} from "../../lib/api";
import { formatInt } from "../../lib/format";
import { STORAGE_KEYS } from "../../lib/storageKeys";

type Mode = "live" | "playback";

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

/** Suggest the Gamelogs folder from a previously-entered Chatlogs path. */
function suggestGamelogs(): string {
  const chat = localStorage.getItem(STORAGE_KEYS.eveChatlogsDir) ?? "";
  return chat ? chat.replace(/Chatlogs\/?$/i, "Gamelogs") : "";
}

/** Append a tick to the rolling buffer, dropping the oldest past `BUFFER`. */
function appendTick(prev: DpsTick[], t: DpsTick): DpsTick[] {
  const next = prev.length >= BUFFER ? prev.slice(1) : prev.slice();
  next.push(t);
  return next;
}

export function DpsPage() {
  const [dir, setDir] = useState(
    () =>
      localStorage.getItem(STORAGE_KEYS.eveGamelogsDir) || suggestGamelogs(),
  );
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

  // Prefill the Gamelogs folder from the OS default when we have nothing yet.
  useEffect(() => {
    if (dir) return;
    eveDefaultLogDir("gamelogs").then((d) => d && setDir(d));
  }, [dir]);

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

  // Subscribe once; the feed survives navigation. Ticks only arrive while a
  // capture is running.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onDpsTick((t) => {
      const peaks = peaksRef.current;
      peaks.out = Math.max(peaks.out, t.dpsOut);
      peaks.in = Math.max(peaks.in, t.dpsIn);
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
    localStorage.setItem(STORAGE_KEYS.eveGamelogsDir, dir);
    localStorage.setItem(STORAGE_KEYS.dpsWindowSecs, String(windowSecs));
    peaksRef.current = { out: 0, in: 0 };
    try {
      await dpsStart({ gamelogsDir: dir, windowSecs });
      setRunning(true);
    } catch (e) {
      setError(String(e));
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
      setError(String(e));
    }
  }

  async function playback() {
    setError(null);
    setTicks([]);
    peaksRef.current = { out: 0, in: 0 };
    try {
      await dpsPlayback({ file, speed, windowSecs });
      setRunning(true);
    } catch (e) {
      setError(String(e));
    }
  }

  function switchMode(m: Mode) {
    setMode(m);
    if (m === "playback") refreshLogs();
  }

  const latest = ticks[ticks.length - 1];

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <h1 className="text-2xl font-semibold text-zinc-100">DPS Meter</h1>
      <p className="mt-1 text-sm text-zinc-400">
        Live combat readout from your EVE gamelog — damage, logistics and
        capacitor warfare as a moving average. Reads only the logs the client
        writes (EULA-safe).
      </p>

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
            <label className="flex-1 min-w-[16rem]">
              <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-500">
                Log file
              </span>
              <select
                value={file}
                onChange={(e) => setFile(e.currentTarget.value)}
                className="w-full rounded bg-zinc-800 px-2 py-1.5 text-sm text-zinc-100 outline-none"
              >
                {logs.length === 0 && <option value="">No logs found</option>}
                {logs.map((l) => (
                  <option key={l.path} value={l.path}>
                    {l.name}
                  </option>
                ))}
              </select>
            </label>
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
            onClick={mode === "live" ? start : playback}
            disabled={mode === "live" ? !dir.trim() : !file}
            className="flex items-center gap-1.5 rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            <Play size={14} /> {mode === "live" ? "Start" : "Play"}
          </button>
        )}
      </div>

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
              {latest ? formatInt(Math.round(latest[s.key])) : "—"}
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

      {/* Mining (only when there's yield — most fits never mine) */}
      {latest && latest.miningM3 > 0 && (
        <div className="mt-3 inline-flex items-center gap-2 rounded border border-zinc-800 bg-zinc-900/40 px-3 py-2">
          <span className="inline-block h-2.5 w-2.5 rounded-sm bg-amber-300" />
          <span className="text-xs text-zinc-400">Mining</span>
          <span className="tabular-nums text-xl text-amber-300">
            {latest.miningM3.toFixed(1)} m³/s
          </span>
        </div>
      )}

      {/* Graph */}
      <div className="mt-6">
        <DpsChart ticks={ticks} />
      </div>

      {/* Breakdowns */}
      {latest && (latest.byWeapon.length > 0 || latest.byPilot.length > 0) && (
        <div className="mt-6 grid gap-4 md:grid-cols-2">
          <WeaponTable rows={latest.byWeapon} />
          <PilotTable rows={latest.byPilot} />
        </div>
      )}

      {!running && ticks.length === 0 && (
        <p className="mt-4 text-sm text-zinc-500">
          Point this at your <code>Gamelogs</code> folder and press Start. Only
          combat logged after you start is counted.
        </p>
      )}
    </div>
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

/** Top counterparties by engaged DPS (dealt vs taken). Memoized like
 *  {@link WeaponTable}. */
const PilotTable = memo(function PilotTable({ rows }: { rows: PilotRate[] }) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="mb-2 flex items-center justify-between text-xs uppercase tracking-wide text-zinc-500">
        <span>By pilot</span>
        <span className="flex gap-3 normal-case">
          <span className="text-emerald-400">dealt</span>
          <span className="text-rose-400">taken</span>
        </span>
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-zinc-500">
          No pilots engaged in the window.
        </p>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className="border-t border-zinc-800/60">
                <td className="py-1 pr-2 text-zinc-200">{r.name}</td>
                <td className="py-1 text-right tabular-nums text-emerald-400">
                  {formatInt(Math.round(r.dpsOut))}
                </td>
                <td className="py-1 pl-3 text-right tabular-nums text-rose-400">
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

/** Multi-line rolling chart, inline SVG (no chart dependency — same approach as
 *  the market history chart). All series share one y-scale so out/in compare.
 *  Memoized + path math in a `useMemo` so unrelated re-renders (typing in a
 *  control) don't rebuild all eight polylines; only a new `ticks` array does. */
const DpsChart = memo(function DpsChart({ ticks }: { ticks: DpsTick[] }) {
  const w = 960;
  const h = 280;
  const padX = 8;
  const padY = 10;
  const padB = 24; // room for the time labels along the bottom

  const { max, lines, grid, n, timeMarks, windowSecs } = useMemo(() => {
    const n = ticks.length;
    const max = Math.max(
      1,
      ...ticks.flatMap((t) => SERIES.map((s) => t[s.key] as number)),
    );
    const x = (i: number) => padX + (i / Math.max(n - 1, 1)) * (w - 2 * padX);
    const y = (v: number) => padY + (1 - v / max) * (h - padY - padB);
    const lines = SERIES.map((s) => ({
      key: s.key,
      points: ticks
        .map((t, i) => `${x(i).toFixed(1)},${y(t[s.key] as number).toFixed(1)}`)
        .join(" "),
    }));
    const grid = [0, 0.25, 0.5, 0.75, 1].map(
      (f) => padY + f * (h - padY - padB),
    );

    // Vertical time segments, one per rolling window (coarsened so at most ~8
    // fit), labelled as seconds back from the newest sample.
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
  }, [ticks]);

  return (
    <div className="rounded border border-zinc-800 bg-zinc-900 p-2">
      <div className="mb-1 flex items-center justify-between text-xs text-zinc-400">
        <span>
          Rolling rate (per second)
          {windowSecs > 0 ? ` · ${windowSecs}s window` : ""}
        </span>
        <span className="tabular-nums text-zinc-300">
          peak {formatInt(Math.round(max))}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        className="w-full"
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
          SERIES.map((s, i) => (
            <polyline
              key={s.key}
              points={lines[i].points}
              fill="none"
              stroke={s.color}
              strokeWidth={s.primary ? 1.75 : 1}
              strokeOpacity={s.primary ? 1 : 0.7}
            />
          ))}
      </svg>
    </div>
  );
});
