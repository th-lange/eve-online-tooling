import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { useQuery } from "@tanstack/react-query";
import { LineChart, X } from "lucide-react";
import { errorMessage, marketHistory } from "../lib/api";
import { PriceHistoryView } from "./PriceHistory";

/**
 * A chart-icon button that opens a centered modal with an item's price/volume
 * history at `regionId` — the same view as the Market Search history tab.
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

  const history = useQuery({
    queryKey: ["market", "history", regionId, typeId],
    queryFn: () => marketHistory(regionId, typeId),
    enabled: open,
    staleTime: 30 * 60 * 1000, // history is daily — cache aggressively
  });

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        title={`Price history — ${name}`}
        aria-label={`Price history for ${name}`}
        className={`rounded p-1 transition ${
          open
            ? "bg-sky-400/15 text-sky-300"
            : "text-sky-400 hover:bg-sky-400/10 hover:text-sky-300"
        }`}
      >
        <LineChart size={16} />
      </button>
      {open &&
        createPortal(
          <div
            className="fixed inset-0 z-50 flex items-center justify-center p-4"
            onClick={() => setOpen(false)}
          >
            <div className="absolute inset-0 bg-black/60" />
            <div
              role="dialog"
              onClick={(e) => e.stopPropagation()}
              className="relative z-10 max-h-[85vh] w-[760px] max-w-[calc(100vw-2rem)] overflow-auto rounded-lg border border-zinc-700 bg-zinc-900 p-3 shadow-xl"
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
          </div>,
          document.body,
        )}
    </>
  );
}
