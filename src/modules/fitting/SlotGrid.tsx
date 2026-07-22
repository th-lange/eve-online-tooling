import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Crosshair, Minus, Plus, Power, Star, X } from "lucide-react";
import {
  fittingCompatibleCharges,
  type Fit,
  type ModuleState,
  type SlotKind,
  type WeaponRange,
} from "../../lib/api";
import { SLOT_BADGE, km } from "./fitHelpers";

/** Combat racks — the banks a fitter reads first, given equal prominence. */
const PRIMARY_BANKS: [SlotKind, string][] = [
  ["high", "High"],
  ["mid", "Mid"],
  ["low", "Low"],
];
/** Secondary banks — permanent or non-combat slots, shown quieter and below. */
const SECONDARY_BANKS: [SlotKind, string][] = [
  ["rig", "Rig"],
  ["subsystem", "Subsystem"],
  ["implant", "Implants"],
  ["drone", "Drones"],
  ["cargo", "Cargo"],
];

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
    ? allCharges.filter((c) =>
        c.name.toLowerCase().includes(q.toLowerCase().trim()),
      )
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
                        c.id === chargeTypeId
                          ? "text-amber-400"
                          : "text-zinc-200"
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

/** A compact stepper for a cargo/drone stack's quantity — the count you
 *  actually carry (or fly, for drones), editable in place instead of only via
 *  EFT re-import. */
function QuantityControl({
  value,
  onChange,
}: {
  value: number;
  onChange: (quantity: number) => void;
}) {
  return (
    <span className="ml-auto flex shrink-0 items-center gap-0.5">
      <button
        onClick={() => onChange(value - 1)}
        disabled={value <= 1}
        title="Decrease quantity"
        aria-label="Decrease quantity"
        className="rounded p-0.5 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-200 disabled:opacity-30"
      >
        <Minus size={11} />
      </button>
      <input
        type="number"
        min={1}
        value={value}
        onChange={(e) => {
          const n = Number(e.currentTarget.value);
          if (Number.isFinite(n) && n >= 1) onChange(Math.round(n));
        }}
        aria-label="Quantity"
        className="w-11 rounded bg-zinc-800 px-1 py-0.5 text-center text-[11px] tabular-nums text-zinc-200 outline-none"
      />
      <button
        onClick={() => onChange(value + 1)}
        title="Increase quantity"
        aria-label="Increase quantity"
        className="rounded p-0.5 text-zinc-500 hover:bg-zinc-700 hover:text-zinc-200"
      >
        <Plus size={11} />
      </button>
    </span>
  );
}

/** Clickable stars for a fitted drone stack's *active* (deployed) count —
 *  0..=maxActive, where `maxActive` is capped at 5 (Drones V) and further
 *  capped by the ship's drone bandwidth for this drone type (#712 follow-up:
 *  some hulls only support 2 of a bandwidth-hungry drone). Clicking a star at
 *  or below the current active count decrements to just below it
 *  (toggle-off); clicking above it activates up through that star. The
 *  backend is authoritative (bandwidth + the 5-in-space limit are a shared
 *  pool across every drone type in the bay), so a click that overshoots
 *  what's actually grantable snaps back once the fit re-simulates — honest
 *  feedback, no duplicated client-side bandwidth math. */
