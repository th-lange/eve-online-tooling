import { useEffect, useMemo, useState } from "react";

import { useCopyToClipboard } from "../../lib/useCopyToClipboard";
import {
  errorMessage,
  shoppingClearList,
  shoppingMoveItems,
  shoppingRemoveItem,
  shoppingSetQuantities,
  shoppingSetQuantity,
  type ShoppingList,
} from "../../lib/api";
import { formatInt } from "../../lib/format";

import { AddItemField } from "./AddItemField";
import { BulkOpsBar } from "./BulkOpsBar";
import { ItemRow } from "./ItemRow";
import { SearchAddField } from "./SearchAddField";

// --- One list's items + add field ---

export function ListDetail({
  list,
  allLists,
  onChange,
}: {
  list: ShoppingList;
  allLists: ShoppingList[];
  onChange: () => Promise<unknown>;
}) {
  const totalQty = useMemo(
    () => list.items.reduce((sum, i) => sum + i.quantity, 0),
    [list.items],
  );

  // EVE Multibuy: one `name<TAB>quantity` per line.
  const multibuy = useMemo(
    () => list.items.map((i) => `${i.name}\t${i.quantity}`).join("\n"),
    [list.items],
  );
  const { copied, copy } = useCopyToClipboard(1500);

  // Row selection + bulk quantity ops (multiply / add / set).
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [amount, setAmount] = useState("");
  const [bulkError, setBulkError] = useState<string | null>(null);
  // Drop selections that no longer exist as the list changes.
  useEffect(() => {
    setSelected((prev) => {
      const ids = new Set(list.items.map((i) => i.typeId));
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [list.items]);
  const allSelected =
    list.items.length > 0 && selected.size === list.items.length;

  const toggle = (typeId: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(typeId)) next.delete(typeId);
      else next.add(typeId);
      return next;
    });
  const toggleAll = () =>
    setSelected((prev) =>
      prev.size === list.items.length
        ? new Set()
        : new Set(list.items.map((i) => i.typeId)),
    );

  async function applyToSelected(mode: "multiply" | "add" | "set", n: number) {
    if (!Number.isFinite(n) || selected.size === 0) return;
    const updates = list.items
      .filter((it) => selected.has(it.typeId))
      .map((it) => {
        const next =
          mode === "multiply"
            ? it.quantity * n
            : mode === "add"
              ? it.quantity + n
              : n;
        return { typeId: it.typeId, quantity: Math.max(1, Math.round(next)) };
      });
    setBulkError(null);
    try {
      await shoppingSetQuantities(list.id, updates);
      await onChange();
    } catch (e) {
      setBulkError(errorMessage(e));
    }
  }
  const bulkApply = (mode: "multiply" | "add" | "set") =>
    applyToSelected(mode, Number(amount));

  async function setQty(typeId: number, quantity: number) {
    await shoppingSetQuantity(list.id, typeId, quantity);
    await onChange();
  }
  async function remove(typeId: number) {
    await shoppingRemoveItem(list.id, typeId);
    await onChange();
  }
  async function clear() {
    await shoppingClearList(list.id);
    await onChange();
  }
  async function moveSelected(toId: string) {
    if (!toId) return;
    const typeIds = list.items
      .filter((it) => selected.has(it.typeId))
      .map((it) => it.typeId);
    if (typeIds.length === 0) return;
    setBulkError(null);
    try {
      await shoppingMoveItems(list.id, toId, typeIds);
      setSelected(new Set());
      await onChange();
    } catch (e) {
      setBulkError(errorMessage(e));
    }
  }
  const otherLists = allLists.filter((l) => l.id !== list.id);

  return (
    <div>
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold text-zinc-100">{list.name}</h2>
        <div className="flex items-center gap-2">
          <button
            onClick={() => copy(multibuy)}
            disabled={list.items.length === 0}
            title="Copy the items for the in-game Multibuy window"
            className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          >
            {copied ? "Copied ✓" : "Multibuy"}
          </button>
          <button
            onClick={() => void clear()}
            disabled={list.items.length === 0}
            className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          >
            Clear
          </button>
        </div>
      </div>

      <SearchAddField listId={list.id} onAdded={onChange} />
      <AddItemField listId={list.id} onAdded={onChange} />

      {selected.size > 0 && (
        <BulkOpsBar
          selectedCount={selected.size}
          amount={amount}
          onAmountChange={setAmount}
          onApplyToSelected={(mode, n) => void applyToSelected(mode, n)}
          onBulkApply={(mode) => void bulkApply(mode)}
          otherLists={otherLists}
          onMoveSelected={(toId) => void moveSelected(toId)}
          onClearSelection={() => setSelected(new Set())}
        />
      )}

      {bulkError && (
        <p className="mt-2 text-sm text-rose-400">Failed: {bulkError}</p>
      )}

      {list.items.length === 0 ? (
        <p className="mt-4 text-sm text-zinc-500">
          No items yet — search above, or use an “add to list” button elsewhere.
        </p>
      ) : (
        <table className="mt-4 w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-800 text-left text-xs text-zinc-500">
              <th className="w-6 py-1">
                <input
                  type="checkbox"
                  checked={allSelected}
                  onChange={toggleAll}
                  aria-label="Select all"
                />
              </th>
              <th className="py-1 font-medium">Item</th>
              <th className="w-28 py-1 text-right font-medium">Quantity</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {list.items.map((i) => (
              <ItemRow
                key={i.typeId}
                item={i}
                selected={selected.has(i.typeId)}
                onToggle={() => toggle(i.typeId)}
                onCommit={(q) => void setQty(i.typeId, q)}
                onRemove={() => void remove(i.typeId)}
              />
            ))}
          </tbody>
          <tfoot>
            <tr className="text-xs text-zinc-500">
              <td />
              <td className="py-1">{list.items.length} items</td>
              <td className="py-1 text-right">{formatInt(totalQty)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  );
}
