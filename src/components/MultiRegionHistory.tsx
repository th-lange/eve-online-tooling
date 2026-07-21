import { useMemo } from "react";
import type { HistoryPoint } from "../lib/api";
import { formatIsk } from "../lib/format";

// Multi-region price comparison: one daily-average line per region over a shared
// date axis, plus 7D and 28D moving averages of the first (primary) region.
// Complements the single-region PriceHistoryView — this is the "is the gap
// structural or a blip?" view for cross-region trading.

const W = 640;
const H = 220;
const PAD = 8;
const PAD_BOTTOM = 18;
const WINDOW_DAYS = 90;
// Region line colours (primary first). Extra regions cycle through the rest.
const COLORS = ["#34d399", "#38bdf8", "#f59e0b", "#a78bfa", "#fb7185"];

export interface RegionSeries {
  name: string;
  history: HistoryPoint[];
}

/** Trailing `days`-calendar-day mean of average price, skipping no-trade gaps
 *  (never counted as zero). Indexed to align with `dates`. */
function movingAverage(
  byDate: Map<string, number>,
  dates: string[],
  days: number,
): (number | null)[] {
  return dates.map((_, i) => {
    const from = Math.max(0, i - days + 1);
    const vals: number[] = [];
    for (let j = from; j <= i; j++) {
      const v = byDate.get(dates[j]);
      if (v != null) vals.push(v);
    }
    return vals.length ? vals.reduce((s, v) => s + v, 0) / vals.length : null;
  });
}

export function MultiRegionHistory({ regions }: { regions: RegionSeries[] }) {
  const model = useMemo(() => {
    const withData = regions.filter((r) => r.history.length > 0);
    if (withData.length === 0) return null;
    // Shared date axis = sorted union of the last WINDOW_DAYS dates across all.
    const dateSet = new Set<string>();
    for (const r of withData) {
      for (const p of r.history.slice(-WINDOW_DAYS)) dateSet.add(p.date);
    }
    const dates = [...dateSet].sort();
    if (dates.length < 2) return null;
    const xi = new Map(dates.map((d, i) => [d, i]));
    const maps = withData.map(
      (r) => new Map(r.history.map((p) => [p.date, p.average])),
    );
    const all = maps.flatMap((m) => [...m.values()]);
    const minV = Math.min(...all);
    const maxV = Math.max(...all);
    const span = maxV - minV || 1;
    const x = (i: number) => PAD + (i / (dates.length - 1)) * (W - 2 * PAD);
    const y = (v: number) =>
      H - PAD_BOTTOM - ((v - minV) / span) * (H - PAD - PAD_BOTTOM);
    const lineFor = (m: Map<string, number>) =>
      dates
        .map((d) => {
          const v = m.get(d);
          return v == null
            ? null
            : `${x(xi.get(d)!).toFixed(1)},${y(v).toFixed(1)}`;
        })
        .filter((p): p is string => p !== null)
        .join(" ");
    const primary = maps[0];
    const maLine = (days: number) =>
      movingAverage(primary, dates, days)
        .map((v, i) =>
          v == null ? null : `${x(i).toFixed(1)},${y(v).toFixed(1)}`,
        )
        .filter((p): p is string => p !== null)
        .join(" ");
    return {
      minV,
      maxV,
      lines: withData.map((r, i) => ({
        name: r.name,
        color: COLORS[i % COLORS.length],
        points: lineFor(maps[i]),
      })),
      ma7: maLine(7),
      ma28: maLine(28),
    };
  }, [regions]);

  if (!model) {
    return (
      <div className="rounded border border-zinc-800 p-6 text-center text-sm text-zinc-500">
        Not enough history to compare.
      </div>
    );
  }

  return (
    <div className="rounded border border-zinc-800 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs">
        {model.lines.map((l) => (
          <span key={l.name} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2 w-3 rounded-sm"
              style={{ backgroundColor: l.color }}
            />
            <span className="text-zinc-300">{l.name}</span>
          </span>
        ))}
        <span className="flex items-center gap-1.5 text-zinc-500">
          <span className="inline-block h-0.5 w-3 bg-zinc-500" /> 7D / 28D MA
          (primary)
        </span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        className="h-52 w-full"
      >
        {model.ma7 && (
          <polyline
            points={model.ma7}
            fill="none"
            stroke="#71717a"
            strokeWidth="1"
            strokeDasharray="3 2"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {model.ma28 && (
          <polyline
            points={model.ma28}
            fill="none"
            stroke="#52525b"
            strokeWidth="1"
            strokeDasharray="5 3"
            vectorEffect="non-scaling-stroke"
          />
        )}
        {model.lines.map((l) => (
          <polyline
            key={l.name}
            points={l.points}
            fill="none"
            stroke={l.color}
            strokeWidth="1.5"
            vectorEffect="non-scaling-stroke"
          />
        ))}
      </svg>
      <div className="mt-1 flex justify-between text-[11px] tabular-nums text-zinc-500">
        <span>low {formatIsk(model.minV)}</span>
        <span>high {formatIsk(model.maxV)}</span>
      </div>
    </div>
  );
}