function DroneStars({
  maxActive,
  active,
  onChange,
}: {
  maxActive: number;
  active: number;
  onChange: (activeDrones: number) => void;
}) {
  return (
    <span
      className="flex flex-wrap items-center gap-0.5"
      title={`${active}/${maxActive} active`}
    >
      {Array.from({ length: maxActive }, (_, idx) => idx + 1).map((n) => (
        <button
          key={n}
          onClick={() => onChange(n <= active ? n - 1 : n)}
          aria-label={`Set active drones to ${n}`}
          className={`rounded p-0 ${
            n <= active
              ? "text-amber-400 hover:text-amber-300"
              : "text-zinc-600 hover:text-zinc-400"
          }`}
        >
          <Star size={11} fill={n <= active ? "currentColor" : "none"} />
        </button>
      ))}
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
  onSetQuantity,
  onSetActiveDrones,
  droneActive,
  droneMaxActive,
  rangeOf,
  activatable,
}: {
  fit: Fit;
  layout: {
    highSlots: number;
    midSlots: number;
    lowSlots: number;
    rigSlots: number;
  };
  nameOf: (id: number) => string;
  onRemove: (globalIndex: number) => void;
  onAddToSlot: (slot: SlotKind) => void;
  onSetCharge: (globalIndex: number, chargeTypeId: number | null) => void;
  onSetChargeForType: (
    weaponTypeId: number,
    chargeTypeId: number | null,
  ) => void;
  onSetState: (globalIndex: number, state: ModuleState) => void;
  onSetQuantity: (globalIndex: number, quantity: number) => void;
  onSetActiveDrones: (globalIndex: number, activeDrones: number) => void;
  droneActive?: Array<number | null>;
  droneMaxActive?: Array<number | null>;
  rangeOf: Map<string, WeaponRange>;
  activatable: Set<number>;
}) {
  const counts: Partial<Record<SlotKind, number>> = {
    high: layout.highSlots,
    mid: layout.midSlots,
    low: layout.lowSlots,
    rig: layout.rigSlots,
  };

  function renderItem(it: Fit["items"][number], i: number, slot: SlotKind) {
    const range = rangeOf.get(`${it.typeId}:${it.chargeTypeId ?? 0}`);
    // Only high/mid/low modules toggle (rigs/subsystems are permanent).
    // Activatable modules cycle active → inactive → offline; passive
    // ones only toggle online ↔ offline and never read "active".
    const canToggle = slot === "high" || slot === "mid" || slot === "low";
    // Only cargo/drone stacks carry more than one — modules/rigs are always
    // exactly one per slot index, so the live stepper only applies here.
    const editableQuantity = slot === "cargo" || slot === "drone";
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
      stateTag = offline ? { label: "offline", cls: "text-zinc-400" } : null;
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
        className="group flex flex-col gap-1 rounded px-1 py-0.5 hover:bg-zinc-800/70"
      >
        <div className="flex items-center gap-2">
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
            {!editableQuantity && it.quantity > 1 ? ` x${it.quantity}` : ""}
            {stateTag && (
              <span
                className={`ml-1.5 rounded bg-zinc-800/80 px-1 py-0.5 text-[10px] font-medium uppercase tracking-wide ${stateTag.cls}`}
              >
                {stateTag.label}
              </span>
            )}
          </span>
          {editableQuantity && (
            <QuantityControl
              value={it.quantity}
              onChange={(q) => onSetQuantity(i, q)}
            />
          )}
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
        </div>
        {slot === "drone" && (
          <div className="flex items-center gap-2 pl-6">
            <DroneStars
              maxActive={Math.min(5, droneMaxActive?.[i] ?? it.quantity)}
              active={droneActive?.[i] ?? it.activeDrones ?? it.quantity}
              onChange={(n) => onSetActiveDrones(i, n)}
            />
          </div>
        )}
      </li>
    );
  }

  /** One bank (High/Mid/Low/Rig/…): a bordered box with an occupancy header,
   *  its fitted items, and an add-affordance for any free slot. `null` when the
   *  hull has no such bank and nothing is fitted there (e.g. no rigs, no
   *  implants). `primary` gives High/Mid/Low the brighter combat-rack styling;
   *  secondary banks (Rig/Subsystem/Implants/Drones/Cargo) read quieter. */
  function renderBank(
    slot: SlotKind,
    label: string,
    primary: boolean,
  ): ReactNode {
    const items = fit.items
      .map((it, i) => ({ it, i }))
      .filter((x) => x.it.slot === slot)
      .sort((a, b) => a.it.index - b.it.index);
    const cap = counts[slot];
    if (items.length === 0 && cap == null) return null;
    const free = cap != null ? cap - items.length : 0;
    const full = cap != null && free === 0 && cap > 0;
    return (
      <div
        key={slot}
        className={`rounded-lg border p-2 ${
          primary
            ? "border-zinc-700 bg-zinc-900/40"
            : "border-zinc-800 bg-zinc-900/20"
        }`}
      >
        <div
          className={`flex items-center justify-between text-xs uppercase tracking-wide ${
            primary ? "text-zinc-300" : "text-zinc-500"
          }`}
        >
          <span>{label}</span>
          {cap != null && (
            <span
              className={`tabular-nums ${full ? "text-emerald-400" : "text-zinc-500"}`}
            >
              {items.length}/{cap}
            </span>
          )}
        </div>
        {items.length > 0 && (
          <ul className="mt-1 text-sm text-zinc-300">
            {items.map(({ it, i }) => renderItem(it, i, slot))}
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
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        {PRIMARY_BANKS.map(([slot, label]) => renderBank(slot, label, true))}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {SECONDARY_BANKS.map(([slot, label]) => renderBank(slot, label, false))}
      </div>
    </div>
  );
}
