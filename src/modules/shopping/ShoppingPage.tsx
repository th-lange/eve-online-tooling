import { useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";

import { SHOPPING_LISTS_KEY } from "../../components/AddToListButton";
import { useCopyToClipboard } from "../../lib/useCopyToClipboard";
import { parseItems, parseLine } from "./parse";
import {
  sdeSearch,
  shoppingAddItem,
  shoppingAddText,
  shoppingClearList,
  shoppingCreateList,
  shoppingDeleteList,
  shoppingLists,
  shoppingRemoveItem,
  shoppingSetQuantity,
  type ShoppingList,
} from "../../lib/api";

/**
 * Shopping Lists — a group of named lists you fill while browsing other modules.
 * The `default` and `production` lists are built in and can't be removed; you
 * can add more. Each list holds items + quantities; add items here via the
 * known-item search field, or from the "add to list" buttons on Market Search,
 * Production, Station Trading and Daytrading.
 */
export function ShoppingPage() {
  const qc = useQueryClient();
  const lists = useQuery({ queryKey: SHOPPING_LISTS_KEY, queryFn: shoppingLists });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");

  const refresh = () => qc.invalidateQueries({ queryKey: SHOPPING_LISTS_KEY });

  // Keep a valid selection as lists load / change.
  const data = lists.data;
  useEffect(() => {
    if (!data || data.length === 0) return;
    if (!selectedId || !data.some((l) => l.id === selectedId)) {
      setSelectedId(data[0].id);
    }
  }, [data, selectedId]);

  const selected = data?.find((l) => l.id === selectedId) ?? null;

  async function createList() {
    const name = newName.trim();
    if (!name) return;
    const list = await shoppingCreateList(name);
    setNewName("");
    setSelectedId(list.id);
    await refresh();
  }

  async function deleteList(id: string) {
    await shoppingDeleteList(id);
    await refresh();
  }

  return (
    <div className="p-6">
      <div>
        <h1 className="text-2xl font-semibold text-zinc-100">Shopping Lists</h1>
        <p className="mt-1 text-sm text-zinc-400">
          Build named lists of items to buy. Add from here, or with the “add to
          list” buttons on Market Search, Production, Station Trading and
          Daytrading.
        </p>
      </div>

      <div className="mt-5 flex gap-6">
        {/* List selector. */}
        <div className="w-56 shrink-0">
          <div className="space-y-1">
            {(data ?? []).map((l) => (
              <div
                key={l.id}
                className={`group flex items-center rounded ${
                  l.id === selectedId ? "bg-zinc-800" : "hover:bg-zinc-900"
                }`}
              >
                <button
                  onClick={() => setSelectedId(l.id)}
                  className="flex-1 px-2 py-1 text-left text-sm text-zinc-200"
                >
                  {l.name}
                  <span className="ml-1 text-xs text-zinc-500">
                    {l.items.length}
                  </span>
                </button>
                {l.removable && (
                  <button
                    onClick={() => void deleteList(l.id)}
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
              onChange={(e) => setNewName(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void createList();
              }}
              placeholder="new list…"
              className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
            />
            <button
              onClick={() => void createList()}
              className="rounded border border-zinc-700 px-2 py-1 text-sm text-zinc-300 hover:bg-zinc-800"
            >
              +
            </button>
          </div>
        </div>

        {/* Selected list. */}
        <div className="min-w-0 flex-1">
          {selected ? (
            <ListDetail list={selected} onChange={refresh} />
          ) : (
            <p className="text-sm text-zinc-500">No list selected.</p>
          )}
        </div>
      </div>
    </div>
  );
}

// --- One list's items + add field ---

function ListDetail({
  list,
  onChange,
}: {
  list: ShoppingList;
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
  // Drop selections that no longer exist as the list changes.
  useEffect(() => {
    setSelected((prev) => {
      const ids = new Set(list.items.map((i) => i.typeId));
      const next = new Set([...prev].filter((id) => ids.has(id)));
      return next.size === prev.size ? prev : next;
    });
  }, [list.items]);
  const allSelected = list.items.length > 0 && selected.size === list.items.length;

  const toggle = (typeId: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(typeId)) next.delete(typeId);
      else next.add(typeId);
      return next;
    });
  const toggleAll = () =>
    setSelected((prev) =>
      prev.size === list.items.length ? new Set() : new Set(list.items.map((i) => i.typeId)),
    );

  async function bulkApply(mode: "multiply" | "add" | "set") {
    const n = Number(amount);
    if (!Number.isFinite(n) || selected.size === 0) return;
    for (const it of list.items) {
      if (!selected.has(it.typeId)) continue;
      const next =
        mode === "multiply" ? it.quantity * n : mode === "add" ? it.quantity + n : n;
      await shoppingSetQuantity(list.id, it.typeId, Math.max(1, Math.round(next)));
    }
    await onChange();
  }

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
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded border border-zinc-800 bg-zinc-900/40 px-2 py-1.5 text-xs">
          <span className="text-zinc-400">{selected.size} selected</span>
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.currentTarget.value)}
            placeholder="n"
            className="w-20 rounded bg-zinc-800 px-2 py-0.5 text-right text-zinc-100 outline-none placeholder:text-zinc-500"
          />
          <button
            onClick={() => void bulkApply("multiply")}
            disabled={amount.trim() === ""}
            title="Multiply each selected quantity by n"
            className="rounded border border-zinc-700 px-2 py-0.5 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          >
            × n
          </button>
          <button
            onClick={() => void bulkApply("add")}
            disabled={amount.trim() === ""}
            title="Add n to each selected quantity"
            className="rounded border border-zinc-700 px-2 py-0.5 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          >
            + n
          </button>
          <button
            onClick={() => void bulkApply("set")}
            disabled={amount.trim() === ""}
            title="Set each selected quantity to n"
            className="rounded border border-zinc-700 px-2 py-0.5 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          >
            set n
          </button>
          <button
            onClick={() => setSelected(new Set())}
            className="ml-auto rounded px-1.5 py-0.5 text-zinc-400 hover:text-zinc-200"
          >
            Clear selection
          </button>
        </div>
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
              <tr key={i.typeId} className="border-b border-zinc-900">
                <td className="py-1">
                  <input
                    type="checkbox"
                    checked={selected.has(i.typeId)}
                    onChange={() => toggle(i.typeId)}
                    aria-label={`Select ${i.name}`}
                  />
                </td>
                <td className="py-1 text-zinc-200">{i.name}</td>
                <td className="py-1 text-right">
                  <input
                    type="number"
                    min={1}
                    value={i.quantity}
                    onChange={(e) => {
                      const q = Number(e.currentTarget.value);
                      if (Number.isFinite(q)) void setQty(i.typeId, q);
                    }}
                    className="w-24 rounded bg-zinc-800 px-2 py-0.5 text-right text-zinc-100 outline-none"
                  />
                </td>
                <td className="py-1 text-right">
                  <button
                    onClick={() => void remove(i.typeId)}
                    title="Remove from list"
                    className="px-1 text-zinc-600 hover:text-red-400"
                  >
                    ✕
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr className="text-xs text-zinc-500">
              <td />
              <td className="py-1">{list.items.length} items</td>
              <td className="py-1 text-right">{totalQty.toLocaleString()}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      )}
    </div>
  );
}

