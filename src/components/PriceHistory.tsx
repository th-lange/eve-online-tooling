import { useMemo, useState, type MouseEvent } from "react";
import type { HistoryPoint } from "../lib/api";
import { formatInt, formatIsk } from "../lib/format";

// Price/volume history charts (Donchian channel, moving average, daily median)
// + the summary/table, shared by Market Search and the production history popover.

const MA_PERIODS = [7, 20, 50, 90] as const;
const WINDOWS = [30, 90, 180, 400] as const;

export function PriceHistoryView({ history }: { history: HistoryPoint[] }) {
  const [windowDays, setWindowDays] = useState(90);
  const [period, setPeriod] = useState(20);
  const [showChannel, setShowChannel] = useState(true);
  const [showMa, setShowMa] = useState(true);
  const [showMedian, setShowMedian] = useState(true);

  const series = useMemo(
    () => history.slice(-windowDays),
    [history, windowDays],
  );

  const last = series[series.length - 1];
  const avgVol = Math.round(
    series.reduce((s, p) => s + p.volume, 0) / series.length,
  );
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
        <Stat label="Latest avg" value={formatIsk(last.average)} />
        <Stat label="Latest median" value={formatIsk(dailyMedian(last))} />
        <Stat label="Latest volume" value={formatInt(last.volume)} />
        <Stat label="Avg volume/day" value={formatInt(avgVol)} />
        <div className="ml-auto flex items-center gap-3 text-xs text-zinc-400">
          <label className="flex items-center gap-1">
            Range
            <select
              value={windowDays}
              onChange={(e) => setWindowDays(Number(e.currentTarget.value))}
              className="rounded bg-zinc-800 px-2 py-1 text-zinc-100 outline-none"
            >
              {WINDOWS.map((d) => (
                <option key={d} value={d}>
                  {d >= 400 ? "All" : `${d} days`}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1">
            MA/channel
            <select
              value={period}
              onChange={(e) => setPeriod(Number(e.currentTarget.value))}
              className="rounded bg-zinc-800 px-2 py-1 text-zinc-100 outline-none"
            >
              {MA_PERIODS.map((p) => (
                <option key={p} value={p}>
                  {p}
                </option>
              ))}
            </select>
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={showMa}
              onChange={(e) => setShowMa(e.currentTarget.checked)}
              className="accent-amber-500"
            />
            MA
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={showChannel}
              onChange={(e) => setShowChannel(e.currentTarget.checked)}
              className="accent-sky-500"
            />
            Donchian
          </label>
          <label className="flex items-center gap-1">
            <input
              type="checkbox"
              checked={showMedian}
              onChange={(e) => setShowMedian(e.currentTarget.checked)}
              className="accent-violet-500"
            />
            Median
          </label>
        </div>
      </div>
      <PriceChart
        series={series}
        period={period}
        showChannel={showChannel}
        showMa={showMa}
        showMedian={showMedian}
      />
      <div className="h-3" />
      <Chart
        series={series}
        pick={(p) => p.volume}
        label="Daily volume"
        color="#60a5fa"
        fmt={(v) => formatInt(v)}
      />
      <div className="mt-4 max-h-72 overflow-auto rounded border border-zinc-800">
        <table className="w-full text-xs">
          <thead className="sticky top-0 bg-zinc-900 text-zinc-500">
            <tr>
              <th className="px-2 py-1 text-left font-medium">Date</th>
              <th className="px-2 py-1 text-right font-medium">Avg</th>
              <th className="px-2 py-1 text-right font-medium">Low</th>
              <th className="px-2 py-1 text-right font-medium">High</th>
              <th className="px-2 py-1 text-right font-medium">Volume</th>
              <th className="px-2 py-1 text-right font-medium">Orders</th>
            </tr>
          </thead>
          <tbody>
            {[...series].reverse().map((p) => (
              <tr
                key={p.date}
                className="border-t border-zinc-800/60 text-zinc-300"
              >
                <td className="px-2 py-0.5">{p.date}</td>
                <td className="px-2 py-0.5 text-right tabular-nums">
                  {formatIsk(p.average)}
                </td>
                <td className="px-2 py-0.5 text-right tabular-nums">
                  {formatIsk(p.lowest)}
                </td>
                <td className="px-2 py-0.5 text-right tabular-nums">
                  {formatIsk(p.highest)}
                </td>
                <td className="px-2 py-0.5 text-right tabular-nums">
                  {formatInt(p.volume)}
                </td>
                <td className="px-2 py-0.5 text-right tabular-nums">
                  {formatInt(p.orderCount)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

/** Simple moving average of `vals` over `period` (uses the available window at
 *  the head so the line spans the whole series). */
function sma(vals: number[], period: number): number[] {
  return vals.map((_, i) => {
    const start = Math.max(0, i - period + 1);
    let sum = 0;
    for (let j = start; j <= i; j++) sum += vals[j];
    return sum / (i - start + 1);
  });
}

/** A day's median price. ESI daily history has no true intraday median, so we
 *  use the midpoint of that day's high/low range (falling back to the day's
 *  average when a high/low is missing). One value per day, not over the window. */
function dailyMedian(p: HistoryPoint): number {
  return p.highest > 0 && p.lowest > 0 ? (p.highest + p.lowest) / 2 : p.average;
}

/** Donchian channel: rolling max of the daily high / min of the daily low over
 *  `period`. Falls back to the day's average when a high/low is missing. */
function donchian(
  series: HistoryPoint[],
  period: number,
): { upper: number[]; lower: number[] } {
  const upper = series.map((_, i) => {
    const start = Math.max(0, i - period + 1);
    let m = -Infinity;
    for (let j = start; j <= i; j++)
      m = Math.max(m, series[j].highest || series[j].average);
    return m;
  });
  const lower = series.map((_, i) => {
    const start = Math.max(0, i - period + 1);
    let m = Infinity;
    for (let j = start; j <= i; j++) {
      m = Math.min(
        m,
        series[j].lowest > 0 ? series[j].lowest : series[j].average,
      );
    }
    return m;
  });
  return { upper, lower };
}

/** Price chart with a Donchian channel band and a moving-average overlay on top
 *  of the daily average price (no chart dependency). */
function PriceChart({
  series,
  period,
  showChannel,
  showMa,
  showMedian,
}: {
  series: HistoryPoint[];
  period: number;
  showChannel: boolean;
  showMa: boolean;
  showMedian: boolean;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const w = 960;
  const h = 320;
  const padX = 8;
  const padY = 10;

  const avg = series.map((p) => p.average);
  const med = series.map(dailyMedian);
  const ma = sma(avg, period);
  const { upper, lower } = donchian(series, period);

  // Scale to fit whatever is shown (the band widens the range when on).
  const highs = showChannel
    ? upper
    : showMedian
      ? avg.map((v, i) => Math.max(v, med[i]))
      : avg;
  const lows = showChannel
    ? lower
    : showMedian
      ? avg.map((v, i) => Math.min(v, med[i]))
      : avg;
  const min = Math.min(...lows);
  const max = Math.max(...highs);
  const span = max - min || 1;
  const x = (i: number) =>
    padX + (i / Math.max(series.length - 1, 1)) * (w - 2 * padX);
  const y = (v: number) => padY + (1 - (v - min) / span) * (h - 2 * padY);
  const line = (vals: number[]) =>
    vals.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => padY + f * (h - 2 * padY));

  // Band = upper across, then lower back (a closed polygon).
  const band = [
    ...upper.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`),
    ...lower.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).reverse(),
  ].join(" ");

  function onMove(e: MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const rx = ((e.clientX - rect.left) / rect.width) * w;
    const i = Math.round(
      ((rx - padX) / (w - 2 * padX)) * Math.max(series.length - 1, 1),
    );
    setHover(Math.max(0, Math.min(series.length - 1, i)));
  }

  return (
    <div className="rounded border border-zinc-800 bg-zinc-900 p-2">
      <div className="mb-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
        <Legend color="#34d399" label="Average price" />
        {showMa && <Legend color="#f59e0b" label={`MA ${period}d`} />}
        {showChannel && (
          <Legend color="#38bdf8" label={`Donchian ${period}d`} />
        )}
        {showMedian && <Legend color="#a78bfa" label="Daily median" />}
        <span className="ml-auto tabular-nums text-zinc-300">
          {hover != null
            ? `${series[hover].date} · ${formatIsk(avg[hover])}` +
              (showMedian ? ` · med ${formatIsk(med[hover])}` : "") +
              (showChannel
                ? ` · ${formatIsk(lower[hover])}–${formatIsk(upper[hover])}`
                : "")
            : `${formatIsk(min)} – ${formatIsk(max)}`}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height: h }}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
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
        {showChannel && (
          <>
            <polygon
              points={band}
              fill="#38bdf8"
              fillOpacity="0.08"
              stroke="none"
            />
            <polyline
              points={line(upper)}
              fill="none"
              stroke="#38bdf8"
              strokeWidth="1"
              strokeDasharray="3 3"
              strokeOpacity="0.8"
            />
            <polyline
              points={line(lower)}
              fill="none"
              stroke="#38bdf8"
              strokeWidth="1"
              strokeDasharray="3 3"
              strokeOpacity="0.8"
            />
          </>
        )}
        {showMedian && (
          <polyline
            points={line(med)}
            fill="none"
            stroke="#a78bfa"
            strokeWidth="1.5"
            strokeDasharray="5 4"
          />
        )}
        <polyline
          points={line(avg)}
          fill="none"
          stroke="#34d399"
          strokeWidth="1.5"
        />
        {showMa && (
          <polyline
            points={line(ma)}
            fill="none"
            stroke="#f59e0b"
            strokeWidth="1.5"
          />
        )}
        {hover != null && (
          <g>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={padY}
              y2={h - padY}
              stroke="#52525b"
              strokeWidth="0.75"
            />
            <circle cx={x(hover)} cy={y(avg[hover])} r="3" fill="#34d399" />
          </g>
        )}
      </svg>
    </div>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span
        className="inline-block h-2.5 w-2.5 rounded-sm"
        style={{ background: color }}
      />
      <span className="text-zinc-400">{label}</span>
    </span>
  );
}

/** An inline SVG line chart with horizontal gridlines, a legend, value-axis
 *  labels and a hover readout (no chart dependency). */
function Chart({
  series,
  pick,
  label,
  color,
  fmt,
}: {
  series: HistoryPoint[];
  pick: (p: HistoryPoint) => number;
  label: string;
  color: string;
  fmt: (v: number) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const w = 960;
  const h = 200;
  const padX = 8;
  const padY = 10;
  const vals = series.map(pick);
  const min = Math.min(...vals);
  const max = Math.max(...vals);
  const span = max - min || 1;
  const x = (i: number) =>
    padX + (i / Math.max(vals.length - 1, 1)) * (w - 2 * padX);
  const y = (v: number) => padY + (1 - (v - min) / span) * (h - 2 * padY);
  const pts = vals
    .map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`)
    .join(" ");
  const grid = [0, 0.25, 0.5, 0.75, 1].map((f) => padY + f * (h - 2 * padY));

  function onMove(e: MouseEvent<SVGSVGElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const rx = ((e.clientX - rect.left) / rect.width) * w;
    const i = Math.round(
      ((rx - padX) / (w - 2 * padX)) * Math.max(vals.length - 1, 1),
    );
    setHover(Math.max(0, Math.min(vals.length - 1, i)));
  }

  return (
    <div className="rounded border border-zinc-800 bg-zinc-900 p-2">
      <div className="mb-1 flex items-center gap-2 text-xs">
        <span
          className="inline-block h-2.5 w-2.5 rounded-sm"
          style={{ background: color }}
        />
        <span className="text-zinc-400">{label}</span>
        <span className="ml-auto tabular-nums text-zinc-300">
          {hover != null
            ? `${series[hover].date} · ${fmt(vals[hover])}`
            : `${fmt(min)} – ${fmt(max)}`}
        </span>
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height: h }}
        onMouseMove={onMove}
        onMouseLeave={() => setHover(null)}
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
        <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" />
        {hover != null && (
          <g>
            <line
              x1={x(hover)}
              x2={x(hover)}
              y1={padY}
              y2={h - padY}
              stroke="#52525b"
              strokeWidth="0.75"
            />
            <circle cx={x(hover)} cy={y(vals[hover])} r="3" fill={color} />
          </g>
        )}
      </svg>
    </div>
  );
}

export function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: string;
}) {
  return (
    <div>
      <div className="text-xs text-zinc-500">{label}</div>
      <div className={`tabular-nums ${accent ?? "text-zinc-200"}`}>{value}</div>
    </div>
  );
}
