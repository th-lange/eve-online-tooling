import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DpsEvent } from "../../lib/api";
import {
  eventToneClass,
  formatClock,
  formatEventLine,
  groupEventsByBucket,
  minuteStartOf,
} from "./dpsMeterShared";

/** Collapsible, auto-scrolling combat log, grouped onto the 5 s bucket grid
 *  (#1002): a divider marks each bucket boundary, so "this chart bar = these
 *  lines" is visible in the log itself, and the group whose bucket the shared
 *  cursor names is tinted like the chart highlight. Shared between the DPS
 *  meter page and the PVP fight overlay — both feed from the same
 *  `dps://events` stream, so this only needs the buffered array, the cursor,
 *  and open/close state as props. */
export function CombatLogPanel({
  events,
  collapsed,
  onToggleCollapsed,
  cursor,
  jumpTo,
  className = "",
  maxHeightClass = "max-h-64",
}: {
  events: DpsEvent[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** The shared minute cursor, set by clicking a chart cell — every group
   *  inside it gets the chart highlight's tint. */
  cursor?: number | null;
  /** Chart → log jump (#1003): scroll the first group at or after this time
   *  to the viewport centre. The nonce `n` lets the same target repeat. */
  jumpTo?: { start: number; n: number } | null;
  className?: string;
  /** Tailwind max-height class for the scrolling list — the fight overlay's
   *  compact footer passes a shorter one than the DPS meter page. */
  maxHeightClass?: string;
}) {
  const [autoScroll, setAutoScroll] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  // Scrolling itself (the auto-scroll effect below) fires `scroll` events
  // indistinguishable from the user dragging the scrollbar; without this,
  // the very act of auto-scrolling to a new line would immediately read as
  // "user scrolled up" mid-animation and cancel itself.
  const programmaticScrollRef = useRef(false);
  const rafRef = useRef<number | null>(null);

  const groups = useMemo(() => groupEventsByBucket(events), [events]);

  useEffect(() => {
    if (!collapsed && autoScroll) {
      const el = containerRef.current;
      if (!el) return;
      // Scroll the log container only — `scrollIntoView` on the bottom
      // anchor would also scroll the page itself to the log on every batch.
      programmaticScrollRef.current = true;
      el.scrollTop = el.scrollHeight;
      const t = setTimeout(() => {
        programmaticScrollRef.current = false;
      }, 100);
      return () => clearTimeout(t);
    }
  }, [events.length, autoScroll, collapsed]);

  // Chart → log (#1003): a bucket click scrolls its group to the viewport
  // centre. The nonce makes re-clicking the same bucket jump again. Only the
  // log container scrolls — `scrollIntoView` would scroll every ancestor
  // including the page, yanking the viewport between chart and log (#1006
  // follow-up); the programmatic flag keeps the resulting scroll event from
  // re-reporting the centre and fighting the cursor.
  useEffect(() => {
    if (!jumpTo || collapsed) return;
    const el = containerRef.current;
    if (!el) return;
    // Target the first group at or after the requested time (a chart click
    // can land on an empty bucket with no group of its own), else the last.
    const candidates = [...el.querySelectorAll("[data-bucket]")];
    const group =
      candidates.find(
        (g) => Number((g as HTMLElement).dataset.bucket) >= jumpTo.start,
      ) ?? candidates[candidates.length - 1];
    if (!group) return;
    setAutoScroll(false);
    programmaticScrollRef.current = true;
    const g = group as HTMLElement;
    el.scrollTop = Math.max(
      0,
      g.offsetTop - (el.clientHeight - g.offsetHeight) / 2,
    );
    const t = setTimeout(() => {
      programmaticScrollRef.current = false;
    }, 100);
    return () => clearTimeout(t);
  }, [jumpTo, collapsed]);

  function handleScroll() {
    if (programmaticScrollRef.current || rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const el = containerRef.current;
      if (!el) return;
      // Scrolling away from the live tail pauses auto-scroll; returning to
      // the bottom resumes it. (The cursor is click-driven only — scroll
      // reporting kept drifting against the lines on screen and was removed.)
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      if (atBottom) {
        if (!autoScroll) setAutoScroll(true);
      } else if (autoScroll) {
        setAutoScroll(false);
      }
    });
  }

  return (
    <div
      className={`rounded-lg border border-zinc-800 bg-zinc-900/60 ${className}`}
    >
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          onClick={onToggleCollapsed}
          aria-expanded={!collapsed}
          className="flex flex-1 items-center gap-1.5 text-left text-sm font-medium text-zinc-300 hover:text-zinc-100"
        >
          {collapsed ? <ChevronRight size={14} /> : <ChevronDown size={14} />}
          Combat log
          <span className="text-xs font-normal text-zinc-500">
            ({events.length})
          </span>
        </button>
        {!collapsed && (
          <label className="flex cursor-pointer items-center gap-1.5 text-xs text-zinc-400">
            <input
              type="checkbox"
              checked={autoScroll}
              onChange={(e) => setAutoScroll(e.target.checked)}
              className="accent-indigo-500"
            />
            Auto-scroll
          </label>
        )}
      </div>
      {!collapsed && (
        <div
          ref={containerRef}
          onScroll={handleScroll}
          className={`${maxHeightClass} overflow-y-auto border-t border-zinc-800 px-3 py-2 font-mono text-xs`}
        >
          {events.length === 0 ? (
            <p className="py-2 text-zinc-600">No combat events yet.</p>
          ) : (
            <>
              {groups.map((g, gi) => (
                <div
                  key={`${g.start}:${gi}`}
                  data-bucket={g.start}
                  className={`rounded px-1 [content-visibility:auto] ${
                    cursor === minuteStartOf(g.start) ? "bg-indigo-500/10" : ""
                  }`}
                >
                  {/* A timestamped divider only where a minute begins (or at
                      the very top) — one per 5 s bucket was unreadable noise.
                      Other bucket boundaries keep just the thin rule. */}
                  {gi === 0 || g.start % 60 === 0 ? (
                    <div
                      className={`flex items-center gap-2 pt-1 text-[10px] ${
                        cursor === minuteStartOf(g.start)
                          ? "text-indigo-400"
                          : "text-zinc-600"
                      }`}
                    >
                      <span className="h-px flex-1 bg-zinc-800" />
                      {formatClock(g.start)}
                      <span className="h-px flex-1 bg-zinc-800" />
                    </div>
                  ) : (
                    <div className="pt-1">
                      <span className="block h-px bg-zinc-800/60" />
                    </div>
                  )}
                  {g.events.map((e, i) => (
                    <div key={i} className={`py-0.5 ${eventToneClass(e)}`}>
                      <span className="text-zinc-600">{formatClock(e.ts)}</span>{" "}
                      {formatEventLine(e)}
                    </div>
                  ))}
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
}
