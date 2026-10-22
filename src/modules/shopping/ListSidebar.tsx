import type { ShoppingList } from "../../lib/api";

// --- List selector + new-list field ---

export function ListSidebar({
  lists,
  selectedId,
  onSelect,
  changed,
  onDelete,
  newName,
  onNewNameChange,
  onCreate,
}: {
  lists: ShoppingList[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  changed: Set<string>;
  onDelete: (id: string) => void;
  newName: string;
  onNewNameChange: (name: string) => void;
  onCreate: () => void;
}) {
  return (
    <div className="w-56 shrink-0">
      <div className="space-y-1">
        {lists.map((l) => (
          <div
            key={l.id}
            className={`group flex items-center rounded ${
              l.id === selectedId ? "bg-zinc-800" : "hover:bg-zinc-900"
            }`}
          >
            <button
              onClick={() => onSelect(l.id)}
              className="flex flex-1 items-center px-2 py-1 text-left text-sm text-zinc-200"
            >
              {l.name}
              <span className="ml-1 text-xs text-zinc-500">
                {l.items.length}
              </span>
              {changed.has(l.id) && (
                <span
                  title="Updated since you last viewed it"
                  className="ml-1.5 inline-block h-1.5 w-1.5 rounded-full bg-amber-400"
                />
              )}
            </button>
            {l.removable && (
              <button
                onClick={() => onDelete(l.id)}
                title="Delete this list"
                className="px-2 text-xs text-zinc-600 opacity-0 hover:text-red-400 group-hover:opacity-100"
              >
                ✕
              </button>
            )}
          </div>
        ))}
      </div>

      {/* New list. */}
      <div className="mt-3 flex gap-1">
        <input
          value={newName}
          onChange={(e) => onNewNameChange(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") onCreate();
          }}
          placeholder="new list…"
          className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
        />
        <button
          onClick={onCreate}
          className="rounded border border-zinc-700 px-2 py-1 text-sm text-zinc-300 hover:bg-zinc-800"
        >
          +
        </button>
      </div>
    </div>
  );
}
