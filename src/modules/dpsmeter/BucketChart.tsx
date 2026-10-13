import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { DpsBucket } from "../../lib/api";
import { formatInt } from "../../lib/format";
import {
  BUCKET_SECS,
  bucketStartOf,
  formatClock,
  SMOOTH_WINDOW_BUCKETS,
  smoothSeries,
  type BucketSeries,
} from "./dpsMeterShared";

// Horizontal pixels per 5 s bucket. The SVG's width grows with the session
// (12 buckets/min — a 1 h capture is ~7200 px) inside a scrolling viewport.
const PX_PER_BUCKET = 10;
const H = 280;
const PAD_Y = 10;
const PAD_B = 24; // room for the time labels along the bottom
// A time label every this many buckets (12 × 5 s = every minute).
const LABEL_EVERY = 12;

/** Multi-line chart over the fixed 5 s grid (#983): x is **time** (bucket
 *  start, constant 5 s spacing), not array index, so a stalled poll or a
 *  hidden page shows up as a flat/empty stretch instead of silently
 *  compressing the axis. The viewport scrolls over the whole session and
 *  sticks to the live edge until the user scrolls back.
 *
 *  `markTs` shades the bucket a given timestamp falls inside — the combat
 *  log's scroll position (`floor(ts / 5) * 5`, exact by construction). */
