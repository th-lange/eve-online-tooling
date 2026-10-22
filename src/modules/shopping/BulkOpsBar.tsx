import type { ShoppingList } from "../../lib/api";

// --- Bulk quantity ops (multiply / add / set) + move-to-list for the
//     currently selected rows ---

export function BulkOpsBar({
  selectedCount,
  amount,
  onAmountChange,
  onApplyToSelected,
  onBulkApply,
  otherLists,
  onMoveSelected,
  onClearSelection,
}: {
  selectedCount: number;
  amount: string;
  onAmountChange: (amount: string) => void;
  onApplyToSelected: (mode: "multiply" | "add" | "set", n: number) => void;
  onBulkApply: (mode: "multiply" | "add" | "set") => void;
  otherLists: ShoppingList[];
  onMoveSelected: (toId: string) => void;
  onClearSelection: () => void;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2.5 text-sm">
      <span className="font-medium text-zinc-300">
        {selectedCount} selected
      </span>
      {/* Quick presets — no typing needed. */}
      {(
        [
          ["add", 10, "+10"],
          ["add", 100, "+100"],
          ["multiply", 2, "×2"],
          ["multiply", 10, "×10"],
        ] as const
      ).map(([mode, n, label]) => (
        <button
          key={label}
          onClick={() => onApplyToSelected(mode, n)}
          title={
            mode === "add"
              ? `Add ${n} to each selected quantity`
              : `Multiply each selected quantity by ${n}`
          }
          className="rounded border border-zinc-700 px-3 py-1 text-zinc-200 hover:bg-zinc-800"
        >
          {label}
        </button>
      ))}
      <span className="mx-1 h-5 w-px bg-zinc-700" />
      <input
        type="number"
        value={amount}
        onChange={(e) => onAmountChange(e.currentTarget.value)}
        placeholder="n"
        className="w-24 rounded bg-zinc-800 px-2 py-1 text-right text-zinc-100 outline-none placeholder:text-zinc-500"
      />
      <button
        onClick={() => onBulkApply("multiply")}
        disabled={amount.trim() === ""}
        title="Multiply each selected quantity by n"
        className="rounded border border-zinc-700 px-3 py-1 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
      >
        × n
      </button>
      <button
        onClick={() => onBulkApply("add")}
        disabled={amount.trim() === ""}
        title="Add n to each selected quantity"
        className="rounded border border-zinc-700 px-3 py-1 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
      >
        + n
      </button>
      <button
        onClick={() => onBulkApply("set")}
        disabled={amount.trim() === ""}
        title="Set each selected quantity to n"
        className="rounded border border-zinc-700 px-3 py-1 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
      >
        set n
      </button>
      {otherLists.length > 0 && (
        <select
          value=""
          onChange={(e) => {
            onMoveSelected(e.currentTarget.value);
            e.currentTarget.value = "";
          }}
          title="Move the selected items to another list"
          className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-zinc-300 outline-none"
        >
          <option value="" disabled>
            Move to…
          </option>
          {otherLists.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      )}
      <button
        onClick={onClearSelection}
        className="ml-auto rounded px-2 py-1 text-zinc-400 hover:text-zinc-200"
      >
        Clear selection
      </button>
    </div>
  );
}
