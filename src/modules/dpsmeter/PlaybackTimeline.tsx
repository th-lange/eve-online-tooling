import { useMemo, useRef, useState } from "react";
import { ChevronsLeftRight, ZoomOut } from "lucide-react";
import type { DpsLogSummary } from "../../lib/api";
import {
  OVERVIEW_SEGMENT_SECS,
  TIMELINE_COLORS,
  formatClock,
  groupOverview,
  overviewGroupSecs,
  snapWindow,
} from "./dpsMeterShared";
import { useDragZoom } from "./useDragZoom";

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

/** Human label for a grouping width: "1m", "10m", "100m". */
function groupLabel(groupSecs: number): string {
  return `${Math.round(groupSecs / 60)}m`;
}

/** Playback overview (#985): a density strip over the log's fixed 1-minute
 *  segments. Bars are segments grouped 10 at a time until they fit the strip
 *  (1 min → 10 min → 100 min — always 10^x; auto-fit only), normalized per
 *  category against the busiest bar in view. Two independent gestures:
 *   - the slider underneath seeks; it snaps to 1-minute segment edges;
 *   - dragging across the strip selects whole bars as a fight region: the
 *     strip re-scopes to it (auto-fit picks the finer level — one power per
 *     10× zoom by construction) and playback loops within it. Region bounds
 *     are always segment edges, never finer than 1 minute. Reset clears. */
export function PlaybackTimeline({
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

  // The full log on the 1-minute grid (segments are epoch-aligned, so these
  // bounds are stable as a live log grows — new minutes only append).
  const fullStart =
    summary.segments[0]?.start ??
    Math.floor(summary.start / OVERVIEW_SEGMENT_SECS) * OVERVIEW_SEGMENT_SECS;
  const fullEnd =
    (summary.segments[summary.segments.length - 1]?.start ?? fullStart) +
    OVERVIEW_SEGMENT_SECS;

  // Displayed window = the selected region (already on segment edges), else
  // the whole log; the grouping level auto-fits to whatever is shown.
  const rawStart = region?.start ?? fullStart;
  const rawEnd = region?.end ?? fullEnd;
  const groupSecs = overviewGroupSecs(rawEnd - rawStart);
  const { start, end } = snapWindow(rawStart, rawEnd, groupSecs);
  const span = Math.max(1, end - start);

  // Bars at the active level, normalized per category against the busiest
  // bar in view (render-time normalization — segments carry absolute sums).
  const bars = useMemo(() => {
    const groups = groupOverview(summary.segments, start, end, groupSecs);
    const peak = (f: (g: (typeof groups)[number]) => number) =>
      Math.max(1e-9, ...groups.map(f));
    const pOut = peak((g) => g.damageOut);
    const pIn = peak((g) => g.damageIn);
    const pMin = peak((g) => g.mining);
    return groups.map((g) => ({
      start: g.start,
      damageOut: g.damageOut / pOut,
      damageIn: g.damageIn / pIn,
      mining: g.mining / pMin,
    }));
  }, [summary.segments, start, end, groupSecs]);

  const value = preview ?? position ?? start;
  const barW = w / Math.max(1, bars.length);

  const svgRef = useRef<SVGSVGElement | null>(null);
  // Drag-select snaps outward to whole bars at the current level, so region
  // bounds are always segment edges (and zooming in re-fits one power finer).
  const { drag, handlers } = useDragZoom(svgRef, w, (f0, f1) => {
    const i0 = Math.floor(f0 * bars.length);
    const i1 = Math.min(bars.length - 1, Math.floor(f1 * bars.length));
    onSelectRegion(start + i0 * groupSecs, start + (i1 + 1) * groupSecs);
  });

  /** Seek lands on 1-minute segment edges, clamped to the window. */
  function snapSeek(v: number) {
    const snapped =
      Math.round(v / OVERVIEW_SEGMENT_SECS) * OVERVIEW_SEGMENT_SECS;
    onSeek(Math.min(Math.max(snapped, start), end));
  }

  return (
    <div className="mt-4 rounded border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="mb-1 flex items-center justify-between text-[11px] tabular-nums text-zinc-500">
        <span>{formatClock(start)}</span>
        <span className="flex items-center gap-3 normal-case tracking-normal text-zinc-400">
          <TimelineLegend color={TIMELINE_COLORS.damageOut} label="dmg out" />
          <TimelineLegend color={TIMELINE_COLORS.damageIn} label="dmg in" />
          <TimelineLegend color={TIMELINE_COLORS.mining} label="mining" />
          <span
            className="text-zinc-600"
            title="Bar width — segments group 10 at a time to fit"
          >
            {groupLabel(groupSecs)}/bar
          </span>
          {region ? (
            <>
              <button
                onClick={() =>
                  onSelectRegion(
                    Math.max(fullStart, region.start - OVERVIEW_SEGMENT_SECS),
                    Math.min(fullEnd, region.end + OVERVIEW_SEGMENT_SECS),
                  )
                }
                disabled={region.start <= fullStart && region.end >= fullEnd}
                title="Widen the selection by one segment on each side"
                className="flex items-center gap-1 rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-zinc-800 disabled:hover:text-zinc-400"
              >
                <ChevronsLeftRight size={11} /> +1m
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
          {bars.map((b) => (
            <rect
              key={b.start}
              x={((b.start - start) / span) * w}
              y={rowH * (1 - b.damageOut)}
              width={Math.max(1, barW - 0.5)}
              height={rowH * b.damageOut}
            />
          ))}
        </g>
        <g fill={TIMELINE_COLORS.damageIn}>
          {bars.map((b) => (
            <rect
              key={b.start}
              x={((b.start - start) / span) * w}
              y={rowH + rowH * (1 - b.damageIn)}
              width={Math.max(1, barW - 0.5)}
              height={rowH * b.damageIn}
            />
          ))}
        </g>
        <g fill={TIMELINE_COLORS.mining}>
          {bars.map((b) => (
            <rect
              key={b.start}
              x={((b.start - start) / span) * w}
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
        step={OVERVIEW_SEGMENT_SECS}
        value={Math.min(Math.max(value, start), end)}
        onChange={(e) => setPreview(Number(e.currentTarget.value))}
        onMouseUp={(e) => {
          snapSeek(Number(e.currentTarget.value));
          setPreview(null);
        }}
        onTouchEnd={(e) => {
          snapSeek(Number(e.currentTarget.value));
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