export const BucketChart = memo(function BucketChart({
  buckets,
  series,
  title,
  markTs,
}: {
  buckets: DpsBucket[];
  series: readonly BucketSeries[];
  title?: string;
  markTs?: number | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Stick to the live (right) edge until the user scrolls away from it; a
  // direct scrollLeft assignment below re-lands exactly on the edge, so the
  // scroll handler re-derives stickiness idempotently — no programmatic flag.
  const stickRightRef = useRef(true);
  const [hover, setHover] = useState<number | null>(null);

  const t0 = buckets[0]?.start ?? 0;
  const n = buckets.length;
  const width = Math.max(1, n) * PX_PER_BUCKET;

  const { max, lines, labels, yLabels } = useMemo(() => {
    // Axis + peak reflect the TRUE per-bucket rate (so the DPS numbers aren't
    // understated), but the plotted lines use a centered moving average so a
    // single volley's spike reads as a trend instead of a saw-tooth.
    const rawValues = series.map((s) => buckets.map((b) => s.get(b)));
    const max = Math.max(1, ...rawValues.flat());
    const smoothed = rawValues.map(smoothSeries);
    const x = (b: DpsBucket) =>
      ((b.start - t0) / BUCKET_SECS) * PX_PER_BUCKET + PX_PER_BUCKET / 2;
    const y = (v: number) => PAD_Y + (1 - v / max) * (H - PAD_Y - PAD_B);
    const lines = series.map((s, si) => ({
      key: s.id,
      color: s.color,
      primary: s.primary,
      points: buckets
        .map((b, i) => `${x(b).toFixed(1)},${y(smoothed[si][i]).toFixed(1)}`)
        .join(" "),
    }));
    const labels = buckets
      .filter((b) => b.start % (LABEL_EVERY * BUCKET_SECS) === 0)
      .map((b) => ({
        x: x(b) - PX_PER_BUCKET / 2,
        text: formatClock(b.start),
      }));
    const yLabels = [1, 0.75, 0.5, 0.25, 0].map((f) =>
      formatInt(Math.round(max * f)),
    );
    return { max, lines, labels, yLabels };
  }, [buckets, series, t0]);

  // New buckets arrived: keep the live edge in view while stuck to it.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRightRef.current) el.scrollLeft = el.scrollWidth;
  }, [n]);

  const markStart = markTs == null ? null : bucketStartOf(markTs);
  const markX =
    markStart == null || n === 0 || markStart < t0
      ? null
      : ((markStart - t0) / BUCKET_SECS) * PX_PER_BUCKET;

  const hoverBucket = hover != null ? buckets[hover] : undefined;
  const yAxisStyle = { height: H, paddingTop: PAD_Y, paddingBottom: PAD_B };

  return (
    <div className="rounded border border-zinc-800 bg-zinc-900 p-2">
      <div className="mb-1 flex items-center justify-between text-xs text-zinc-400">
        <span>
          {title ?? "Rate"} (per second) · {BUCKET_SECS}s grid ·{" "}
          {SMOOTH_WINDOW_BUCKETS * BUCKET_SECS}s smoothed
        </span>
        <span className="flex items-center gap-2 tabular-nums text-zinc-300">
          {markStart != null && (
            <span className="flex items-center gap-1 text-indigo-400">
              <span className="h-2 w-0.5 bg-indigo-400" />
              log @ {formatClock(markStart)}
            </span>
          )}
          <span>peak {formatInt(Math.round(max))}</span>
        </span>
      </div>
      <div className="flex items-stretch">
        <div
          className="flex shrink-0 flex-col justify-between pr-1 text-right text-[10px] tabular-nums text-zinc-500"
          style={yAxisStyle}
        >
          {yLabels.map((lbl, i) => (
            <span key={i}>{lbl}</span>
          ))}
        </div>
        <div className="relative min-w-0 flex-1">
          <div
            ref={scrollRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              stickRightRef.current =
                el.scrollWidth - el.scrollLeft - el.clientWidth < PX_PER_BUCKET;
            }}
            className="overflow-x-auto"
          >
            {n === 0 ? (
              <div
                className="flex items-center justify-center text-xs text-zinc-600"
                style={{ height: H }}
              >
                Waiting for the first 5s bucket…
              </div>
            ) : (
              <svg
                width={width}
                height={H}
                className="block cursor-crosshair"
                onPointerMove={(e) => {
                  const rect = e.currentTarget.getBoundingClientRect();
                  const i = Math.floor((e.clientX - rect.left) / PX_PER_BUCKET);
                  setHover(i >= 0 && i < n ? i : null);
                }}
                onPointerLeave={() => setHover(null)}
              >
                {[0, 0.25, 0.5, 0.75, 1].map((f) => (
                  <line
                    key={f}
                    x1={0}
                    x2={width}
                    y1={PAD_Y + f * (H - PAD_Y - PAD_B)}
                    y2={PAD_Y + f * (H - PAD_Y - PAD_B)}
                    stroke="#27272a"
                    strokeWidth="0.75"
                  />
                ))}
                {labels.map((l) => (
                  <g key={l.x}>
                    <line
                      x1={l.x}
                      x2={l.x}
                      y1={PAD_Y}
                      y2={H - PAD_B}
                      stroke="#27272a"
                      strokeWidth="0.75"
                    />
                    <text
                      x={l.x}
                      y={H - 8}
                      textAnchor="middle"
                      fill="#71717a"
                      fontSize="11"
                    >
                      {l.text}
                    </text>
                  </g>
                ))}
                {markX != null && (
                  <rect
                    x={markX}
                    y={PAD_Y}
                    width={PX_PER_BUCKET}
                    height={H - PAD_Y - PAD_B}
                    fill="#818cf8"
                    fillOpacity="0.18"
                    stroke="#818cf8"
                    strokeWidth="1"
                  />
                )}
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
                {hover != null && (
                  <line
                    x1={hover * PX_PER_BUCKET + PX_PER_BUCKET / 2}
                    x2={hover * PX_PER_BUCKET + PX_PER_BUCKET / 2}
                    y1={PAD_Y}
                    y2={H - PAD_B}
                    stroke="#a1a1aa"
                    strokeWidth="0.75"
                    strokeDasharray="4 3"
                  />
                )}
              </svg>
            )}
          </div>
          {hoverBucket && (
            <div
              className="pointer-events-none absolute left-2 top-1 z-10 w-56 rounded border border-zinc-700 bg-zinc-900/95 px-2 py-1 text-[11px] shadow-lg"
              data-testid="bucket-tooltip"
            >
              <div className="mb-0.5 tabular-nums text-zinc-500">
                {formatClock(hoverBucket.start)} –{" "}
                {formatClock(hoverBucket.end)}
              </div>
              {series.map((s) => (
                <div key={s.id} className="flex justify-between gap-3">
                  <span className="truncate" style={{ color: s.color }}>
                    {s.id}
                  </span>
                  <span className="tabular-nums text-zinc-300">
                    {formatInt(Math.round(s.get(hoverBucket)))}
                  </span>
                </div>
              ))}
              {/* Per-pilot engagement inside this bucket (dealt / taken). */}
              {hoverBucket.byPilot.some((p) => p.dpsOut > 0) && (
                <div className="mt-1 font-medium text-emerald-400">Dealt</div>
              )}
              {hoverBucket.byPilot
                .filter((p) => p.dpsOut > 0)
                .slice(0, 5)
                .map((p) => (
                  <div
                    key={`o-${p.name}`}
                    className="flex justify-between gap-3"
                  >
                    <span className="truncate text-zinc-300">
                      {p.name}
                      {p.ship ? (
                        <span className="text-zinc-500"> · {p.ship}</span>
                      ) : null}
                    </span>
                    <span className="tabular-nums text-zinc-400">
                      {formatInt(Math.round(p.dpsOut))}
                    </span>
                  </div>
                ))}
              {hoverBucket.byPilot.some((p) => p.dpsIn > 0) && (
                <div className="mt-1 font-medium text-rose-400">Taken</div>
              )}
              {hoverBucket.byPilot
                .filter((p) => p.dpsIn > 0)
                .slice(0, 5)
                .map((p) => (
                  <div
                    key={`i-${p.name}`}
                    className="flex justify-between gap-3"
                  >
                    <span className="truncate text-zinc-300">
                      {p.name}
                      {p.ship ? (
                        <span className="text-zinc-500"> · {p.ship}</span>
                      ) : null}
                    </span>
                    <span className="tabular-nums text-zinc-400">
                      {formatInt(Math.round(p.dpsIn))}
                    </span>
                  </div>
                ))}
            </div>
          )}
        </div>
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
