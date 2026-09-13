import type { OwnedBlueprint, PriceBasis, ProfitParams } from "../../lib/api";
import { STRUCTURES, type ImportedBlueprint, type StructureKey } from "./types";

/**
 * Best researched ME/TE per blueprint type: the highest across owned copies,
 * then imported (unowned, modeled) entries layered on top — so a manually
 * imported ME/TE can raise the ceiling for a blueprint the roster doesn't
 * physically own, but never lowers what's actually researched. `ownedField`/
 * `importedField` pick the relevant column so the same reducer serves both
 * the ME map and the TE map.
 */
export function bestResearchedMap(
  owned: OwnedBlueprint[],
  imported: ImportedBlueprint[],
  ownedField: "materialEfficiency" | "timeEfficiency",
  importedField: "me" | "te",
): Record<number, number> {
  const map: Record<number, number> = {};
  for (const b of owned)
    map[b.typeId] = Math.max(map[b.typeId] ?? 0, b[ownedField]);
  for (const b of imported)
    map[b.typeId] = Math.max(map[b.typeId] ?? 0, b[importedField]);
  return map;
}

/**
 * Compose the manufacturing structure preset with the user-supplied rig
 * bonuses into the three multipliers the pricing engine consumes:
 * - `structureTePct`: additive — structure base time bonus + rig time bonus.
 * - `meBonus`: multiplicative material bonus — structure × rig, so an
 *   unbonused structure (NPC station, `meBonus: 1.0`) with no rig stays
 *   exactly `1.0` (no discount).
 * - `costBonus`: combined cost-index discount, composed multiplicatively on
 *   what's left after the first discount (not simple addition), matching how
 *   EVE stacks structure + rig cost bonuses.
 */
export function composeStructureBonuses(
  structure: StructureKey,
  rigMePct: number,
  rigTePct: number,
  rigCostPct: number,
): { structureTePct: number; meBonus: number; costBonus: number } {
  const preset = STRUCTURES[structure];
  return {
    structureTePct: preset.tePct + rigTePct,
    meBonus: preset.meBonus * (1 - rigMePct / 100),
    costBonus: 1 - (1 - preset.costBonus) * (1 - rigCostPct / 100),
  };
}

/**
 * Invention cost amortized per produced unit: the total per-attempt cost
 * (datacores + invention job fee + copy fee, already summed into
 * `attemptCost`) divided by the expected units an attempt yields
 * (`probability × runsPerSuccess`). Mirrors the pricing engine's own
 * per-unit invention EV (`src-tauri/src/modules/production/engine.rs`).
 * Zero expected yield (an impossible probability or run count) amortizes to
 * `0` rather than dividing by zero.
 */
export function inventionCostPerUnit(
  attemptCost: number,
  probability: number,
  runsPerSuccess: number,
): number {
  const yielded = probability * runsPerSuccess;
  return yielded > 0 ? attemptCost / yielded : 0;
}

/** Owned stock only nets against the bill of materials when "use stock" is on. */
export function resolveStock(
  useStock: boolean,
  stock: Record<number, number> | undefined,
): Record<number, number> {
  return useStock ? (stock ?? {}) : {};
}

/**
 * Count settings keys that differ between the current pricing inputs and the
 * snapshot taken as of the last Calculate — how many pricing-relevant
 * parameters have gone stale since the table was last priced.
 */
export function countDirtySettings<T extends Record<string, unknown>>(
  current: T,
  lastCalculated: T,
): number {
  return (Object.keys(current) as (keyof T)[]).filter(
    (k) => current[k] !== lastCalculated[k],
  ).length;
}

/** Everything `composeProfitParams` needs to build one pricing request. */
export interface ComposeProfitParamsInput {
  regionId: number;
  stationId: number | null;
  runs: number;
  me: number;
  useOwnedMe: boolean;
  ownedMe: Record<number, number>;
  te: number;
  ownedTe: Record<number, number>;
  timeSkill: number;
  structure: StructureKey;
  rigMePct: number;
  rigTePct: number;
  rigCostPct: number;
  useStock: boolean;
  stock: Record<number, number> | undefined;
  buildComponents: boolean;
  costIndexPct: number;
  facilityTaxPct: number;
  includeSaleCost: boolean;
  sellTaxPct: number;
  sellBrokerPct: number;
  materialBasis: PriceBasis;
  productBasis: PriceBasis;
  blueprintCostPerRun: number;
  inventionSkill: number;
  decryptorTypeId: number | null;
  productBestHub: boolean;
}

/**
 * Compose one `production_profit` request from the workbench's raw pricing
 * inputs: overlays owned/imported ME-TE onto the manual fallback (only when
 * "use owned ME/TE" is on), folds structure + rig bonuses into the engine's
 * multipliers, nets stock only when enabled, and converts every percentage
 * input (cost index, facility tax, sales tax, broker fee) to a fraction.
 */
export function composeProfitParams(
  input: ComposeProfitParamsInput,
): ProfitParams {
  const { structureTePct, meBonus, costBonus } = composeStructureBonuses(
    input.structure,
    input.rigMePct,
    input.rigTePct,
    input.rigCostPct,
  );
  return {
    regionId: input.regionId,
    stationId: input.stationId,
    runs: input.runs,
    me: input.me,
    ownedMe: input.useOwnedMe ? input.ownedMe : {},
    te: input.te,
    ownedTe: input.useOwnedMe ? input.ownedTe : {},
    timeSkill: input.timeSkill,
    structureTePct,
    meBonus,
    costBonus,
    stock: resolveStock(input.useStock, input.stock),
    buildComponents: input.buildComponents,
    systemCostIndex: input.costIndexPct / 100,
    facilityTax: input.facilityTaxPct / 100,
    includeSalesCost: input.includeSaleCost,
    salesTax: input.sellTaxPct / 100,
    brokerFee: input.sellBrokerPct / 100,
    materialBasis: input.materialBasis,
    productBasis: input.productBasis,
    blueprintCostPerRun: input.blueprintCostPerRun,
    inventionSkillLevel: input.inventionSkill,
    decryptorTypeId: input.decryptorTypeId,
    productBestHub: input.productBestHub,
  };
}
