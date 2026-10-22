import { useCallback, useEffect, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { SHOPPING_LISTS_KEY } from "../../lib/queryKeys";
import {
  shoppingCreateList,
  shoppingDeleteList,
  shoppingLists,
} from "../../lib/api";
import { Page, PageHeader } from "../../components/page";

import { ChatCapture } from "./ChatCapture";
import { ListDetail } from "./ListDetail";
import { ListSidebar } from "./ListSidebar";

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
            Build named lists of items to buy. Add from here, or with the “add
            to list” buttons on Market Search, Production, Station Trading and
            Daytrading.
          </>
        }
      />

      <ChatCapture onSync={refresh} lists={data ?? []} />

      <div className="mt-5 flex gap-6">
        <ListSidebar
          lists={data ?? []}
          selectedId={selectedId}
          onSelect={setSelectedId}
          changed={changed}
          onDelete={(id) => void deleteList(id)}
          newName={newName}
          onNewNameChange={setNewName}
          onCreate={() => void createList()}
        />

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
