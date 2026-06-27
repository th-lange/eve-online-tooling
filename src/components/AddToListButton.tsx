import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { shoppingAddItem, shoppingLists } from "../lib/api";

/** TanStack key for the shopping lists; shared so adds can invalidate the page. */
export const SHOPPING_LISTS_KEY = ["shopping", "lists"] as const;

/** One item to push onto a list. */
export interface AddToListItem {
  typeId: number;
  quantity?: number;
}

interface Props {
  /** The single item to add (for the per-row case). */
  typeId?: number;
  /** Quantity for the single item (defaults to 1). */
  quantity?: number;
  /** Several items to add at once (e.g. a build's materials). Overrides typeId. */
  items?: AddToListItem[];
  /** Button label (e.g. "Add to list" or "2 list"). */
  label?: string;
  /** Extra classes for the trigger button. */
  className?: string;
  title?: string;
}

/**
 * A compact "add to a shopping list" control: a button that opens a popover
 * listing every shopping list. Picking one adds the item(s) — accumulating
 * quantities for items already on the list — and flashes a confirmation. Used
 * from Market Search, Production, Station Trading and Daytrading so the lists
 * act as a shared cart. Pass a single `typeId` (per row) or a list of `items`
 * (e.g. a build's materials).
 */
export function AddToListButton({
  typeId,
  quantity = 1,
  items,
  label = "Add to list",
  className,
  title,
}: Props) {
  const [open, setOpen] = useState(false);
  const [added, setAdded] = useState<string | null>(null);
  const qc = useQueryClient();

  // Lists are only fetched once the popover is opened.
  const lists = useQuery({
    queryKey: SHOPPING_LISTS_KEY,
    queryFn: shoppingLists,
    enabled: open,
  });

  const toAdd: AddToListItem[] =
    items ?? (typeId != null ? [{ typeId, quantity }] : []);

  async function add(listId: string, listName: string) {
    for (const it of toAdd) {
      await shoppingAddItem(listId, it.typeId, it.quantity ?? 1);
    }
    setOpen(false);
    setAdded(listName);
    window.setTimeout(() => setAdded(null), 1500);
    void qc.invalidateQueries({ queryKey: SHOPPING_LISTS_KEY });
  }

  return (
    <div className="relative inline-block">
      <button
        onClick={() => setOpen((v) => !v)}
        title={title ?? "Add this item to a shopping list"}
        className={
          className ??
          "rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
        }
      >
        {added ? `Added to ${added} ✓` : label}
      </button>
      {open && (
        <>
          {/* Click-away backdrop. */}
          <button
            aria-label="close"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-20 cursor-default"
          />
          <div className="absolute right-0 z-30 mt-1 max-h-60 w-48 overflow-auto rounded border border-zinc-700 bg-zinc-900 py-1 text-sm shadow-lg">
            <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-zinc-500">
              Add to…
            </div>
            {lists.isLoading && (
              <div className="px-2 py-1 text-zinc-500">Loading…</div>
            )}
            {(lists.data ?? []).map((l) => (
              <button
                key={l.id}
                onClick={() => void add(l.id, l.name)}
                className="block w-full px-2 py-1 text-left text-zinc-300 hover:bg-zinc-800"
              >
                {l.name}
              </button>
            ))}
            {lists.data?.length === 0 && (
              <div className="px-2 py-1 text-zinc-500">No lists</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
