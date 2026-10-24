import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  fittingDeleteLocal,
  fittingEsiPush,
  fittingPrice,
} from "../../lib/api";
import { fittingKeys } from "../../lib/queryKeys";
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
    onError: (e) => console.error("Couldn't price fit", e),
  });
  const del = useMutation({
    mutationFn: (id: string) => fittingDeleteLocal(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: fittingKeys.saved }),
  });
  // Save the current fit to the active character's in-game fittings via ESI.
  const pushEsi = useMutation({
    mutationFn: () => fittingEsiPush(fit!),
    onSuccess: () => qc.invalidateQueries({ queryKey: fittingKeys.esi }),
    onError: (e) => console.error("Couldn't save to EVE", e),
  });

  return { price, del, pushEsi };
}
