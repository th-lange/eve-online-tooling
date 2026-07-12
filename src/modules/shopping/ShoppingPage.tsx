import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";

import { SHOPPING_LISTS_KEY } from "../../lib/queryKeys";
import { useCopyToClipboard } from "../../lib/useCopyToClipboard";
import { parseItems, parseLine } from "./parse";
import {
  eveDefaultLogDir,
  sdeSearch,
  shoppingAddItem,
  shoppingAddText,
  shoppingChatSync,
  shoppingClearList,
  shoppingCreateList,
  shoppingDeleteList,
  shoppingLists,
  shoppingMoveItem,
  shoppingRemoveItem,
  shoppingSetQuantity,
  type ShoppingList,
} from "../../lib/api";
import { formatInt } from "../../lib/format";
import { STORAGE_KEYS } from "../../lib/storageKeys";
import { Page, PageHeader } from "../../components/page";

/**
 * Shopping Lists — a group of named lists you fill while browsing other modules.
 * The `default` and `production` lists are built in and can't be removed; you
 * can add more. Each list holds items + quantities; add items here via the
 * known-item search field, or from the "add to list" buttons on Market Search,
 * Production, Station Trading and Daytrading.
 */
export function ShoppingPage() {
  const qc = useQueryClient();
  const lists = useQuery({
    queryKey: SHOPPING_LISTS_KEY,
    queryFn: shoppingLists,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  // Lists that changed while not being viewed (e.g. a chat import into another
  // list) — surfaced with a dot in the selector, cleared when the list is opened.
  const [changed, setChanged] = useState<Set<string>>(new Set());

  const refresh = useCallback(
    () => qc.invalidateQueries({ queryKey: SHOPPING_LISTS_KEY }),
    [qc],
  );

  // Keep a valid selection as lists load / change.
  const data = lists.data;
  useEffect(() => {
    if (!data || data.length === 0) return;
    if (!selectedId || !data.some((l) => l.id === selectedId)) {
      setSelectedId(data[0].id);
    }
  }, [data, selectedId]);

  // Flag any not-currently-viewed list whose contents changed between refetches.
  // Signatures are per-item `typeId:qty`, so an added item or quantity bump both
  // count. The first populate seeds signatures without flagging anything.
  const sigRef = useRef<Map<string, string>>(new Map());
  useEffect(() => {
    if (!data) return;
    const prev = sigRef.current;
    const next = new Map<string, string>();
    const newlyChanged: string[] = [];
    for (const l of data) {
      const sig = l.items.map((i) => `${i.typeId}:${i.quantity}`).join(",");
      next.set(l.id, sig);
      const before = prev.get(l.id);
      if (before !== undefined && before !== sig && l.id !== selectedId) {
        newlyChanged.push(l.id);
      }
    }
    sigRef.current = next;
    if (newlyChanged.length > 0) {
      setChanged((prevSet) => {
        const s = new Set(prevSet);
        for (const id of newlyChanged) s.add(id);
        return s;
      });
    }
  }, [data, selectedId]);

  // Opening a list clears its "changed" dot.
  useEffect(() => {
    if (!selectedId) return;
    setChanged((prev) => {
      if (!prev.has(selectedId)) return prev;
      const s = new Set(prev);
      s.delete(selectedId);
      return s;
    });
  }, [selectedId]);

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
    <Page>
      <PageHeader
        title="Shopping Lists"
        subtitle={
          <>
            Build named lists of items to buy. Add from here, or with the
            “add to list” buttons on Market Search, Production, Station
            Trading and Daytrading.
          </>
        }
      />

      <ChatCapture onSync={refresh} lists={data ?? []} />

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
            <ListDetail
              list={selected}
              allLists={data ?? []}
              onChange={refresh}
            />
          ) : (
            <p className="text-sm text-zinc-500">No list selected.</p>
          )}
        </div>
      </div>
    </Page>
  );
}

// --- Chat capture: listen to an EVE chat channel and collect linked items ---

