import { useMemo, useState } from "react";
import type { ManufacturableBlueprint } from "../../lib/api";

const MAX_RENDER = 200;

// Searchable multi-select over the SDE's manufacturable blueprints. The full
// list is large, so we filter by product name and cap how many rows render.
export function BlueprintPicker({
  items,
  selected,
  onToggle,
  onClear,
}: {
  items: ManufacturableBlueprint[];
  selected: Set<number>;
  onToggle: (blueprintTypeId: number) => void;
  onClear: () => void;
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const base = needle
      ? items.filter((i) => i.productName.toLowerCase().includes(needle))
      : items;
    return base.slice(0, MAX_RENDER);
  }, [items, query]);

  return (
    <div className="flex flex-col rounded border border-zinc-800 bg-zinc-900">
      <div className="flex items-center gap-2 border-b border-zinc-800 p-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.currentTarget.value)}
          placeholder="Search blueprints…"
          className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
        />
        <span className="whitespace-nowrap text-xs text-zinc-500">
          {selected.size} selected
        </span>
        <button
          onClick={onClear}
          disabled={selected.size === 0}
          className="rounded px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800 disabled:opacity-40"
        >
          Clear
        </button>
      </div>

      <ul className="max-h-72 overflow-auto">
        {filtered.map((bp) => {
          const checked = selected.has(bp.blueprintTypeId);
          return (
            <li key={bp.blueprintTypeId}>
              <label className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-zinc-800/60">
                <input
                  type="checkbox"
                  checked={checked}
                  onChange={() => onToggle(bp.blueprintTypeId)}
                />
                <span className="text-zinc-200">{bp.productName}</span>
              </label>
            </li>
          );
        })}
        {filtered.length === 0 && (
          <li className="px-3 py-2 text-sm text-zinc-500">No matches.</li>
        )}
      </ul>
      {items.length > MAX_RENDER && (
        <div className="border-t border-zinc-800 px-3 py-1.5 text-xs text-zinc-600">
          Showing first {Math.min(filtered.length, MAX_RENDER)} of{" "}
          {items.length}. Refine your search to narrow.
        </div>
      )}
    </div>
  );
}
