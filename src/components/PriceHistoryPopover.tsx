import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { LineChart, X } from "lucide-react";
import { errorMessage, marketHistory } from "../lib/api";
import { PriceHistoryView } from "./PriceHistory";

const WIDTH = 760;

/**
 * A chart-icon button that opens a popover with an item's price/volume history
 * at `regionId` — the same view as the Market Search history tab.
 *
 * The history is fetched **lazily on first open** (`enabled: open`) and cached:
 * react-query keys it by region+type with a long stale time, and the market
 * service caches history ~20 min, so re-opening (or opening another row for the
 * same item) is instant with no refetch.
 */
export function PriceHistoryPopover({
  regionId,
  typeId,
  name,
}: {
  regionId: number;
  typeId: number;
  name: string;
}) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [pos, setPos] = useState<{
    top: number;
    left: number;
    maxHeight: number;
  } | null>(null);

  const history = useQuery({
    queryKey: ["market", "history", regionId, typeId],
    queryFn: () => marketHistory(regionId, typeId),
    enabled: open,
    staleTime: 30 * 60 * 1000, // history is daily — cache aggressively
  });

  // Anchor the panel under the button, clamped to the viewport.
  useLayoutEffect(() => {
    if (!open || !btnRef.current) return;
    const r = btnRef.current.getBoundingClientRect();
    const width = Math.min(WIDTH, window.innerWidth - 24);
    setPos({
      top: r.bottom + 6,
      left: Math.min(
        Math.max(12, r.left - width / 2),
        window.innerWidth - width - 12,
      ),
      maxHeight: window.innerHeight - r.bottom - 24,
    });
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  const width = Math.min(WIDTH, window.innerWidth - 24);

  return (
    <>
      <button
        ref={btnRef}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        title={`Price history — ${name}`}
        aria-label={`Price history for ${name}`}
        className={`rounded p-1 ${open ? "text-sky-400" : "text-zinc-400 hover:text-sky-400"}`}
      >
        <LineChart size={15} />
      </button>
      {open &&
        pos &&
        createPortal(
          <>
            <div
              className="fixed inset-0 z-40"
              onClick={() => setOpen(false)}
            />
            <div
              role="dialog"
              className="fixed z-50 overflow-auto rounded-lg border border-zinc-700 bg-zinc-900 p-3 shadow-xl"
              style={{
                top: pos.top,
                left: pos.left,
                width,
                maxHeight: pos.maxHeight,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-2 flex items-center justify-between">
                <span className="text-sm font-medium text-zinc-200">
                  {name} — price history
                </span>
                <button
                  onClick={() => setOpen(false)}
                  aria-label="Close"
                  className="text-zinc-500 hover:text-zinc-200"
                >
                  <X size={15} />
                </button>
              </div>
              {history.isLoading ? (
                <div className="p-8 text-center text-sm text-zinc-500">
                  Loading history…
                </div>
              ) : history.isError ? (
                <div className="p-8 text-center text-sm text-rose-400">
                  {errorMessage(history.error)}
                </div>
              ) : (history.data?.length ?? 0) === 0 ? (
                <div className="p-8 text-center text-sm text-zinc-500">
                  No market history for this item in the selected region.
                </div>
              ) : (
                <PriceHistoryView series={history.data!} />
              )}
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
