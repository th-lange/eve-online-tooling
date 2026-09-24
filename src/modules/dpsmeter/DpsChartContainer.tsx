import { memo, useMemo, useState } from "react";
import { Columns2, Layers, Rows2 } from "lucide-react";
import type { DpsTick, WeaponRate } from "../../lib/api";
import { formatInt } from "../../lib/format";
import type { ChartLayout, ChartSeries } from "./dpsMeterShared";
import { formatClock } from "./dpsMeterShared";

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

/** Graphs — outgoing and incoming; layout + breakdown toggles + the two (or
 *  one, in combined layout) rolling charts. */
export function DpsChartContainer({
  bySource,
  onSetBySource,
  chartLayout,
  onSetChartLayout,
  filteredTicks,
  outSeries,
  inSeries,
  combinedSeries,
}: {
  bySource: boolean;
  onSetBySource: (v: boolean) => void;
  chartLayout: ChartLayout;
  onSetChartLayout: (v: ChartLayout) => void;
  filteredTicks: DpsTick[];
  outSeries: ChartSeries[];
  inSeries: ChartSeries[];
  combinedSeries: ChartSeries[];
}) {
  return (
    <>
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
              onClick={() => onSetBySource(value)}
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
              onClick={() => onSetChartLayout(value)}
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
    </>
  );
}
