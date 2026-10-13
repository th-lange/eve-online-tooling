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
  type LogMarkRange,
} from "./dpsMeterShared";

// Minimum horizontal pixels per 5 s bucket. The chart fits its buckets to the
// available width so a short session fills the panel instead of leaving empty
// room; only once buckets would fall below this floor (a long session — 12
// buckets/min) does the SVG grow past the viewport and scroll, sticking to
// the live edge.
const MIN_PX_PER_BUCKET = 10;
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
 *  `markRange` shades every bucket the combat log's visible span covers —
 *  from the first visible line's bucket through the last's. */
export const BucketChart = memo(function BucketChart({
  buckets,
  series,
  title,
  markRange,
}: {
  buckets: DpsBucket[];
  series: readonly BucketSeries[];
  title?: string;
  markRange?: LogMarkRange | null;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  // Stick to the live (right) edge until the user scrolls away from it; a
  // direct scrollLeft assignment below re-lands exactly on the edge, so the
  // scroll handler re-derives stickiness idempotently — no programmatic flag.
  const stickRightRef = useRef(true);
  const [hover, setHover] = useState<number | null>(null);

  const t0 = buckets[0]?.start ?? 0;
  const n = buckets.length;
  // Fit the buckets to the measured viewport: expand past the floor so a
  // short session fills the width, and only overflow (scroll) once the floor
  // binds. 0 before the first measure → falls back to the floor.
  const [viewportW, setViewportW] = useState(0);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewportW(el.clientWidth);
    const ro = new ResizeObserver(([entry]) => {
      setViewportW(entry.contentRect.width);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const pxPerBucket =
    n > 0 ? Math.max(MIN_PX_PER_BUCKET, viewportW / n) : MIN_PX_PER_BUCKET;
  const width = Math.max(1, n) * pxPerBucket;

  const { max, lines, labels, yLabels } = useMemo(() => {
    // Plot a centered moving average so a single volley's spike reads as a
    // trend instead of a saw-tooth. The axis + peak track the *smoothed*
    // series (not the raw per-bucket spikes) so the line fills the chart
    // rather than hugging the bottom; hover tooltips still show each bucket's
    // true rate.
    const smoothed = series.map((s) =>
      smoothSeries(buckets.map((b) => s.get(b))),
    );
    const max = Math.max(1, ...smoothed.flat());
    const x = (b: DpsBucket) =>
      ((b.start - t0) / BUCKET_SECS) * pxPerBucket + pxPerBucket / 2;
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
        x: x(b) - pxPerBucket / 2,
        text: formatClock(b.start),
      }));
    const yLabels = [1, 0.75, 0.5, 0.25, 0].map((f) =>
      formatInt(Math.round(max * f)),
    );
    return { max, lines, labels, yLabels };
  }, [buckets, series, t0, pxPerBucket]);

  // New buckets arrived: keep the live edge in view while stuck to it.
  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRightRef.current) el.scrollLeft = el.scrollWidth;
  }, [n]);

  // Shade from the first visible line's bucket through the last's (clamped to
  // the rendered range). `null`/out-of-range → no highlight.
  const markLo = markRange == null ? null : bucketStartOf(markRange.start);
  const markHi = markRange == null ? null : bucketStartOf(markRange.end);
  const markX =
    markLo == null || markHi == null || n === 0 || markHi < t0
      ? null
      : (Math.max(markLo - t0, 0) / BUCKET_SECS) * pxPerBucket;
  const markW =
    markLo == null || markHi == null || markX == null
      ? 0
      : ((markHi - Math.max(markLo, t0)) / BUCKET_SECS + 1) * pxPerBucket;

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
          {markLo != null && markHi != null && (
            <span className="flex items-center gap-1 text-indigo-400">
              <span className="h-2 w-0.5 bg-indigo-400" />
              log @ {formatClock(markLo)}
              {markHi !== markLo ? `–${formatClock(markHi)}` : ""}
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
                el.scrollWidth - el.scrollLeft - el.clientWidth < pxPerBucket;
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
                  const i = Math.floor((e.clientX - rect.left) / pxPerBucket);
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
                    width={markW}
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
                    x1={hover * pxPerBucket + pxPerBucket / 2}
                    x2={hover * pxPerBucket + pxPerBucket / 2}
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
