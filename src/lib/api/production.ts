import {
  commands,
  type CostIndices,
  type Decryptor,
  type InventionBreakdown,
  type MaterialLine,
  type PriceBasis,
  type ProfitBreakdown,
  type ProfitParams,
} from "./generated/production";
import { unwrapCommand } from "./common";

export type {
  CostIndices,
  Decryptor,
  InventionBreakdown,
  MaterialLine,
  PriceBasis,
  ProfitBreakdown,
  ProfitParams,
};

/** Rank every manufacturable item by build-vs-buy profit at the chosen market. */
export async function productionProfit(
  params: ProfitParams,
): Promise<ProfitBreakdown[]> {
  return unwrapCommand(await commands.productionProfit(params));
}

/** The invention decryptors, for the production decryptor dropdown. */
export async function productionDecryptors(): Promise<Decryptor[]> {
  return unwrapCommand(await commands.productionDecryptors());
}

/** The live per-activity cost indices for a solar system (ESI
 *  /industry/systems/, cached ~1h). `null` when the system isn't listed (e.g.
 *  wormhole space); an activity the system doesn't list is `null` inside the
 *  record and falls back to manufacturing in the engine. */
export async function productionSystemCostIndex(
  systemId: number,
): Promise<CostIndices | null> {
  return unwrapCommand(await commands.productionSystemCostIndex(systemId));
}
