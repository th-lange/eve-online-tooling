import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Crosshair, Plus, Power, X } from "lucide-react";
import {
  fittingCompatibleCharges,
  fittingModuleInfo,
  sdeMarketGroupChildren,
  sdeSearch,
  type CapStats,
  type EwTag,
  type Fit,
  type FitItem,
  type MarketGroupNode,
  type ModuleInfo,
  type ModuleState,
  type SkillSource,
  type SlotKind,
  type TankStats,
  type WeaponRange,
} from "../../lib/api";
import { formatDuration } from "../../lib/format";

// Presentational components + fit helpers extracted from FittingPage (#341).

const SLOT_LABELS: [SlotKind, string][] = [
  ["high", "High"],
  ["mid", "Mid"],
  ["low", "Low"],
  ["rig", "Rig"],
  ["subsystem", "Subsystem"],
  ["implant", "Implants"],
  ["drone", "Drones"],
  ["cargo", "Cargo"],
];

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
    queryKey: ["fitting", "module-search", q],
    queryFn: () => sdeSearch(q),
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
      fitRows: ranked.filter((r) => moduleFits(infoOf.get(r.id), fitContext)).slice(0, 30),
      noFitRows: ranked.filter((r) => !moduleFits(infoOf.get(r.id), fitContext)).slice(0, 20),
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
            const newMeta = i === 0 || shownItems[i - 1].metaGroup !== it.metaGroup;
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
              {showAll ? "Hide ones that won't fit" : `Show ${hiddenCount} that won't fit`}
            </button>
          )}

          {groups.length === 0 && slotItems.length === 0 && (
            <p className="px-2 py-2 text-xs text-zinc-500">
              {slotFilter && items.length > 0
                ? `No ${SLOT_BADGE[slotFilter] ?? slotFilter} items here.`
                : "Nothing here."}
            </p>
          )}
          {groups.length === 0 && slotItems.length > 0 && shownItems.length === 0 && !showAll && (
            <p className="px-2 py-2 text-xs text-zinc-500">
              Nothing here fits the hull right now.
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Add modules projected **onto** this fit (webs/paints/damps/…) — incoming
 * effects from a notional attacker, modelled at all-V. Search-to-add plus a
 * removable list; the stats recompute with the projected effects applied (#178).
 */
export function ProjectedPanel({
  projected,
  nameOf,
  onAdd,
  onRemove,
}: {
  projected: FitItem[];
  nameOf: (id: number) => string;
  onAdd: (typeId: number) => void;
  onRemove: (idx: number) => void;
}) {
  const [q, setQ] = useState("");
  const results = useQuery({
    queryKey: ["fitting", "proj-search", q],
    queryFn: () => sdeSearch(q),
    enabled: q.trim().length >= 2,
  });
  return (
    <div className="mt-4 rounded border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="mb-2 text-xs uppercase tracking-wide text-zinc-500">
        Projected onto this fit
      </div>
      {projected.length > 0 && (
        <ul className="mb-2 text-sm text-zinc-300">
          {projected.map((it, i) => (
            <li
              key={i}
              className="group flex items-center gap-2 rounded px-1 py-0.5 hover:bg-zinc-800/70"
            >
              <button
                onClick={() => onRemove(i)}
                className="flex shrink-0 items-center rounded p-0.5 text-zinc-500 group-hover:text-red-400"
                title="Remove projection"
                aria-label={`Remove ${nameOf(it.typeId)}`}
              >
                <X size={14} />
              </button>
              <span className="truncate">{nameOf(it.typeId)}</span>
            </li>
          ))}
        </ul>
      )}
      <input
        value={q}
        onChange={(e) => setQ(e.currentTarget.value)}
        placeholder="project a web, painter, damp…"
        className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
      />
      {q.trim().length >= 2 && (
        <ul className="mt-2 max-h-40 overflow-y-auto text-sm">
          {(results.data ?? []).slice(0, 20).map((r) => (
            <li key={r.id}>
              <button
                onClick={() => {
                  onAdd(r.id);
                  setQ("");
                }}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-zinc-200 hover:bg-zinc-800"
              >
                <span className="flex-1 truncate">{r.name}</span>
                <Plus size={14} className="shrink-0 text-zinc-500" />
              </button>
            </li>
          ))}
          {results.isFetched && (results.data?.length ?? 0) === 0 && (
            <li className="px-2 py-1 text-xs text-zinc-500">No matches.</li>
          )}
        </ul>
      )}
    </div>
  );
}

/** What the hull has free right now, for deciding whether a candidate fits. */
export interface FitContext {
  /** Open slots per kind (kinds without a hard cap — drone/cargo/… — are absent). */
  freeSlots: Partial<Record<SlotKind, number>>;
  /** Remaining CPU / powergrid / rig-calibration. */
  cpu: number;
  pg: number;
  calibration: number;
}

export const FIT_EPS = 1e-6;

/** Does this module fit the hull's free slots + remaining resources? Unknown
 *  info or no context ⇒ treated as fitting (don't gray things out prematurely). */
export function moduleFits(info: ModuleInfo | undefined, ctx: FitContext | null): boolean {
  return fitReason(info, ctx) === null;
}

/** Why a module won't fit (`"no slot"` / `"CPU"` / `"PG"` / `"calibration"`), or
 *  null when it fits. */
export function fitReason(info: ModuleInfo | undefined, ctx: FitContext | null): string | null {
  if (!info || !ctx) return null;
  const free = ctx.freeSlots[info.slot];
  if (free !== undefined && free <= 0) return "no slot";
  if (info.cpu > ctx.cpu + FIT_EPS) return "CPU";
  if (info.powergrid > ctx.pg + FIT_EPS) return "PG";
  if (info.slot === "rig" && info.calibration > ctx.calibration + FIT_EPS) return "calibration";
  return null;
}

/** Lower = better fuzzy match of `name` against the (already term-filtered)
 *  query: prefix beats substring beats scattered terms; ties broken by length. */
export function fuzzyScore(name: string, q: string): number {
  const n = name.toLowerCase();
  const query = q.toLowerCase().trim();
  if (!query) return 0;
  if (n.startsWith(query)) return 0;
  const idx = n.indexOf(query);
  if (idx >= 0) return 1 + idx / 1000;
  let s = 3;
  for (const t of query.split(/\s+/)) {
    const i = n.indexOf(t);
    s += i >= 0 ? i / 1000 : 5;
  }
  return s;
}

/** Metres → a compact "X.X km" label. */
export function km(metres: number): string {
  const v = metres / 1000;
  return `${v >= 100 ? Math.round(v) : v.toFixed(1)} km`;
}

export const DAMAGE_TYPES = ["EM", "Th", "Kin", "Exp"] as const;

/** A resist % cell, tinted greener the higher the resistance (spot tank holes). */
export function resistClass(v: number): string {
  if (v >= 0.5) return "text-emerald-400";
  if (v >= 0.3) return "text-emerald-500/80";
  if (v > 0) return "text-zinc-300";
  return "text-zinc-600";
}

/** Per-layer HP + EM/Th/Kin/Exp resistances for shield, armor and hull. */
export function TankResists({ tank }: { tank: TankStats }) {
  const layers = [
    { name: "Shield", hp: tank.shieldHp, r: tank.shieldResists },
    { name: "Armor", hp: tank.armorHp, r: tank.armorResists },
    { name: "Hull", hp: tank.hullHp, r: tank.hullResists },
  ];
  return (
    <table className="w-full text-[11px] tabular-nums">
      <thead>
        <tr className="text-zinc-600">
          <th className="text-left font-normal" />
          <th className="pr-1 text-right font-normal">HP</th>
          {DAMAGE_TYPES.map((d) => (
            <th key={d} className="pl-1 text-right font-normal">
              {d}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {layers.map((l) => (
          <tr key={l.name}>
            <td className="text-zinc-300">{l.name}</td>
            <td className="pr-1 text-right text-zinc-400">
              {Math.round(l.hp).toLocaleString()}
            </td>
            {l.r.map((v, i) => (
              <td key={i} className={`pl-1 text-right ${resistClass(v)}`}>
                {Math.round(v * 100)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export const SLOT_BADGE: Partial<Record<SlotKind, string>> = {
  high: "High",
  mid: "Mid",
  low: "Low",
  rig: "Rig",
  subsystem: "Sub",
  implant: "Implant",
  drone: "Drone",
  cargo: "Cargo",
};

/** A small slot tag (High/Mid/Low/…) shown next to a search result. */
export function SlotBadge({ slot }: { slot?: SlotKind }) {
  if (!slot) return null;
  const label = SLOT_BADGE[slot] ?? slot;
  return (
    <span className="shrink-0 rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
      {label}
    </span>
  );
}

/**
 * Per-weapon ammo picker (a small crosshair on hover, amber when loaded). Opens
 * a popover listing only charges that actually load into this module (right
 * group + size + capacity), so you can't pick incompatible ammo. Selecting sets
 * the charge; "Remove ammo" clears it.
 */
export function ChargeControl({
  typeId,
  chargeTypeId,
  sameTypeCount,
  onSetCharge,
  onSetChargeAll,
}: {
  typeId: number;
  chargeTypeId: number | null;
  /** How many fitted weapons share this type (for the "apply to all" option). */
  sameTypeCount: number;
  onSetCharge: (chargeTypeId: number | null) => void;
  onSetChargeAll: (chargeTypeId: number | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [all, setAll] = useState(false);
  const [q, setQ] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // Focus the filter when the popover opens; clear it when it closes.
  useEffect(() => {
    if (open) inputRef.current?.focus();
    else setQ("");
  }, [open]);
  const charges = useQuery({
    queryKey: ["fitting", "charges", typeId],
    queryFn: () => fittingCompatibleCharges(typeId),
    enabled: open,
  });
  const allCharges = charges.data ?? [];
  const list = q.trim()
    ? allCharges.filter((c) => c.name.toLowerCase().includes(q.toLowerCase().trim()))
    : allCharges;
  // Pick on one weapon or all of this type, depending on the toggle.
  const apply = (c: number | null) => {
    (all ? onSetChargeAll : onSetCharge)(c);
    setOpen(false);
  };
  return (
    <span className="relative ml-auto shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        title={chargeTypeId ? "Change ammo / charge" : "Add ammo / charge"}
        className={`flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] ${
          chargeTypeId
            ? "border-amber-700/60 text-amber-400 hover:bg-amber-900/20"
            : "border-zinc-700 text-zinc-400 hover:border-zinc-600 hover:text-amber-300"
        }`}
      >
        <Crosshair size={11} />
        {chargeTypeId ? "ammo" : "add ammo"}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-1 max-h-72 w-56 overflow-y-auto rounded border border-zinc-700 bg-zinc-900 p-1 shadow-lg">
            {sameTypeCount > 1 && (
              <label className="flex items-center gap-2 border-b border-zinc-800 px-2 py-1 text-xs text-zinc-400">
                <input
                  type="checkbox"
                  checked={all}
                  onChange={(e) => setAll(e.currentTarget.checked)}
                  className="accent-amber-500"
                />
                Apply to all {sameTypeCount}
              </label>
            )}
            {allCharges.length > 0 && (
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => setQ(e.currentTarget.value)}
                placeholder="filter ammo…"
                className="mb-1 w-full rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-100 outline-none placeholder:text-zinc-500"
              />
            )}
            {charges.isLoading ? (
              <div className="px-2 py-1 text-xs text-zinc-500">Loading…</div>
            ) : allCharges.length === 0 ? (
              <div className="px-2 py-1 text-xs text-zinc-500">
                No compatible charges.
              </div>
            ) : list.length === 0 ? (
              <div className="px-2 py-1 text-xs text-zinc-500">No matches.</div>
            ) : (
              <ul>
                {chargeTypeId && (
                  <li>
                    <button
                      onClick={() => apply(null)}
                      className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-zinc-400 hover:bg-zinc-800"
                    >
                      <X size={12} /> Remove ammo
                    </button>
                  </li>
                )}
                {list.map((c) => (
                  <li key={c.id}>
                    <button
                      onClick={() => apply(c.id)}
                      className={`block w-full truncate rounded px-2 py-1 text-left hover:bg-zinc-800 ${
                        c.id === chargeTypeId ? "text-amber-400" : "text-zinc-200"
                      }`}
                    >
                      {c.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </span>
  );
}

export function SlotGrid({
  fit,
  layout,
  nameOf,
  onRemove,
  onAddToSlot,
  onSetCharge,
  onSetChargeForType,
  onSetState,
  rangeOf,
  activatable,
}: {
  fit: Fit;
  layout: { highSlots: number; midSlots: number; lowSlots: number; rigSlots: number };
  nameOf: (id: number) => string;
  onRemove: (globalIndex: number) => void;
  onAddToSlot: (slot: SlotKind) => void;
  onSetCharge: (globalIndex: number, chargeTypeId: number | null) => void;
  onSetChargeForType: (weaponTypeId: number, chargeTypeId: number | null) => void;
  onSetState: (globalIndex: number, state: ModuleState) => void;
  rangeOf: Map<string, WeaponRange>;
  activatable: Set<number>;
}) {
  const counts: Partial<Record<SlotKind, number>> = {
    high: layout.highSlots,
    mid: layout.midSlots,
    low: layout.lowSlots,
    rig: layout.rigSlots,
  };
  return (
    <div className="space-y-3">
      {SLOT_LABELS.map(([slot, label]) => {
        const items = fit.items
          .map((it, i) => ({ it, i }))
          .filter((x) => x.it.slot === slot)
          .sort((a, b) => a.it.index - b.it.index);
        const cap = counts[slot];
        if (items.length === 0 && cap == null) return null;
        const free = cap != null ? cap - items.length : 0;
        return (
          <div key={slot}>
            <div className="text-xs uppercase tracking-wide text-zinc-500">
              {label}
              {cap != null ? ` (${items.length}/${cap})` : ""}
            </div>
            {items.length > 0 && (
              <ul className="text-sm text-zinc-300">
                {items.map(({ it, i }) => {
                  const range = rangeOf.get(`${it.typeId}:${it.chargeTypeId ?? 0}`);
                  // Only high/mid/low modules toggle (rigs/subsystems are permanent).
                  // Activatable modules cycle active → inactive → offline; passive
                  // ones only toggle online ↔ offline and never read "active".
                  const canToggle =
                    slot === "high" || slot === "mid" || slot === "low";
                  const canActivate = activatable.has(it.typeId);
                  const offline = it.state === "offline";
                  let next: ModuleState;
                  let stateTag: { label: string; cls: string } | null = null;
                  let toggleTitle: string;
                  let toggleCls: string;
                  if (canActivate) {
                    next =
                      it.state === "active"
                        ? "online"
                        : it.state === "online"
                          ? "offline"
                          : "active";
                    stateTag =
                      it.state === "active"
                        ? { label: "active", cls: "text-emerald-400" }
                        : it.state === "online"
                          ? { label: "inactive", cls: "text-red-400" }
                          : { label: "offline", cls: "text-zinc-400" };
                    toggleTitle =
                      it.state === "active"
                        ? "Deactivate (online)"
                        : it.state === "online"
                          ? "Disable (offline)"
                          : "Activate";
                    toggleCls =
                      it.state === "active"
                        ? "text-zinc-600 group-hover:text-zinc-300"
                        : it.state === "online"
                          ? "text-amber-500 hover:text-amber-400"
                          : "text-zinc-500 hover:text-emerald-400";
                  } else {
                    next = offline ? "online" : "offline";
                    stateTag = offline
                      ? { label: "offline", cls: "text-zinc-400" }
                      : null;
                    toggleTitle = offline ? "Enable" : "Disable (offline)";
                    toggleCls = offline
                      ? "text-zinc-500 hover:text-emerald-400"
                      : "text-zinc-600 group-hover:text-zinc-300";
                  }
                  // Dim the name when the module isn't contributing.
                  const dimmed = offline || (canActivate && it.state === "online");
                  return (
                    <li
                      key={i}
                      className="group flex items-center gap-2 rounded px-1 py-0.5 hover:bg-zinc-800/70"
                    >
                      <button
                        onClick={() => onRemove(i)}
                        className="flex shrink-0 items-center rounded p-0.5 text-zinc-500 group-hover:text-red-400"
                        title="Remove from slot"
                        aria-label={`Remove ${nameOf(it.typeId)}`}
                      >
                        <X size={14} />
                      </button>
                      {canToggle && (
                        <button
                          onClick={() => onSetState(i, next)}
                          title={toggleTitle}
                          aria-label="Cycle module state"
                          className={`flex shrink-0 items-center rounded p-0.5 ${toggleCls}`}
                        >
                          <Power size={13} />
                        </button>
                      )}
                      <span
                        className={`min-w-0 flex-1 truncate ${
                          offline ? "text-zinc-500" : dimmed ? "text-zinc-400" : ""
                        }`}
                      >
                        {nameOf(it.typeId)}
                        {it.chargeTypeId ? ` + ${nameOf(it.chargeTypeId)}` : ""}
                        {it.quantity > 1 ? ` x${it.quantity}` : ""}
                        {stateTag && (
                          <span
                            className={`ml-1.5 rounded bg-zinc-800/80 px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide ${stateTag.cls}`}
                          >
                            {stateTag.label}
                          </span>
                        )}
                      </span>
                      {range && (
                        <span
                          className="shrink-0 whitespace-nowrap tabular-nums text-[11px] text-zinc-500"
                          title="optimal range + falloff"
                        >
                          {km(range.optimal)}
                          {range.falloff > 0 ? ` +${km(range.falloff)}` : ""}
                        </span>
                      )}
                      {/* Ammo picker for high/mid weapons & script-takers. */}
                      {(slot === "high" || slot === "mid") && (
                        <ChargeControl
                          typeId={it.typeId}
                          chargeTypeId={it.chargeTypeId ?? null}
                          sameTypeCount={
                            fit.items.filter((x) => x.typeId === it.typeId).length
                          }
                          onSetCharge={(c) => onSetCharge(i, c)}
                          onSetChargeAll={(c) => onSetChargeForType(it.typeId, c)}
                        />
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {/* Click a free slot to add a module to it (filters the browser). */}
            {cap != null && free > 0 && (
              <button
                onClick={() => onAddToSlot(slot)}
                className="mt-0.5 flex items-center gap-1 rounded px-1 py-0.5 text-sm text-zinc-600 hover:bg-zinc-800/70 hover:text-zinc-300"
              >
                <Plus size={13} className="shrink-0" />
                Add to {label.toLowerCase()}
                {free > 1 ? ` (${free} free)` : ""}
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Capacitor gauge: a 0–100% fill when stable, or the time-to-empty when not. */
/**
 * EW projected onto the fit (#265): a presence badge per category — never a
 * magnitude. Web/paint/damp (whose effect is already in the stats) read solid;
 * unmodeled EW (tracking/guidance disruption, neut, nos) read muted. ECM is the
 * special case: a chance-to-jam, so it offers an opt-in "show jammed" toggle that
 * models the worst case (targeting disabled → 0 applied DPS) rather than a
 * passive effect.
 */
export function EwPanel({
  tags,
  jammed,
  onJam,
}: {
  tags: EwTag[];
  jammed: boolean;
  onJam: (v: boolean) => void;
}) {
  const hasEcm = tags.some((t) => t.jam);
  return (
    <div className="space-y-1">
      <h3 className="text-xs uppercase tracking-wide text-zinc-500">EW projected</h3>
      <div className="flex flex-wrap gap-1.5">
        {tags.map((t) => (
          <span
            key={t.category}
            title={
              t.modeled
                ? "Effect is applied in the stats above"
                : t.jam
                  ? "Chance-based jam — toggle below to view the jammed case"
                  : "Active — magnitude not modelled"
            }
            className={`rounded px-1.5 py-0.5 text-[11px] ${
              t.jam
                ? "border border-amber-500/50 text-amber-300"
                : t.modeled
                  ? "bg-zinc-700 text-zinc-100"
                  : "border border-zinc-700 text-zinc-300"
            }`}
          >
            {t.label}
            {t.count > 1 ? ` ×${t.count}` : ""}
          </span>
        ))}
      </div>
      {hasEcm && (
        <label className="flex items-center gap-2 pt-0.5 text-xs text-zinc-400">
          <input
            type="checkbox"
            checked={jammed}
            onChange={(e) => onJam(e.currentTarget.checked)}
            className="accent-amber-500"
          />
          Show jammed (targeting disabled · 0 applied DPS)
        </label>
      )}
    </div>
  );
}

export function CapGauge({ cap }: { cap: CapStats }) {
  const color = cap.stable ? "#10b981" : "#ef4444";
  return (
    <div>
      <div className="flex justify-between text-xs">
        <span className="text-zinc-400">Capacitor</span>
        {cap.stable ? (
          <span className="text-emerald-400">
            stable · {Math.max(0, Math.min(100, cap.stablePct ?? 100)).toFixed(0)}%
          </span>
        ) : (
          <span className="text-red-400">
            empties in {formatDuration(cap.depletionSeconds ?? 0)}
          </span>
        )}
      </div>
      {cap.trajectory.length > 1 ? (
        <CapChart trajectory={cap.trajectory} color={color} />
      ) : (
        <div className="mt-0.5 h-2 w-full overflow-hidden rounded bg-zinc-800">
          <div
            className="h-full"
            style={{
              width: cap.stable
                ? `${Math.max(0, Math.min(100, cap.stablePct ?? 100))}%`
                : "100%",
              background: color,
            }}
          />
        </div>
      )}
    </div>
  );
}

/** Cap-over-time curve (#265): inline SVG, full → settles or drains. The x-axis
 *  spans the sampled horizon; y is 0–100%. */
export function CapChart({
  trajectory,
  color,
}: {
  trajectory: [number, number][];
  color: string;
}) {
  const w = 240;
  const h = 56;
  const padY = 3;
  const tMax = trajectory[trajectory.length - 1][0] || 1;
  const x = (t: number) => (t / tMax) * w;
  const y = (pct: number) => padY + (1 - pct / 100) * (h - 2 * padY);
  const line = trajectory
    .map(([t, pct]) => `${x(t).toFixed(1)},${y(pct).toFixed(1)}`)
    .join(" ");
  const area = `0,${h} ${line} ${w},${h}`;
  const endSecs = trajectory[trajectory.length - 1][0];
  return (
    <div className="mt-1">
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height: h }}
      >
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={0}
            x2={w}
            y1={padY + f * (h - 2 * padY)}
            y2={padY + f * (h - 2 * padY)}
            stroke="#27272a"
            strokeWidth="0.75"
          />
        ))}
        <polygon points={area} fill={color} fillOpacity="0.12" stroke="none" />
        <polyline points={line} fill="none" stroke={color} strokeWidth="1.5" />
      </svg>
      <div className="flex justify-between text-[10px] text-zinc-600">
        <span>0s</span>
        <span>{formatDuration(endSecs)}</span>
      </div>
    </div>
  );
}

export function ResourceBar({
  label,
  used,
  max,
  unit,
}: {
  label: string;
  used: number;
  max: number;
  unit: string;
}) {
  const frac = max > 0 ? Math.min(used / max, 1) : 0;
  const over = used > max + 1e-6;
  return (
    <div>
      <div className="flex justify-between text-xs text-zinc-400">
        <span>{label}</span>
        <span className={over ? "text-red-400" : ""}>
          {used.toFixed(1)} / {max.toFixed(0)} {unit}
        </span>
      </div>
      <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded bg-zinc-800">
        <div
          className={`h-full ${over ? "bg-red-500" : "bg-emerald-500"}`}
          style={{ width: `${frac * 100}%` }}
        />
      </div>
    </div>
  );
}

/** In-game fittings status: an error (e.g. missing scope) or "none found". */
export function EsiFitStatus({
  esi,
  refresh,
}: {
  esi: { data?: Fit[]; error: unknown; isFetched: boolean };
  refresh: { error: unknown };
}) {
  const err = refresh.error ?? esi.error;
  if (err) {
    return (
      <span className="mt-0.5 block w-72 text-[11px] text-rose-400">{String(err)}</span>
    );
  }
  if (esi.isFetched && (esi.data?.length ?? 0) === 0) {
    return (
      <span className="mt-0.5 block text-[11px] text-zinc-500">
        No in-game fittings for this character.
      </span>
    );
  }
  return null;
}

export function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-zinc-500">
      {children}
    </div>
  );
}
