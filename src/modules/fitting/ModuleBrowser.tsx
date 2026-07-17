import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Plus, X } from "lucide-react";
import {
  fittingModuleInfo,
  sdeMarketGroupChildren,
  type MarketGroupNode,
  type SkillSource,
  type SlotKind,
} from "../../lib/api";
import { sdeKeys } from "../../lib/queryKeys";
import {
  SLOT_BADGE,
  fitReason,
  fuzzyScore,
  moduleFits,
  type FitContext,
} from "./fitHelpers";
import { SlotBadge } from "./SlotGrid";

/**
 * Click-to-add module browser: search marketable types by name and add the pick
 * to the fit. The backend classifies the slot, so any module lands in the right
 * place (the slot grid above reflects it immediately) (#168).
 */
export function ModuleBrowser({
  onAdd,
  pending,
  slotFilter,
  onSlotFilter,
  fitContext,
  shipTypeId,
  skillSource,
}: {
  onAdd: (typeId: number) => void;
  pending: boolean;
  slotFilter: SlotKind | null;
  onSlotFilter: (slot: SlotKind | null) => void;
  fitContext: FitContext | null;
  shipTypeId: number;
  skillSource: SkillSource;
}) {
  const [q, setQ] = useState("");
  const [mode, setMode] = useState<"search" | "browse">("search");
  const inputRef = useRef<HTMLInputElement>(null);
  // Focus the search when a slot is picked from the grid (and leave browse mode).
  useEffect(() => {
    if (slotFilter) {
      setMode("search");
      inputRef.current?.focus();
    }
  }, [slotFilter]);

  const results = useQuery({
    ...sdeKeys.search(q),
    enabled: q.trim().length >= 2,
  });
  const matches = (results.data ?? []).slice(0, 40);
  // Slot + fitting cost of each result, to badge the slot and rank by what fits.
  const ids = useMemo(() => matches.map((r) => r.id), [matches]);
  const info = useQuery({
    queryKey: ["fitting", "module-info", shipTypeId, skillSource, ids],
    queryFn: () => fittingModuleInfo(shipTypeId, skillSource, ids),
    enabled: ids.length > 0,
  });
  const infoOf = useMemo(
    () => new Map((info.data ?? []).map((m) => [m.id, m])),
    [info.data],
  );
  // Slot-filter (when a slot was clicked), then fuzzy-rank, then split into what
  // fits the hull now vs what doesn't — fitting first, non-fitting shown muted.
  const { fitRows, noFitRows } = useMemo(() => {
    const ranked = (
      slotFilter
        ? matches.filter((r) => infoOf.get(r.id)?.slot === slotFilter)
        : matches
    )
      .slice()
      .sort(
        (a, b) =>
          fuzzyScore(a.name, q) - fuzzyScore(b.name, q) ||
          a.name.length - b.name.length,
      );
    return {
      fitRows: ranked
        .filter((r) => moduleFits(infoOf.get(r.id), fitContext))
        .slice(0, 30),
      noFitRows: ranked
        .filter((r) => !moduleFits(infoOf.get(r.id), fitContext))
        .slice(0, 20),
    };
  }, [matches, infoOf, slotFilter, fitContext, q]);
  const nothingShown = fitRows.length === 0 && noFitRows.length === 0;
  return (
    <div className="mt-4 rounded border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs uppercase tracking-wide text-zinc-500">
        Add module
        {slotFilter && (
          <button
            onClick={() => onSlotFilter(null)}
            title="Clear slot filter"
            className="flex items-center gap-1 rounded-full border border-zinc-700 bg-zinc-800 px-1.5 py-0.5 normal-case text-zinc-200 hover:border-zinc-600"
          >
            {SLOT_BADGE[slotFilter] ?? slotFilter} only
            <X size={11} className="text-zinc-400" />
          </button>
        )}
        {/* Search ↔ Browse toggle (browse drills the market-group tree, #266). */}
        <div className="ml-auto flex gap-1 normal-case">
          {(["search", "browse"] as const).map((m) => (
            <button
              key={m}
              onClick={() => setMode(m)}
              className={`rounded px-2 py-0.5 capitalize ${
                mode === m
                  ? "bg-zinc-700 text-zinc-100"
                  : "text-zinc-400 hover:text-zinc-200"
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {mode === "search" ? (
        <>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            placeholder={
              slotFilter
                ? `search a ${SLOT_BADGE[slotFilter] ?? slotFilter} module…`
                : "search a module, charge or drone…"
            }
            className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
          />
          {q.trim().length >= 2 && (
            <ul className="mt-2 max-h-56 overflow-y-auto text-sm">
              {fitRows.map((r) => (
                <li key={r.id}>
                  <button
                    disabled={pending}
                    onClick={() => onAdd(r.id)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                  >
                    <span className="flex-1 truncate">{r.name}</span>
                    <SlotBadge slot={infoOf.get(r.id)?.slot} />
                    <Plus size={14} className="shrink-0 text-zinc-500" />
                  </button>
                </li>
              ))}
              {noFitRows.length > 0 && (
                <li className="px-2 pb-0.5 pt-2 text-[10px] uppercase tracking-wide text-zinc-600">
                  Won't fit
                </li>
              )}
              {noFitRows.map((r) => (
                <li key={r.id}>
                  <button
                    disabled={pending}
                    onClick={() => onAdd(r.id)}
                    title="Doesn't fit the hull right now — add anyway"
                    className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-zinc-500 hover:bg-zinc-800 disabled:opacity-50"
                  >
                    <span className="flex-1 truncate">{r.name}</span>
                    <span className="shrink-0 text-[10px] uppercase text-amber-500/70">
                      {fitReason(infoOf.get(r.id), fitContext)}
                    </span>
                    <SlotBadge slot={infoOf.get(r.id)?.slot} />
                    <Plus size={14} className="shrink-0 text-zinc-600" />
                  </button>
                </li>
              ))}
              {results.isFetched && nothingShown && (
                <li className="px-2 py-1 text-xs text-zinc-500">
                  {slotFilter && matches.length > 0
                    ? `No ${SLOT_BADGE[slotFilter] ?? slotFilter} modules match.`
                    : "No matches."}
                </li>
              )}
            </ul>
          )}
        </>
      ) : (
        <BrowseTree
          onAdd={onAdd}
          pending={pending}
          slotFilter={slotFilter}
          fitContext={fitContext}
          shipTypeId={shipTypeId}
          skillSource={skillSource}
        />
      )}
    </div>
  );
}

/**
 * Browse-by-category picker (#266): drill EVE's market-group tree one level at a
 * time (Ship Equipment → Shield Hardeners → Multispectrum… → add), with a
 * breadcrumb to step back. Leaf items show their slot badge + meta variant and
 * respect the active slot filter — the same landing rules as search.
 */
export function BrowseTree({
  onAdd,
  pending,
  slotFilter,
  fitContext,
  shipTypeId,
  skillSource,
}: {
  onAdd: (typeId: number) => void;
  pending: boolean;
  slotFilter: SlotKind | null;
  fitContext: FitContext | null;
  shipTypeId: number;
  skillSource: SkillSource;
}) {
  const [path, setPath] = useState<MarketGroupNode[]>([]);
  const [showAll, setShowAll] = useState(false);
  const parentId = path.length ? path[path.length - 1].id : null;
  const level = useQuery({
    queryKey: ["fitting", "mg-tree", parentId],
    queryFn: () => sdeMarketGroupChildren(parentId),
  });
  const items = useMemo(() => level.data?.items ?? [], [level.data]);
  const ids = useMemo(() => items.map((i) => i.id), [items]);
  const info = useQuery({
    queryKey: ["fitting", "module-info", shipTypeId, skillSource, ids],
    queryFn: () => fittingModuleInfo(shipTypeId, skillSource, ids),
    enabled: ids.length > 0,
  });
  const infoOf = useMemo(
    () => new Map((info.data ?? []).map((m) => [m.id, m])),
    [info.data],
  );
  // Slot-filter (when a slot was clicked), then — unless "show all" is on — keep
  // only leaves that actually fit the hull's free slots + resources right now.
  const slotItems = slotFilter
    ? items.filter((i) => infoOf.get(i.id)?.slot === slotFilter)
    : items;
  const shownItems = showAll
    ? slotItems
    : slotItems.filter((i) => moduleFits(infoOf.get(i.id), fitContext));
  const hiddenCount = slotItems.length - shownItems.length;
  const groups = level.data?.groups ?? [];

  return (
    <div>
      {/* Breadcrumb */}
      <div className="mb-2 flex flex-wrap items-center gap-1 text-xs text-zinc-400">
        <button
          onClick={() => setPath([])}
          className={path.length ? "hover:text-zinc-200" : "text-zinc-200"}
        >
          All
        </button>
        {path.map((g, i) => (
          <span key={g.id} className="flex items-center gap-1">
            <span className="text-zinc-600">›</span>
            <button
              onClick={() => setPath(path.slice(0, i + 1))}
              className={
                i === path.length - 1 ? "text-zinc-200" : "hover:text-zinc-200"
              }
            >
              {g.name}
            </button>
          </span>
        ))}
      </div>

      {level.isLoading ? (
        <p className="px-1 py-2 text-xs text-zinc-500">Loading…</p>
      ) : (
        <div className="max-h-72 overflow-y-auto text-sm">
          {/* Child groups → drill deeper */}
          {groups.map((g) => (
            <button
              key={`g${g.id}`}
              onClick={() => setPath([...path, g])}
              className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-zinc-200 hover:bg-zinc-800"
            >
              <span className="flex-1 truncate">{g.name}</span>
              <span className="shrink-0 text-zinc-600">›</span>
            </button>
          ))}

          {/* Leaf items, grouped by meta variant */}
          {shownItems.map((it, i) => {
            const newMeta =
              i === 0 || shownItems[i - 1].metaGroup !== it.metaGroup;
            return (
              <div key={`i${it.id}`}>
                {newMeta && (
                  <div className="mt-1 px-2 pb-0.5 pt-1 text-[10px] uppercase tracking-wide text-zinc-500">
                    {it.metaGroup}
                  </div>
                )}
                <button
                  disabled={pending}
                  onClick={() => onAdd(it.id)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                >
                  <span className="flex-1 truncate">{it.name}</span>
                  <SlotBadge slot={infoOf.get(it.id)?.slot} />
                  <Plus size={14} className="shrink-0 text-zinc-500" />
                </button>
              </div>
            );
          })}

          {/* Hidden = present in this group but won't fit the hull right now. */}
          {hiddenCount > 0 && (
            <button
              onClick={() => setShowAll((v) => !v)}
              className="mt-1 px-2 py-1 text-xs text-zinc-500 hover:text-zinc-300"
            >
              {showAll
                ? "Hide ones that won't fit"
                : `Show ${hiddenCount} that won't fit`}
            </button>
          )}

          {groups.length === 0 && slotItems.length === 0 && (
            <p className="px-2 py-2 text-xs text-zinc-500">
              {slotFilter && items.length > 0
                ? `No ${SLOT_BADGE[slotFilter] ?? slotFilter} items here.`
                : "Nothing here."}
            </p>
          )}
          {groups.length === 0 &&
            slotItems.length > 0 &&
            shownItems.length === 0 &&
            !showAll && (
              <p className="px-2 py-2 text-xs text-zinc-500">
                Nothing here fits the hull right now.
              </p>
            )}
        </div>
      )}
    </div>
  );
}
