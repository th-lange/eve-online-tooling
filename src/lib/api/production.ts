import { invoke } from "@tauri-apps/api/core";

export interface MaterialLine {
  typeId: number;
  name: string;
  requiredQuantity: number;
  /** Units covered from owned stock; lineCost only pays the shortfall. */
  have: number;
  unitPrice: number | null;
  lineCost: number;
  /** True when building this input is cheaper than buying it. */
  built: boolean;
}

export interface InventionBreakdown {
  datacores: MaterialLine[];
  datacoreCost: number;
  inventionJobFee: number;
  copyFee: number;
  attemptCost: number;
  /** Skill-adjusted success probability (0..1). */
  probability: number;
  runsPerSuccess: number;
  /** Invention cost per produced unit. */
  perUnit: number;
}

export interface ProfitBreakdown {
  blueprintTypeId: number;
  productTypeId: number;
  productName: string;
  runs: number;
  me: number;
  /** Total manufacturing time for the job (all runs), in seconds; 0 if unknown. */
  jobTimeSeconds: number;
  unitsProduced: number;
  materialCost: number;
  jobFee: number;
  /** Amortized blueprint acquisition cost for this job (per-run cost × runs). */
  blueprintCost: number;
  /** Amortized invention cost for this job (T2 items; 0 otherwise). */
  inventionCost: number;
  /** Invention cost detail (T2 items only). */
  invention: InventionBreakdown | null;
  revenue: number;
  profit: number;
  /** profit / revenue, or null when revenue is zero. Capped at 100%. */
  margin: number | null;
  /** return on investment: profit / cost. Can exceed 100%. Null if cost is 0. */
  roi: number | null;
  profitPerUnit: number;
  /** Meta group of the product (Tech I/II, Faction, Officer, …). */
  metaGroup: string | null;
  /** Category of the product (Ship, Module, Charge, …). */
  category: string | null;
  /** Group of the product (Frigate, Cruiser, …). */
  group: string | null;
  /** Which market this result was priced at. */
  market: string | null;
  /** Best hub to sell the product at (when "sell at best hub" is on), else null. */
  sellHub: string | null;
  /** Whether the user has favorited this item. */
  favorite: boolean;
  /** Product market volume (units listed), or null. */
  productVolume: number | null;
  /** Per-unit sell price of the product (the target price), or null. */
  productPrice: number | null;
  materials: MaterialLine[];
  /** type ids that couldn't be priced; numbers are incomplete when non-empty. */
  missingPrices: number[];
}

export type PriceBasis =
  | "sellMin"
  | "buyMax"
  | "sellPercentile"
  | "buyPercentile"
  | "adjustedPrice"
  | "averagePrice";

export interface ProfitParams {
  /** Region to price against (default The Forge). */
  regionId?: number;
  /** Station within the region; null/undefined = region average. */
  stationId?: number | null;
  runs?: number;
  me?: number;
  /** Per-blueprint researched ME (blueprintTypeId → ME); overrides `me` for owned BPs. */
  ownedMe?: Record<number, number>;
  systemCostIndex?: number;
  facilityTax?: number;
  materialBasis?: PriceBasis;
  productBasis?: PriceBasis;
  /** Amortized blueprint acquisition cost per run (e.g. faction BPC). */
  blueprintCostPerRun?: number;
  /** Inventor skill level 0..5 scaling invention probability (default 5). */
  inventionSkillLevel?: number;
  /** Decryptor applied to every T2 invention; null/undefined = none. */
  decryptorTypeId?: number | null;
  /** Price the product at whichever hub pays the most (materials stay local). */
  productBestHub?: boolean;
  /** Time efficiency (default for un-owned blueprints), 0..20. */
  te?: number;
  /** Per-blueprint researched TE (blueprintTypeId → TE); overrides te for owned. */
  ownedTe?: Record<number, number>;
  /** Industry time-skill level 0..5 (Industry + Advanced Industry). */
  timeSkill?: number;
  /** Structure time-efficiency bonus %, e.g. Raitaru 15 / Sotiyo 30. */
  structureTePct?: number;
  /** Combined structure+rig material multiplier (1.0 = none, 0.99 = −1%). */
  meBonus?: number;
  /** Combined structure+rig cost saving on the cost-index portion (0..1). */
  costBonus?: number;
  /** SCC surcharge fraction of EIV (default 0.04). */
  sccSurcharge?: number;
  /** Owned stock per type id; netted against the top-level bill of materials. */
  stock?: Record<number, number>;
  /** Build sub-components (recursive build-vs-buy). False = buy all materials at market. Default true. */
  buildComponents?: boolean;
  /** Subtract sale costs (broker fee + sales tax) from product revenue. */
  includeSalesCost?: boolean;
  /** Sales tax fraction applied to revenue (when includeSalesCost). */
  salesTax?: number;
  /** Broker fee fraction applied to revenue (when includeSalesCost). */
  brokerFee?: number;
}

/** Rank every manufacturable item by build-vs-buy profit at the chosen market. */
export function productionProfit(
  params: ProfitParams,
): Promise<ProfitBreakdown[]> {
  return invoke<ProfitBreakdown[]>("production_profit", { params });
}

/** An invention decryptor and its outcome modifiers (from the SDE). */
export interface Decryptor {
  typeId: number;
  name: string;
  /** Multiplier on invention success probability. */
  probabilityMultiplier: number;
  /** Added to the invented T2 BPC's material efficiency. */
  meModifier: number;
  /** Added to runs per successful invention. */
  runModifier: number;
}

/** The invention decryptors, for the production decryptor dropdown. */
export function productionDecryptors(): Promise<Decryptor[]> {
  return invoke<Decryptor[]>("production_decryptors");
}

/** The live manufacturing cost index for a solar system (ESI /industry/systems/,
 *  cached ~1h). `null` when the system isn't listed (e.g. wormhole space). */
export function productionSystemCostIndex(
  systemId: number,
): Promise<number | null> {
  return invoke<number | null>("production_system_cost_index", { systemId });
}