// --- Search-to-add field (find an item, pick a quantity, add) ---

function SearchAddField({
  listId,
  onAdded,
}: {
  listId: string;
  onAdded: () => Promise<unknown>;
}) {
  const [q, setQ] = useState("");
  const [qty, setQty] = useState("1");
  const [busy, setBusy] = useState(false);

  const results = useQuery({
    queryKey: ["shopping", "search", q],
    queryFn: () => sdeSearch(q),
    enabled: q.trim().length >= 2,
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

// --- Bulk add field (Multibuy-style paste; only adds known items) ---

function AddItemField({
  listId,
  onAdded,
}: {
  listId: string;
  onAdded: () => Promise<unknown>;
}) {
  const [text, setText] = useState("");
  const [unresolved, setUnresolved] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);

  const parsed = useMemo(() => parseItems(text), [text]);

  async function add() {
    const lines = text.split("\n").map((raw) => ({ raw, parsed: parseLine(raw) }));
    const toAdd = lines.flatMap((l) => (l.parsed ? [l.parsed] : []));
    if (toAdd.length === 0 || busy) return;
    setBusy(true);
    try {
      const missed = await shoppingAddText(listId, toAdd);
      const missedSet = new Set(missed.map((m) => m.toLowerCase()));
      // Leave the rest: keep the original text of every line we didn't add —
      // unparseable lines, and parsed-but-unknown names (with their quantities).
      // Drop blanks and everything that landed.
      const remaining = lines
        .filter((l) => {
          if (!l.raw.trim()) return false;
          if (!l.parsed) return true;
          return missedSet.has(l.parsed.name.toLowerCase());
        })
        .map((l) => l.raw);
      setUnresolved(missed);
      setText(remaining.join("\n"));
      await onAdded();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-4">
      <textarea
        value={text}
        onChange={(e) => {
          setText(e.currentTarget.value);
          setUnresolved(null);
        }}
        onKeyDown={(e) => {
          // Ctrl/⌘+Enter adds; plain Enter keeps making new lines.
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            void add();
          }
        }}
        rows={5}
        placeholder={"Tritanium\t1000\nHobgoblin II\t5\nRifter"}
        className="w-full max-w-2xl resize-y rounded bg-zinc-800 px-3 py-2 font-mono text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
      />
      <div className="mt-2 flex items-center gap-3">
        <button
          onClick={() => void add()}
          disabled={parsed.length === 0 || busy}
          className="rounded border border-zinc-700 px-3 py-1 text-sm text-zinc-200 hover:bg-zinc-800 disabled:opacity-40"
        >
          Add {parsed.length > 0 ? `${parsed.length} line(s)` : "items"}
        </button>
        <span className="text-xs text-zinc-500">
          Paste Multibuy or inventory (<code>name … qty</code>, extra columns
          ignored) · unmatched lines stay · Ctrl/⌘+Enter to add
        </span>
      </div>
      {unresolved && unresolved.length > 0 && (
        <p className="mt-2 text-xs text-amber-400">
          Couldn't find {unresolved.length} item(s) — left in the box to fix:{" "}
          {unresolved.join(", ")}
        </p>
      )}
    </div>
  );
}

