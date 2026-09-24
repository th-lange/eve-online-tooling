import { useMemo } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { fittingAmmoTable, fittingLoadAmmo, type AmmoRow } from "../../lib/api";
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
  const ammoTable = useQuery({
    queryKey: ["fitting", "ammoTable", fit, skillSource],
    queryFn: () => fittingAmmoTable(fit!, skillSource),
    enabled: fit != null,
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
