import { formatInt } from "../../lib/format";

/** Mining overview: session total, current live rate, and a normalized rate
 *  line (m³/s, newest right). Each point is a trailing MINING_SMOOTH_SECS
 *  average so laser-cycle chunks flatten into the sustained yield. Shown only
 *  once the session has mined anything. */
export function MiningPanel({
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
