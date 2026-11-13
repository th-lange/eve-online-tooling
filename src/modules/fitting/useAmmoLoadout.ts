import { useMemo } from "react";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { fittingAmmoTable, fittingLoadAmmo, type AmmoRow } from "../../lib/api";
import { fittingKeys } from "../../lib/queryKeys";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { useFitState } from "./useFitEditorContext";

/**
 * DPS/range/tracking for each cargo ammo the fit's turrets can load, keyed
 * by type id (surfaced as a hover popover on the cargo rows in `SlotGrid`),
 * plus the mutation that loads a picked charge into every turret it fits.
 * Reads/writes the fit through `FitEditorContext`; not itself part of the
 * context since only `SlotGrid` (via the page) consumes it.
 */
export function useAmmoLoadout() {
  const { fit, skillSource, setFit } = useFitState();
  // One full simulation per cargo ammo type on the backend: debounce edits and
  // only ask at all when there is cargo to compare (#1189).
  const settledFit = useDebouncedValue(fit, 150);
  const hasCargo = settledFit?.items.some((i) => i.slot === "cargo") ?? false;
  const ammoTable = useQuery({
    queryKey: fittingKeys.ammoTable(settledFit, skillSource),
    queryFn: () => fittingAmmoTable(settledFit!, skillSource),
    enabled: settledFit != null && hasCargo,
    placeholderData: keepPreviousData,
  });
  const ammoStats: Record<number, AmmoRow> = useMemo(
    () => Object.fromEntries((ammoTable.data ?? []).map((r) => [r.typeId, r])),
    [ammoTable.data],
  );
  const loadAmmo = useMutation({
    mutationFn: (typeId: number) => fittingLoadAmmo(fit!, typeId),
    onSuccess: (f) => setFit(f),
    onError: (e) => console.error("Couldn't load ammo", e),
  });
  return { ammoStats, loadAmmo };
}
