import { useEffect, useState } from "react";
import { Play, Square } from "lucide-react";
import {
  dpsStart,
  dpsStop,
  onDpsTick,
  type DpsTick,
  type PilotRate,
  type WeaponRate,
} from "../../lib/api";

// How many ticks to keep on screen (~2 min at the 500 ms backend cadence).
const BUFFER = 240;

// The series we graph + read out. `out` series share warm colours, `in` cool.
const SERIES = [
  { key: "dpsOut", label: "DPS out", color: "#34d399", primary: true },
  { key: "dpsIn", label: "DPS in", color: "#f87171", primary: true },
  { key: "logiOut", label: "Logi out", color: "#38bdf8", primary: false },
  { key: "logiIn", label: "Logi in", color: "#a78bfa", primary: false },
  { key: "capWarfareOut", label: "Cap warfare out", color: "#fbbf24", primary: false },
  { key: "capWarfareIn", label: "Cap warfare in", color: "#fb923c", primary: false },
  { key: "capTransferOut", label: "Cap xfer out", color: "#2dd4bf", primary: false },
  { key: "capTransferIn", label: "Cap xfer in", color: "#c084fc", primary: false },
] as const satisfies readonly {
  key: keyof DpsTick;
  label: string;
  color: string;
  primary: boolean;
}[];

/** Suggest the Gamelogs folder from a previously-entered Chatlogs path. */
function suggestGamelogs(): string {
  const chat = localStorage.getItem("eveLogsDir") ?? "";
  return chat ? chat.replace(/Chatlogs\/?$/i, "Gamelogs") : "";
}

export function DpsPage() {
  const [dir, setDir] = useState(
    () => localStorage.getItem("eveGamelogsDir") || suggestGamelogs(),
  );
  const [windowSecs, setWindowSecs] = useState(() =>
    Number(localStorage.getItem("dps.windowSecs") ?? 10),
  );
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ticks, setTicks] = useState<DpsTick[]>([]);

  // Subscribe once; the page stays mounted (ModuleHost), so the feed survives
  // navigation. Ticks only arrive while a capture is running.
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    onDpsTick((t) =>
      setTicks((prev) => {
        const next = prev.length >= BUFFER ? prev.slice(1) : prev.slice();
        next.push(t);
        return next;
      }),
    ).then((u) => (unlisten = u));
    return () => unlisten?.();
  }, []);

  async function start() {
    setError(null);
    localStorage.setItem("eveGamelogsDir", dir);
    localStorage.setItem("dps.windowSecs", String(windowSecs));
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

  const latest = ticks[ticks.length - 1];

  return (
    <div className="mx-auto max-w-5xl px-6 py-6">
      <h1 className="text-2xl font-semibold text-zinc-100">DPS Meter</h1>
      <p className="mt-1 text-sm text-zinc-400">
        Live combat readout from your EVE gamelog — damage, logistics and
        capacitor warfare as a moving average. Reads only the logs the client
        writes (EULA-safe).
      </p>

      {/* Controls */}
      <div className="mt-5 flex flex-wrap items-end gap-3">
        <label className="flex-1 min-w-[20rem]">
          <span className="mb-1 block text-xs uppercase tracking-wide text-zinc-500">
            Gamelogs folder
          </span>
          <input
            value={dir}
            onChange={(e) => setDir(e.currentTarget.value)}
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
            onChange={(e) => setWindowSecs(Math.max(1, Number(e.currentTarget.value)))}
            className="w-24 rounded bg-zinc-800 px-2 py-1.5 text-sm tabular-nums text-zinc-100 outline-none"
          />
        </label>
        {running ? (
          <button
            onClick={stop}
            className="flex items-center gap-1.5 rounded bg-rose-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-rose-500"
          >
            <Square size={14} /> Stop
          </button>
        ) : (
          <button
            onClick={start}
            disabled={!dir.trim()}
            className="flex items-center gap-1.5 rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            <Play size={14} /> Start
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
              {latest ? Math.round(latest[s.key]).toLocaleString() : "—"}
            </div>
          </div>
        ))}
      </div>

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

/** Top weapons by outgoing DPS. */
function WeaponTable({ rows }: { rows: WeaponRate[] }) {
  return (
    <div className="rounded border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="mb-2 text-xs uppercase tracking-wide text-zinc-500">
        Damage by weapon
      </div>
      {rows.length === 0 ? (
        <p className="text-xs text-zinc-500">No outgoing damage in the window.</p>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className="border-t border-zinc-800/60">
                <td className="py-1 pr-2 text-zinc-200">{r.name}</td>
                <td className="py-1 text-right tabular-nums text-emerald-400">
                  {Math.round(r.dps).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Top counterparties by engaged DPS (dealt vs taken). */
function PilotTable({ rows }: { rows: PilotRate[] }) {
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
        <p className="text-xs text-zinc-500">No pilots engaged in the window.</p>
      ) : (
        <table className="w-full text-sm">
          <tbody>
            {rows.map((r) => (
              <tr key={r.name} className="border-t border-zinc-800/60">
                <td className="py-1 pr-2 text-zinc-200">{r.name}</td>
                <td className="py-1 text-right tabular-nums text-emerald-400">
                  {Math.round(r.dpsOut).toLocaleString()}
                </td>
                <td className="py-1 pl-3 text-right tabular-nums text-rose-400">
                  {Math.round(r.dpsIn).toLocaleString()}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Multi-line rolling chart, inline SVG (no chart dependency — same approach as
 *  the market history chart). All series share one y-scale so out/in compare. */
function DpsChart({ ticks }: { ticks: DpsTick[] }) {
  const w = 960;
  const h = 280;
  const padX = 8;
  const padY = 10;

  const n = ticks.length;
  const max = Math.max(
    1,
    ...ticks.flatMap((t) => SERIES.map((s) => t[s.key] as number)),
  );
  const x = (i: number) => padX + (i / Math.max(n - 1, 1)) * (w - 2 * padX);
  const y = (v: number) => padY + (1 - v / max) * (h - 2 * padY);
  const line = (key: keyof DpsTick) =>
    ticks
      .map((t, i) => `${x(i).toFixed(1)},${y(t[key] as number).toFixed(1)}`)
      .join(" ");
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => padY + f * (h - 2 * padY));

  return (
    <div className="rounded border border-zinc-800 bg-zinc-900 p-2">
      <div className="mb-1 flex items-center justify-between text-xs text-zinc-400">
        <span>Rolling rate (per second)</span>
        <span className="tabular-nums text-zinc-300">peak {Math.round(max).toLocaleString()}</span>
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
        {n > 1 &&
          SERIES.map((s) => (
            <polyline
              key={s.key}
              points={line(s.key)}
              fill="none"
              stroke={s.color}
              strokeWidth={s.primary ? 1.75 : 1}
              strokeOpacity={s.primary ? 1 : 0.7}
            />
          ))}
      </svg>
    </div>
  );
}
