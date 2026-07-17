import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { UserCog } from "lucide-react";
import { characterTradeFees } from "../lib/api";
import { queryErrorText } from "./QueryErrorNotice";

const round2 = (x: number) => Math.round(x * 100) / 100;

/**
 * A small "From character" control that fills a page's Broker fee % / Sales tax
 * % from the active character's Accounting / Broker Relations skills and
 * standings. Sales tax is the same everywhere; broker fee is per hub, so a
 * dropdown picks the hub. `onApply(brokerPct, salesTaxPct)` sets the fields.
 */
export function FeesFromCharacter({
  onApply,
}: {
  onApply: (brokerPct: number, salesTaxPct: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const q = useQuery({
    queryKey: ["character", "tradeFees"],
    queryFn: characterTradeFees,
    staleTime: 10 * 60_000,
    retry: false,
  });

  const disabled = q.isLoading || q.isError || !q.data;
  const title =
    (q.isError &&
      queryErrorText(
        q.error,
        "Log in a character to auto-fill fees from skills + standings",
      )) ||
    "Fill broker fee + sales tax from your character (per hub)";

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => !disabled && setOpen((o) => !o)}
        disabled={disabled}
        title={title}
        className="flex items-center gap-1 rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
      >
        <UserCog size={12} /> From character
      </button>
      {open && q.data && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 z-20 mt-1 w-60 rounded-md border border-zinc-700 bg-zinc-800 p-1 shadow-lg">
            <div className="px-2 py-1 text-[10px] uppercase leading-snug tracking-wide text-zinc-500">
              Sales tax {round2(q.data.salesTaxPct)}% · pick a hub for its
              broker fee
            </div>
            {q.data.hubs.map((h) => (
              <button
                key={h.hub}
                type="button"
                onClick={() => {
                  onApply(round2(h.brokerFeePct), round2(q.data!.salesTaxPct));
                  setOpen(false);
                }}
                className="flex w-full items-center justify-between rounded px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-700"
              >
                <span>
                  {h.hub}
                  <span className="ml-1 text-zinc-500">{h.region}</span>
                </span>
                <span className="tabular-nums text-zinc-400">
                  {round2(h.brokerFeePct)}%
                </span>
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
