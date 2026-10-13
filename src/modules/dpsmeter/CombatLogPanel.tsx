import { ChevronDown, ChevronRight } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import type { DpsEvent } from "../../lib/api";
import { formatClock, groupEventsByBucket } from "./dpsMeterShared";

/** Render one parsed combat-log line as plain English, e.g.
 *  "450 dmg → Some Pilot (Caracal) — Heavy Missile Launcher II [Wrecks]".
 *  Exported for unit testing. */
export function formatEventLine(e: DpsEvent): string {
  const who = `${e.pilot ?? "?"}${e.ship ? ` (${e.ship})` : ""}`;
  const via = e.weapon ? ` — ${e.weapon}` : "";
  switch (e.kind) {
    case "damageOut":
    case "damageIn": {
      const arrow = e.kind === "damageOut" ? "→" : "←";
      if (e.quality === "Misses") return `Misses ${arrow} ${who}${via}`;
      const q = e.quality ? ` [${e.quality}]` : "";
      return `${e.amount} dmg ${arrow} ${who}${via}${q}`;
    }
    case "repOut":
      return `${e.amount} repaired → ${who}`;
    case "repIn":
      return `${e.amount} repaired ← ${who}`;
    case "capTransferOut":
      return `${e.amount} GJ cap sent → ${who}`;
    case "capTransferIn":
      return `${e.amount} GJ cap received ← ${who}`;
    case "capWarfareOut":
      return `${e.amount} GJ cap neut'd → ${who}`;
    case "capWarfareIn":
      return `${e.amount} GJ cap neut'd ← ${who}`;
    case "scramOut":
      return `Scrambled → ${who}`;
    case "scramIn":
      return `Scrambled ← ${who}`;
    case "pointOut":
      return `Pointed → ${who}`;
    case "pointIn":
      return `Pointed ← ${who}`;
    case "mining":
      return `Mined ${e.amount} ${e.ore ?? "ore"}${e.volume > 0 ? ` (${e.volume.toFixed(0)} m³)` : ""}`;
  }
}

/** Text color by rough direction — outgoing (you did it) warm sky, incoming
 *  (done to you) cool rose, mining amber: the same warm/cool-out/in + amber
 *  convention as the rate charts (see `SERIES`/`TIMELINE_COLORS`). Misses are
 *  dimmed regardless of direction — noise, not signal. */
export function eventToneClass(e: DpsEvent): string {
  if (e.quality === "Misses") return "text-zinc-600";
  if (e.kind === "mining") return "text-amber-400";
  return e.kind.endsWith("Out") ? "text-sky-400" : "text-rose-400";
}

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
  onVisibleCenterChange,
  jumpTo,
  className = "",
  maxHeightClass = "max-h-64",
}: {
  events: DpsEvent[];
  collapsed: boolean;
  onToggleCollapsed: () => void;
  /** The shared bucket cursor — this group gets the chart highlight's tint. */
  cursor?: number | null;
  /** Fired as the user scrolls through history: the bucket start of the group
   *  at the viewport's vertical centre, or `null` once back at the live tail
   *  (or nothing to report — collapsed, empty). The parent chart highlights
   *  the bucket closest to this time. */
  onVisibleCenterChange?: (bucketStart: number | null) => void;
  /** Chart → log jump (#1003): scroll this bucket's group to the viewport
   *  centre. The nonce `n` lets the same bucket be jumped to twice. */
  jumpTo?: { start: number; n: number } | null;
  className?: string;
  /** Tailwind max-height class for the scrolling list — the fight overlay's
   *  compact footer passes a shorter one than the DPS meter page. */
  maxHeightClass?: string;
}) {
  const [autoScroll, setAutoScroll] = useState(true);
  const bottomRef = useRef<HTMLDivElement>(null);
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
      programmaticScrollRef.current = true;
      bottomRef.current?.scrollIntoView({ behavior: "smooth" });
      const t = setTimeout(() => {
        programmaticScrollRef.current = false;
      }, 600);
      return () => clearTimeout(t);
    }
  }, [events.length, autoScroll, collapsed]);

  // Collapsing hides the log — any chart highlight it was driving should go too.
  useEffect(() => {
    if (collapsed) onVisibleCenterChange?.(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collapsed]);

  // Chart → log (#1003): a bucket click scrolls its group to the viewport
  // centre. The nonce makes re-clicking the same bucket jump again; the
  // programmatic flag keeps the resulting scroll from reading as a user
  // scroll (which would re-report the centre and fight the cursor).
  useEffect(() => {
    if (!jumpTo || collapsed) return;
    const group = containerRef.current?.querySelector(
      `[data-bucket="${jumpTo.start}"]`,
    );
    if (!group) return;
    setAutoScroll(false);
    programmaticScrollRef.current = true;
    (group as HTMLElement).scrollIntoView({
      block: "center",
      behavior: "smooth",
    });
    const t = setTimeout(() => {
      programmaticScrollRef.current = false;
    }, 600);
    return () => clearTimeout(t);
  }, [jumpTo, collapsed]);

  function handleScroll() {
    if (programmaticScrollRef.current || rafRef.current != null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const el = containerRef.current;
      if (!el) return;
      const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
      if (atBottom) {
        if (!autoScroll) setAutoScroll(true);
        onVisibleCenterChange?.(null);
        return;
      }
      // Scrolled away from the live tail: stop yanking back to it, and report
      // the bucket group at the viewport's vertical centre — group and chart
      // bucket share the same id (the bucket start), so this maps exactly.
      if (autoScroll) setAutoScroll(false);
      const center = el.scrollTop + el.clientHeight / 2;
      let start: number | null = null;
      let bestDiff = Infinity;
      for (const child of el.children) {
        const group = child as HTMLElement;
        if (group.dataset.bucket === undefined) continue;
        const groupCenter = group.offsetTop + group.offsetHeight / 2;
        const diff = Math.abs(groupCenter - center);
        if (diff < bestDiff) {
          bestDiff = diff;
          start = Number(group.dataset.bucket);
        }
      }
      onVisibleCenterChange?.(start);
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
                    cursor === g.start ? "bg-indigo-500/10" : ""
                  }`}
                >
                  <div
                    className={`flex items-center gap-2 pt-1 text-[10px] ${
                      cursor === g.start ? "text-indigo-400" : "text-zinc-600"
                    }`}
                  >
                    <span className="h-px flex-1 bg-zinc-800" />
                    {formatClock(g.start)}
                    <span className="h-px flex-1 bg-zinc-800" />
                  </div>
                  {g.events.map((e, i) => (
                    <div key={i} className={`py-0.5 ${eventToneClass(e)}`}>
                      <span className="text-zinc-600">{formatClock(e.ts)}</span>{" "}
                      {formatEventLine(e)}
                    </div>
                  ))}
                </div>
              ))}
              <div ref={bottomRef} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
