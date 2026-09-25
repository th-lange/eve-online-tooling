import { invoke } from "@tauri-apps/api/core";

/** One pasted blueprint name resolved against the SDE, with what's actually
 * owned across the roster/corp hangars. */
export interface MatchedBlueprint {
  name: string;
  typeId: number;
  /** Total physical BPC copies owned across the roster/corp hangars.
   * Excludes BPOs — they have no bounded "remaining runs" to sum. */
  ownedCopies: number;
  /** Sum of `runs` across every owned copy. */
  totalRuns: number;
}

/** One material line inside a `MaterialGroup`. */
export interface PlanItem {
  typeId: number;
  name: string;
  quantity: number;
}

/** Aggregated materials for one `invGroups.groupName` bucket (e.g.
 * "Mineral", "Refined Commodities - Tier 2"). */
export interface MaterialGroup {
  groupName: string;
  /** The group's parent `invCategories.categoryName`, for a secondary label. */
  categoryName: string;
  items: PlanItem[];
}

/** Result of `massprodPlan`: what didn't resolve, what was matched against
 * owned copies, and the materials to buy, grouped for Multibuy. */
export interface MassProductionPlan {
  unresolvedNames: string[];
  matchedBlueprints: MatchedBlueprint[];
  groups: MaterialGroup[];
}

/**
 * Paste a list of blueprint names (one per line) and get a Mass Production
 * plan (#883): each name is matched against every copy the roster/corp
 * actually own (real ME/runs, personal + corp hangars), the resulting
 * materials are summed per owned copy — never averaged across copies at
 * different ME/runs — and bucketed by `invGroups.groupName` into
 * Multibuy-ready shopping groups.
 */
export function massprodPlan(
  blueprintNames: string[],
): Promise<MassProductionPlan> {
  return invoke<MassProductionPlan>("massprod_plan", { blueprintNames });
}
