import { useMemo, useRef, useState } from "react";
import { ChevronsLeftRight, ZoomOut } from "lucide-react";
import type { DpsLogSummary } from "../../lib/api";
import { TIMELINE_COLORS, formatClock } from "./dpsMeterShared";
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

/** Playback overview (#dps-timeline): a density strip over the log's time
 *  span — three thin rows (dealt / taken / mined), each bucket scaled to its
 *  own category's busiest moment. Two independent gestures:
 *   - the slider underneath seeks (sets the play position); releasing
 *     restarts playback from there with the window pre-warmed;
 *   - dragging across the strip selects a fight region: the strip + slider
 *     re-scope to it and playback loops within it (see the Loop button).
 *     Reset clears the region. The strip itself no longer seeks. */
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
