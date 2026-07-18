import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  errorMessage,
  fittingAddItem,
  fittingExportEft,
  fittingImportEft,
  fittingSaveLocal,
  fittingShipLayout,
  fittingSimulate,
  sdeTypeNames,
  type Fit,
  type ModuleState,
  type SkillSource,
  type SlotKind,
  type WeaponRange,
} from "../../lib/api";
import { copyToClipboard } from "../../lib/useCopyToClipboard";
import type { FitContext } from "./fitHelpers";

/**
 * The fit-editing state machine: the current `Fit`, the immutable-update
 * helpers that mutate it client-side (slot edits, charges, projected
 * modules), and the mutations that round-trip through the backend (add
 * item, import/export EFT, save). Also owns the derived simulation —
 * layout/stats queries and the free-slot/CPU/PG context they feed — since
 * every one of those re-runs off the same `fit` state.
 */
export function useFitEditor() {
  const qc = useQueryClient();
  const [fit, setFit] = useState<Fit | null>(null);
  const [eft, setEft] = useState("");
  const [skillSource, setSkillSource] = useState<SkillSource>("allFive");
  const skillLabel = skillSource === "character" ? "character" : "all V";
  // ECM is a chance-to-jam, not a continuous effect — so it's an opt-in "what if
  // the jam lands" view (targeting disabled), never a passive stat (#265).
  const [jammed, setJammed] = useState(false);

  const layout = useQuery({
    queryKey: ["fitting", "layout", fit?.shipTypeId],
    queryFn: () => fittingShipLayout(fit!.shipTypeId),
    enabled: fit != null,
  });

  // Names for every fitted type id (+ charges), to show names not ids.
  const itemIds = useMemo(() => {
    if (!fit) return [];
    const s = new Set<number>([fit.shipTypeId]);
    for (const it of fit.items) {
      s.add(it.typeId);
      if (it.chargeTypeId) s.add(it.chargeTypeId);
    }
    for (const it of fit.projected ?? []) s.add(it.typeId);
    return [...s];
  }, [fit]);
  const names = useQuery({
    queryKey: ["fitting", "names", itemIds],
    queryFn: () => sdeTypeNames(itemIds),
    enabled: itemIds.length > 0,
  });
  const nameMap = useMemo(
    () => new Map((names.data ?? []).map((n) => [n.id, n.name])),
    [names.data],
  );
  const nameOf = (id: number) => nameMap.get(id) ?? `#${id}`;

  const fitKey = useMemo(() => (fit ? JSON.stringify(fit) : ""), [fit]);
  const stats = useQuery({
    queryKey: ["fitting", "simulate", fitKey, skillSource],
    queryFn: () => fittingSimulate(fit!, skillSource),
    enabled: fit != null,
  });
  // The jammed view only applies while ECM is actually projected onto the fit.
  const jammedActive = jammed && !!stats.data?.projectedEw?.some((t) => t.jam);

  // Per-weapon ranges keyed by (typeId, chargeTypeId), for the slot grid.
  const rangeOf = useMemo(() => {
    const m = new Map<string, WeaponRange>();
    for (const r of stats.data?.weaponRanges ?? [])
      m.set(`${r.typeId}:${r.chargeTypeId ?? 0}`, r);
    return m;
  }, [stats.data?.weaponRanges]);
  // Module type ids that can be activated (others are passive — no active state).
  const activatable = useMemo(
    () => new Set(stats.data?.activatableTypes ?? []),
    [stats.data?.activatableTypes],
  );

  // What the hull has free right now — drives fit-aware ranking/filtering in the
  // add-module browser. Prefer the resolved (skill-adjusted) layout/resources.
  const fitContext = useMemo<FitContext | null>(() => {
    if (!fit) return null;
    const ship = stats.data?.layout ?? layout.data;
    if (!ship) return null;
    const used: Partial<Record<SlotKind, number>> = {};
    for (const it of fit.items) used[it.slot] = (used[it.slot] ?? 0) + 1;
    const free = (kind: SlotKind, total: number) =>
      Math.max(0, total - (used[kind] ?? 0));
    const res = stats.data?.resources;
    return {
      freeSlots: {
        high: free("high", ship.highSlots),
        mid: free("mid", ship.midSlots),
        low: free("low", ship.lowSlots),
        rig: free("rig", ship.rigSlots),
        subsystem: free("subsystem", ship.subsystemSlots),
      },
      cpu: (res?.cpuOutput ?? ship.cpuOutput) - (res?.cpuUsed ?? 0),
      pg:
        (res?.powergridOutput ?? ship.powergridOutput) -
        (res?.powergridUsed ?? 0),
      calibration:
        (res?.calibrationOutput ?? ship.calibration) -
        (res?.calibrationUsed ?? 0),
    };
  }, [fit, stats.data, layout.data]);

  const importEft = useMutation({
    mutationFn: () => fittingImportEft(eft),
    onSuccess: (f) => {
      setFit(f);
      setEft("");
    },
    onError: (e) => alert(`Import failed: ${errorMessage(e)}`),
  });
  const save = useMutation({
    mutationFn: () => fittingSaveLocal(fit!),
    onSuccess: (id) => {
      setFit((f) => (f ? { ...f, id } : f));
      qc.invalidateQueries({ queryKey: ["fitting", "saved"] });
    },
  });
  const exportEft = useMutation({
    mutationFn: () => fittingExportEft(fit!),
    onSuccess: (text) => {
      copyToClipboard(text);
      setEft(text);
    },
  });

  function pickShip(id: number, name: string) {
    setFit({ id: "", name: `${name} fit`, shipTypeId: id, items: [] });
  }
  function removeItem(globalIndex: number) {
    setFit((f) =>
      f ? { ...f, items: f.items.filter((_, i) => i !== globalIndex) } : f,
    );
  }
  // Load/clear a weapon's charge (re-simulates: fitKey is the serialized fit).
  function setCharge(globalIndex: number, chargeTypeId: number | null) {
    setFit((f) =>
      f
        ? {
            ...f,
            items: f.items.map((it, i) =>
              i === globalIndex ? { ...it, chargeTypeId } : it,
            ),
          }
        : f,
    );
  }
  // Toggle a module's state (active ↔ offline) — re-simulates off the new fit.
  function setModuleState(globalIndex: number, state: ModuleState) {
    setFit((f) =>
      f
        ? {
            ...f,
            items: f.items.map((it, i) =>
              i === globalIndex ? { ...it, state } : it,
            ),
          }
        : f,
    );
  }
  // Load/clear a charge on *every* fitted weapon of the given type at once.
  function setChargeForType(weaponTypeId: number, chargeTypeId: number | null) {
    setFit((f) =>
      f
        ? {
            ...f,
            items: f.items.map((it) =>
              it.typeId === weaponTypeId ? { ...it, chargeTypeId } : it,
            ),
          }
        : f,
    );
  }
  // Projected modules (webs/paints/…) live in `fit.projected`; their slot/index
  // are irrelevant to projection, so they're added/removed client-side.
  function addProjected(typeId: number) {
    setFit((f) =>
      f
        ? {
            ...f,
            projected: [
              ...(f.projected ?? []),
              { typeId, slot: "mid", index: 0, state: "active", quantity: 1 },
            ],
          }
        : f,
    );
  }
  function removeProjected(idx: number) {
    setFit((f) =>
      f
        ? { ...f, projected: (f.projected ?? []).filter((_, i) => i !== idx) }
        : f,
    );
  }

  // Add a module/drone the user picked: the backend classifies its slot and
  // places it at the next free index, then we re-simulate off the new fit.
  const addItem = useMutation({
    mutationFn: (typeId: number) => fittingAddItem(fit!, typeId),
    onSuccess: (f) => setFit(f),
    onError: (e) => alert(`Couldn't add module: ${errorMessage(e)}`),
  });

  return {
    fit,
    setFit,
    eft,
    setEft,
    skillSource,
    setSkillSource,
    skillLabel,
    jammed,
    setJammed,
    jammedActive,
    layout,
    nameOf,
    stats,
    rangeOf,
    activatable,
    fitContext,
    pickShip,
    removeItem,
    setCharge,
    setChargeForType,
    setModuleState,
    addProjected,
    removeProjected,
    addItem,
    importEft,
    exportEft,
    save,
  };
}