function ChatCapture({
  onSync,
  lists,
}: {
  onSync: () => Promise<unknown>;
  lists: ShoppingList[];
}) {
  const [channel, setChannel] = useState("");
  const [logsDir, setLogsDir] = useState(
    () => localStorage.getItem(STORAGE_KEYS.eveChatlogsDir) ?? "",
  );
  const [listening, setListening] = useState(false);
  const [status, setStatus] = useState("");
  const [total, setTotal] = useState(0);
  const { copied, copy } = useCopyToClipboard(1500);
  // True until the first poll of a session, so we skip pre-existing log content.
  const fromNow = useRef(false);

  // Where captured items go. Defaults to the built-in Chat list, which we always
  // offer even before it exists (it's created on first import). Persisted.
  const [targetId, setTargetId] = useState(
    () => localStorage.getItem(STORAGE_KEYS.shoppingChatTarget) ?? "chat",
  );
  const targetOptions = useMemo(() => {
    const opts = lists.map((l) => ({ id: l.id, name: l.name }));
    if (!opts.some((o) => o.id === "chat"))
      opts.unshift({ id: "chat", name: "Chat" });
    return opts;
  }, [lists]);
  // If the chosen list was deleted, fall back to Chat.
  useEffect(() => {
    if (!targetOptions.some((o) => o.id === targetId)) setTargetId("chat");
  }, [targetOptions, targetId]);
  // Read inside the poll without resubscribing the interval on every change.
  const targetRef = useRef(targetId);
  useEffect(() => {
    targetRef.current = targetId;
    localStorage.setItem(STORAGE_KEYS.shoppingChatTarget, targetId);
  }, [targetId]);

  // Suggest the Chatlogs folder if we don't have one saved.
  useEffect(() => {
    if (!logsDir) eveDefaultLogDir("chatlogs").then((d) => d && setLogsDir(d));
  }, [logsDir]);

  // Poll the channel's log while listening.
  useEffect(() => {
    if (!listening || !channel.trim() || !logsDir.trim()) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const first = fromNow.current;
        fromNow.current = false;
        const r = await shoppingChatSync(
          logsDir,
          channel.trim(),
          first,
          targetRef.current,
        );
        if (cancelled) return;
        setStatus(
          r.found
            ? `listening to ${r.file}`
            : "waiting for the channel log (create the channel in EVE)…",
        );
        if (r.added.length) {
          setTotal((t) => t + r.added.length);
          await onSync();
        }
      } catch (e) {
        if (!cancelled) setStatus(String(e));
      }
    };
    void poll();
    const timer = setInterval(() => void poll(), 4000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [listening, channel, logsDir, onSync]);

  function generate() {
    setChannel(`buy-${crypto.randomUUID().slice(0, 8)}`);
  }
  function toggle() {
    if (!listening) {
      localStorage.setItem(STORAGE_KEYS.eveChatlogsDir, logsDir.trim());
      setTotal(0);
      fromNow.current = true;
    }
    setListening((v) => !v);
  }

  return (
    <details className="mt-4 rounded-lg border border-zinc-800 bg-zinc-900/40">
      <summary className="cursor-pointer px-4 py-2 text-sm text-zinc-300">
        Capture items from an EVE chat channel
      </summary>
      <div className="space-y-3 px-4 pb-4 text-sm">
        <p className="text-xs text-zinc-500">
          Point at any EVE chat channel and each item posted into it is added to
          the list you pick below (the{" "}
          <span className="text-zinc-300">Chat</span> list by default). Make a
          private channel for buy orders, or listen to a standing one like{" "}
          <span className="text-zinc-300">Corp</span>. Paste several items at
          once — <span className="text-zinc-300">one item per line</span>, with
          an optional quantity after the name (
          <span className="text-zinc-300">Tritanium 100</span>, Multibuy
          tab-format works too). Anything that isn't a known item name is
          ignored, and only messages after you press Start are captured. The same
          item re-posted by the same person within a few seconds is treated as a
          duplicate and skipped.
        </p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Channel name
            <div className="flex gap-1">
              <input
                value={channel}
                onChange={(e) => setChannel(e.currentTarget.value)}
                placeholder="channel name…"
                disabled={listening}
                className="w-56 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none disabled:opacity-60"
              />
              <button
                onClick={generate}
                disabled={listening}
                title="Generate a random channel name"
                className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
              >
                Random
              </button>
              {(["Corp", "Alliance", "Fleet"] as const).map((c) => (
                <button
                  key={c}
                  onClick={() => setChannel(c)}
                  disabled={listening}
                  title={`Listen to the ${c} channel`}
                  className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
                >
                  {c}
                </button>
              ))}
              <button
                onClick={() => copy(channel)}
                disabled={!channel}
                title="Copy the channel name"
                className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
              >
                {copied ? "Copied ✓" : "Copy"}
              </button>
            </div>
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Import to
            <select
              value={targetId}
              onChange={(e) => setTargetId(e.currentTarget.value)}
              title="Which list captured items are added to"
              className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
            >
              {targetOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.name}
                </option>
              ))}
            </select>
          </label>
          <button
            onClick={toggle}
            disabled={!channel.trim() || !logsDir.trim()}
            className={`rounded px-3 py-1.5 text-sm disabled:opacity-40 ${
              listening
                ? "bg-red-600/80 text-white hover:bg-red-600"
                : "bg-sky-600 text-white hover:bg-sky-500"
            }`}
          >
            {listening ? "Stop" : "Start listening"}
          </button>
        </div>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          EVE Chatlogs folder
          <input
            value={logsDir}
            onChange={(e) => setLogsDir(e.currentTarget.value)}
            placeholder="…/EVE/logs/Chatlogs"
            className="w-full max-w-xl rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
          />
        </label>
        {listening && (
          <div className="text-xs text-zinc-500">
            <span className="mr-2 inline-block h-2 w-2 animate-pulse rounded-full bg-emerald-400 align-middle" />
            {status || "starting…"} · {total} item
            {total === 1 ? "" : "s"} captured
          </div>
        )}
      </div>
    </details>
  );
}

