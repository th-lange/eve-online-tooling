import {
  useMutation,
  useQueryClient,
  type UseMutationResult,
} from "@tanstack/react-query";
import {
  fittingAddItem,
  fittingExportDna,
  fittingExportEft,
  fittingExportMultibuy,
  fittingImportEft,
  fittingImportList,
  fittingSaveLocal,
  type Fit,
  type ModuleState,
} from "../../lib/api";
import { copyToClipboard } from "../../lib/useCopyToClipboard";
import type { FitStateSlice } from "./useFitCoreState";
import { useState } from "react";

/** The fit-editing state machine's write side: the immutable-update helpers
 *  that mutate the fit client-side (slot edits, charges, projected modules)
 *  plus the mutations that round-trip through the backend (add item,
 *  import/export EFT, save). Everything here funnels back through
 *  `FitStateSlice.setFit`. */
export interface FitMutationsSlice {
  pickShip: (id: number, name: string) => void;
  removeItem: (globalIndex: number) => void;
  setCharge: (globalIndex: number, chargeTypeId: number | null) => void;
  setChargeForType: (weaponTypeId: number, chargeTypeId: number | null) => void;
  setModuleState: (globalIndex: number, state: ModuleState) => void;
  setQuantity: (globalIndex: number, quantity: number) => void;
  setActiveDrones: (globalIndex: number, activeDrones: number) => void;
  addProjected: (typeId: number) => void;
  removeProjected: (idx: number) => void;
  addItem: UseMutationResult<Fit, Error, number, unknown>;
  importEft: UseMutationResult<Fit, Error, void, unknown>;
  listText: string;
  setListText: (v: string) => void;
  importList: UseMutationResult<Fit, Error, void, unknown>;
  exportEft: UseMutationResult<string, Error, void, unknown>;
  exportDna: UseMutationResult<string, Error, void, unknown>;
  exportMultibuy: UseMutationResult<string, Error, void, unknown>;
  save: UseMutationResult<string, Error, void, unknown>;
}

/** Raw mutations slice — see `useFitCoreState` for the sibling raw state
 *  slice this reads/writes through `setFit`/`setEft`. Called once by
 *  `FitEditorProvider`. */
export function useFitCoreMutations(state: FitStateSlice): FitMutationsSlice {
  const qc = useQueryClient();
  const { fit, setFit, eft, setEft } = state;

  const importEft = useMutation({
    mutationFn: () => fittingImportEft(eft),
    onSuccess: (f) => {
      setFit(f);
      setEft("");
    },
    onError: (e) => console.error("EFT import failed", e),
  });

  const [listText, setListText] = useState("");
  const importList = useMutation({
    mutationFn: () => fittingImportList(listText),
    onSuccess: (f) => {
      setFit(f);
      setListText("");
    },
    onError: (e) => console.error("List import failed", e),
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
  // DNA/MultiBuy exports copy to the clipboard only — unlike EFT, neither
  // has an on-page textarea to mirror them into.
  const exportDna = useMutation({
    mutationFn: () => fittingExportDna(fit!),
    onSuccess: (text) => copyToClipboard(text),
  });
  const exportMultibuy = useMutation({
    mutationFn: () => fittingExportMultibuy(fit!),
    onSuccess: (text) => copyToClipboard(text),
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
  // Set a cargo/drone stack's quantity (clamped to ≥ 1) — re-simulates off the
  // new fit, same as any other slot edit.
  function setQuantity(globalIndex: number, quantity: number) {
    const q = Math.max(1, Math.round(quantity));
    setFit((f) =>
      f
        ? {
            ...f,
            items: f.items.map((it, i) =>
              i === globalIndex ? { ...it, quantity: q } : it,
            ),
          }
        : f,
    );
  }
  // How many of a fitted drone stack are active (deployed), clamped to
  // 0..=quantity here; the backend re-clamps to bandwidth + the 5-in-space
  // limit (a shared pool across every drone type) and returns the granted
  // counts via `stats.droneActive`, which the UI displays as the truth.
  function setActiveDrones(globalIndex: number, activeDrones: number) {
    setFit((f) =>
      f
        ? {
            ...f,
            items: f.items.map((it, i) =>
              i === globalIndex
                ? {
                    ...it,
                    activeDrones: Math.max(
                      0,
                      Math.min(Math.round(activeDrones), it.quantity),
                    ),
                  }
                : it,
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
    onError: (e) => console.error("Couldn't add module", e),
  });

  return {
    pickShip,
    removeItem,
    setCharge,
    setChargeForType,
    setModuleState,
    setQuantity,
    setActiveDrones,
    addProjected,
    removeProjected,
    addItem,
    importEft,
    listText,
    setListText,
    importList,
    exportEft,
    exportDna,
    exportMultibuy,
    save,
  };
}
