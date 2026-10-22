import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus } from "lucide-react";

import { sdeKeys } from "../../lib/queryKeys";
import { shoppingAddItem } from "../../lib/api";
import { useDebouncedValue } from "../../lib/useDebouncedValue";

// --- Search-to-add field (find an item, pick a quantity, add) ---

export function SearchAddField({
  listId,
  onAdded,
}: {
  listId: string;
  onAdded: () => Promise<unknown>;
}) {
  const [q, setQ] = useState("");
  const [qty, setQty] = useState("1");
  const [busy, setBusy] = useState(false);

  // Debounce the typed query before it reaches the search invoke (same
  // pattern as Combo): one backend request per pause, not per keystroke.
  const debouncedQ = useDebouncedValue(q, 200);
  const results = useQuery({
    ...sdeKeys.search(debouncedQ),
    enabled: debouncedQ.trim().length >= 2,
  });
  const matches = (results.data ?? []).slice(0, 12);

  async function add(typeId: number) {
    if (busy) return;
    setBusy(true);
    try {
      await shoppingAddItem(listId, typeId, Math.max(1, Number(qty) || 1));
      await onAdded();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4">
      <div className="flex items-center gap-2">
        <input
          value={q}
          onChange={(e) => setQ(e.currentTarget.value)}
          placeholder="search an item to add…"
          className="w-full max-w-md rounded bg-zinc-800 px-3 py-1.5 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
        />
        <input
          type="number"
          min={1}
          value={qty}
          onChange={(e) => setQty(e.currentTarget.value)}
          aria-label="quantity"
          className="w-20 rounded bg-zinc-800 px-2 py-1.5 text-right text-sm tabular-nums text-zinc-100 outline-none"
        />
      </div>
      {q.trim().length >= 2 && (
        <ul className="mt-1 max-h-56 w-full max-w-md overflow-y-auto rounded border border-zinc-800 bg-zinc-900/40 text-sm">
          {matches.map((r) => (
            <li key={r.id}>
              <button
                disabled={busy}
                onClick={() => add(r.id)}
                className="flex w-full items-center gap-2 px-2 py-1 text-left text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
              >
                <span className="flex-1 truncate">{r.name}</span>
                <Plus size={14} className="shrink-0 text-zinc-500" />
              </button>
            </li>
          ))}
          {results.isFetched && matches.length === 0 && (
            <li className="px-2 py-1 text-xs text-zinc-500">No matches.</li>
          )}
        </ul>
      )}
    </div>
  );
}
