import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ClipboardCopy, Loader2 } from "lucide-react";

import {
  errorMessage,
  shoppingAddItem,
  shoppingCreateList,
  type AssetLocation,
  type MaterialGroup,
} from "../../lib/api";
import { assetsKeys, SHOPPING_LISTS_KEY } from "../../lib/queryKeys";
import { formatInt } from "../../lib/format";
import { useCopyToClipboard } from "../../lib/useCopyToClipboard";
import { InlineError } from "../../components/InlineError";

export function GroupSection({
  group,
  locations,
  locationsFetching,
  onRequestLocations,
}: {
  group: MaterialGroup;
  locations: AssetLocation[];
  locationsFetching: boolean;
  onRequestLocations: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [locationId, setLocationId] = useState<number | "">("");
  const { copied, copy } = useCopyToClipboard(1500);

  // Stock at the picked location, fetched on demand and cached per location
  // (no pricing involved — see `assets_stock_at_location`). Until it arrives
  // the table keeps showing the full quantity rather than a misleading
  // "have 0".
  const stockQuery = useQuery({
    ...assetsKeys.stockAt(locationId === "" ? 0 : locationId),
    enabled: locationId !== "",
  });
  const stockByType = useMemo(
    () => new Map((stockQuery.data ?? []).map((s) => [s.typeId, s.quantity])),
    [stockQuery.data],
  );
  const netted = locationId !== "" && stockQuery.data != null;

  // Blank location (default): the full needed quantity, unchanged. A picked
  // location subtracts what the roster already has stocked there, so the
  // Multibuy/save actions below only reflect what's still actually needed.
  // `required`/`owned` stay on each row so the table can show the full
  // accounting — a fully covered material reads "have ≥ need", not as a
  // silently vanished row.
  const items = group.items.map((it) => {
    if (!netted) return { ...it, required: it.quantity, owned: 0 };
    const owned = stockByType.get(it.typeId) ?? 0;
    return {
      ...it,
      required: it.quantity,
      owned,
      quantity: Math.max(0, it.quantity - owned),
    };
  });
  const stillNeeded = items.filter((it) => it.quantity > 0);
  const multibuy = stillNeeded
    .map((i) => `${i.name}\t${i.quantity}`)
    .join("\n");

  return (
    <div className="rounded border border-zinc-800">
      <div className="flex items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-900 px-3 py-2">
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-2 text-left text-sm font-medium text-zinc-200"
        >
          <span className="text-zinc-500">{collapsed ? "▸" : "▾"}</span>
          {group.categoryName}
          <span className="text-xs font-normal text-zinc-500">
            ({group.items.length} item{group.items.length === 1 ? "" : "s"})
          </span>
        </button>
        <div className="flex items-center gap-2">
          <select
            value={locationId}
            onChange={(e) =>
              setLocationId(
                e.currentTarget.value ? Number(e.currentTarget.value) : "",
              )
            }
            onFocus={onRequestLocations}
            title="Subtract what the roster already has stocked at a location"
            className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 outline-none"
          >
            <option value="">
              {locationsFetching && locations.length === 0
                ? "Loading locations…"
                : "All locations — full quantity"}
            </option>
            {locations.map((loc) => (
              <option key={loc.id} value={loc.id}>
                {loc.name}
              </option>
            ))}
          </select>
          {(locationsFetching || stockQuery.isFetching) && (
            <Loader2
              size={13}
              className="animate-spin text-zinc-500"
              aria-label="Loading stock…"
            />
          )}
          <button
            onClick={() => copy(multibuy)}
            disabled={stockQuery.isFetching}
            title="Copy this group as a Multibuy-pasteable item list"
            className="flex items-center gap-1.5 rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          >
            <ClipboardCopy size={13} />
            {copied ? "Copied ✓" : "Copy Multibuy"}
          </button>
          <SaveAsListButton
            group={{ categoryName: group.categoryName, items: stillNeeded }}
          />
        </div>
      </div>
      {stockQuery.isError && (
        <div className="px-3 py-1.5">
          <InlineError message={errorMessage(stockQuery.error)} />
        </div>
      )}
      {!collapsed && (
        <table className="w-full border-collapse text-sm">
          <thead className="text-zinc-500">
            <tr>
              <th className="px-3 py-1 text-left font-normal">Item</th>
              {!netted ? (
                <th className="px-3 py-1 text-right font-normal">Quantity</th>
              ) : (
                <>
                  <th className="px-3 py-1 text-right font-normal">Need</th>
                  <th className="px-3 py-1 text-right font-normal">Have</th>
                  <th className="px-3 py-1 text-right font-normal">To buy</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.typeId} className="border-t border-zinc-800/60">
                <td className="px-3 py-1 text-zinc-200">{it.name}</td>
                {netted && (
                  <>
                    <td className="px-3 py-1 text-right text-zinc-300">
                      {formatInt(it.required)}
                    </td>
                    <td className="px-3 py-1 text-right text-zinc-300">
                      {formatInt(it.owned)}
                    </td>
                  </>
                )}
                <td
                  className={`px-3 py-1 text-right ${
                    it.quantity === 0 && netted
                      ? "text-zinc-600"
                      : "text-zinc-300"
                  }`}
                >
                  {formatInt(it.quantity)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** "Save as new shopping list…" — a name popover that creates the list, bulk
 * adds every item in the group, and invalidates the Shopping Lists query so
 * the new list shows up immediately there. */
function SaveAsListButton({ group }: { group: MaterialGroup }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: async (listName: string) => {
      const list = await shoppingCreateList(listName);
      for (const it of group.items) {
        await shoppingAddItem(list.id, it.typeId, it.quantity);
      }
      return list;
    },
    onSuccess: () => {
      setError(null);
      setOpen(false);
      setName("");
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
      void qc.invalidateQueries({ queryKey: SHOPPING_LISTS_KEY });
    },
    onError: (e) => setError(errorMessage(e)),
  });

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
      >
        {saved ? "Saved ✓" : "Save as new shopping list…"}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-1 w-64 rounded border border-zinc-700 bg-zinc-900 p-2 shadow-lg">
            <input
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim()) save.mutate(name.trim());
              }}
              placeholder={`${group.categoryName} — ${new Date().toLocaleDateString()}`}
              autoFocus
              className="w-full rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-100 outline-none placeholder:text-zinc-500"
            />
            <div className="mt-2 flex justify-end gap-2">
              <button
                onClick={() => setOpen(false)}
                className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                onClick={() => name.trim() && save.mutate(name.trim())}
                disabled={name.trim().length === 0 || save.isPending}
                className="rounded bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {save.isPending ? "Saving…" : "Save"}
              </button>
            </div>
            <InlineError
              message={error}
              className="mt-1 text-xs text-rose-400"
            />
          </div>
        </>
      )}
    </div>
  );
}