// --- One list's items + add field ---

function ListDetail({
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
    for (const it of list.items) {
      if (!selected.has(it.typeId)) continue;
      const next =
        mode === "multiply"
          ? it.quantity * n
          : mode === "add"
            ? it.quantity + n
            : n;
      await shoppingSetQuantity(
        list.id,
        it.typeId,
        Math.max(1, Math.round(next)),
      );
    }
    await onChange();
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
    for (const it of list.items) {
      if (selected.has(it.typeId))
        await shoppingMoveItem(list.id, toId, it.typeId);
    }
    setSelected(new Set());
    await onChange();
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
        <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/40 px-3 py-2.5 text-sm">
          <span className="font-medium text-zinc-300">
            {selected.size} selected
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
              onClick={() => void applyToSelected(mode, n)}
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
            onChange={(e) => setAmount(e.currentTarget.value)}
            placeholder="n"
            className="w-24 rounded bg-zinc-800 px-2 py-1 text-right text-zinc-100 outline-none placeholder:text-zinc-500"
          />
          <button
            onClick={() => void bulkApply("multiply")}
            disabled={amount.trim() === ""}
            title="Multiply each selected quantity by n"
            className="rounded border border-zinc-700 px-3 py-1 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          >
            × n
          </button>
          <button
            onClick={() => void bulkApply("add")}
            disabled={amount.trim() === ""}
            title="Add n to each selected quantity"
            className="rounded border border-zinc-700 px-3 py-1 text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          >
            + n
          </button>
          <button
            onClick={() => void bulkApply("set")}
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
                void moveSelected(e.currentTarget.value);
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
            onClick={() => setSelected(new Set())}
            className="ml-auto rounded px-2 py-1 text-zinc-400 hover:text-zinc-200"
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
              <td className="py-1 text-right">{formatInt(totalQty)}</td>
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
    const lines = text
      .split("\n")
      .map((raw) => ({ raw, parsed: parseLine(raw) }));
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
