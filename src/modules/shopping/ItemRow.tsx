import type { ShoppingItem } from "../../lib/api";

import { QuantityCell } from "./QuantityCell";

// --- One list item's table row (checkbox, name, quantity, remove) ---

export function ItemRow({
  item,
  selected,
  onToggle,
  onCommit,
  onRemove,
}: {
  item: ShoppingItem;
  selected: boolean;
  onToggle: () => void;
  onCommit: (quantity: number) => void;
  onRemove: () => void;
}) {
  return (
    <tr className="border-b border-zinc-900">
      <td className="py-1">
        <input
          type="checkbox"
          checked={selected}
          onChange={onToggle}
          aria-label={`Select ${item.name}`}
        />
      </td>
      <td className="py-1 text-zinc-200">{item.name}</td>
      <td className="py-1 text-right">
        <QuantityCell
          name={item.name}
          quantity={item.quantity}
          onCommit={onCommit}
        />
      </td>
      <td className="py-1 text-right">
        <button
          onClick={onRemove}
          title="Remove from list"
          className="px-1 text-zinc-600 hover:text-red-400"
        >
          ✕
        </button>
      </td>
    </tr>
  );
}
