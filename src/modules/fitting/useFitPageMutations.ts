import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fittingDeleteLocal,
  fittingEsiPush,
  fittingPrice,
} from "../../lib/api";
import { useFitState } from "./useFitEditorContext";

/**
 * Page-scoped mutations that sit outside the fit-editing state machine
 * itself: pricing the current fit at a chosen region, deleting a saved fit,
 * and pushing the current fit to the active character's in-game fittings
 * via ESI. Kept off `FitEditorContext` since none of the other fitting
 * surfaces (SlotGrid, ModuleBrowser, …) need them.
 */
export function useFitPageMutations(regionId: number) {
  const qc = useQueryClient();
  const { fit } = useFitState();

  const price = useMutation({
    mutationFn: () => fittingPrice(fit!, regionId, null),
  });
  const del = useMutation({
    mutationFn: (id: string) => fittingDeleteLocal(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["fitting", "saved"] }),
  });
  // Save the current fit to the active character's in-game fittings via ESI.
  const pushEsi = useMutation({
    mutationFn: () => fittingEsiPush(fit!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["fitting", "esi"] }),
    onError: (e) => console.error("Couldn't save to EVE", e),
  });

  return { price, del, pushEsi };
}
