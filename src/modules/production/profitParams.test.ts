import { describe, expect, it } from "vitest";
import type { OwnedBlueprint } from "../../lib/api";
import type { ImportedBlueprint } from "./types";
import {
  bestResearchedMap,
  composeProfitParams,
  composeStructureBonuses,
  countDirtySettings,
  inventionCostPerUnit,
  resolveStock,
  type ComposeProfitParamsInput,
} from "./profitParams";

function ownedBp(typeId: number, me: number, te: number): OwnedBlueprint {
  return {
    characterId: 1,
    characterName: "Pilot",
    corporation: false,
    typeId,
    name: "Blueprint",
    materialEfficiency: me,
    timeEfficiency: te,
    runs: -1,
    quantity: 1,
  } as OwnedBlueprint;
}

function importedBp(typeId: number, me: number, te: number): ImportedBlueprint {
  return { typeId, name: "Imported Blueprint", me, te };
}

function baseInput(
  overrides: Partial<ComposeProfitParamsInput> = {},
): ComposeProfitParamsInput {
  return {
    regionId: 10000002,
    stationId: null,
    runs: 1,
    me: 0,
    useOwnedMe: false,
    ownedMe: {},
    te: 0,
    ownedTe: {},
    timeSkill: 5,
    structure: "npc",
    rigMePct: 0,
    rigTePct: 0,
    rigCostPct: 0,
    useStock: false,
    stock: undefined,
    buildComponents: false,
    costIndexPct: 5,
    facilityTaxPct: 0,
    includeSaleCost: false,
    sellTaxPct: 4.5,
    sellBrokerPct: 3,
    materialBasis: "sellPercentile",
    productBasis: "sellPercentile",
    blueprintCostPerRun: 0,
    inventionSkill: 5,
    decryptorTypeId: null,
    productBestHub: false,
    ...overrides,
  };
}

describe("bestResearchedMap", () => {
  it("takes the max ME across owned copies of the same blueprint", () => {
    const map = bestResearchedMap(
      [ownedBp(1, 5, 10), ownedBp(1, 10, 4)],
      [],
      "materialEfficiency",
      "me",
    );
    expect(map).toEqual({ 1: 10 });
  });

  it("layers an imported entry on top without lowering an owned value", () => {
    const map = bestResearchedMap(
      [ownedBp(1, 10, 0)],
      [importedBp(1, 4, 0)],
      "materialEfficiency",
      "me",
    );
    expect(map[1]).toBe(10);
  });

  it("lets an imported entry raise the ceiling for a blueprint that isn't owned", () => {
    const map = bestResearchedMap(
      [],
      [importedBp(2, 8, 0)],
      "materialEfficiency",
      "me",
    );
    expect(map[2]).toBe(8);
  });
});

describe("composeStructureBonuses", () => {
  it("keeps meBonus at exactly 1 for an unbonused NPC station with no rig", () => {
    const { meBonus, costBonus, structureTePct } = composeStructureBonuses(
      "npc",
      0,
      0,
      0,
    );
    expect(meBonus).toBe(1);
    expect(costBonus).toBe(0);
    expect(structureTePct).toBe(0);
  });

  it("multiplies the structure ME bonus by the rig bonus, not just adds it", () => {
    // Raitaru meBonus 0.99, with a 2% rig ME bonus on top.
    const { meBonus } = composeStructureBonuses("raitaru", 2, 0, 0);
    expect(meBonus).toBeCloseTo(0.99 * (1 - 2 / 100), 10);
  });

  it("adds rig time bonus onto the structure's TE percent", () => {
    const { structureTePct } = composeStructureBonuses("azbel", 0, 5, 0);
    expect(structureTePct).toBe(20 + 5);
  });

  it("composes cost bonuses multiplicatively (stacking discounts, not adding)", () => {
    // Sotiyo costBonus 0.05, plus a 10% rig cost bonus.
    const { costBonus } = composeStructureBonuses("sotiyo", 0, 0, 10);
    expect(costBonus).toBeCloseTo(1 - (1 - 0.05) * (1 - 0.1), 10);
    // Explicitly not the naive (wrong) sum.
    expect(costBonus).not.toBeCloseTo(0.05 + 0.1, 10);
  });
});

describe("inventionCostPerUnit", () => {
  it("amortizes attempt cost over expected yield (probability × runs)", () => {
    // 100k per attempt, 25% chance, 10 runs/success -> expected yield 2.5 units.
    expect(inventionCostPerUnit(100_000, 0.25, 10)).toBeCloseTo(40_000, 6);
  });

  it("returns 0 when expected yield is zero instead of dividing by zero", () => {
    expect(inventionCostPerUnit(100_000, 0, 10)).toBe(0);
    expect(inventionCostPerUnit(100_000, 0.5, 0)).toBe(0);
  });
});

describe("resolveStock", () => {
  it("returns an empty map when stock usage is off, even if stock data exists", () => {
    expect(resolveStock(false, { 1: 50 })).toEqual({});
  });

  it("returns the stock map when enabled", () => {
    expect(resolveStock(true, { 1: 50 })).toEqual({ 1: 50 });
  });

  it("falls back to an empty map when enabled but stock hasn't loaded yet", () => {
    expect(resolveStock(true, undefined)).toEqual({});
  });
});

describe("countDirtySettings", () => {
  it("returns 0 when nothing changed", () => {
    const s = { a: 1, b: "x" };
    expect(countDirtySettings(s, { ...s })).toBe(0);
  });

  it("counts exactly the keys that differ", () => {
    const current = { regionId: 1, runs: 2, me: 3 };
    const last = { regionId: 1, runs: 9, me: 9 };
    expect(countDirtySettings(current, last)).toBe(2);
  });

  it("flags every pricing-relevant param individually", () => {
    const current = {
      regionId: 10000002,
      runs: 1,
      me: 0,
      useStock: false,
      structure: "npc",
    };
    for (const key of Object.keys(current) as (keyof typeof current)[]) {
      const last = { ...current, [key]: "definitely-different" };
      expect(countDirtySettings(current, last)).toBe(1);
    }
  });
});

describe("composeProfitParams", () => {
  it("uses owned ME/TE overrides instead of the manual value when enabled", () => {
    const params = composeProfitParams(
      baseInput({
        me: 5,
        te: 8,
        useOwnedMe: true,
        ownedMe: { 10: 10 },
        ownedTe: { 10: 20 },
      }),
    );
    expect(params.me).toBe(5); // manual value still passed as the fallback
    expect(params.ownedMe).toEqual({ 10: 10 }); // engine prefers this for owned BPs
    expect(params.ownedTe).toEqual({ 10: 20 });
  });

  it("suppresses the owned ME/TE overlay entirely when the toggle is off", () => {
    const params = composeProfitParams(
      baseInput({
        useOwnedMe: false,
        ownedMe: { 10: 10 },
        ownedTe: { 10: 20 },
      }),
    );
    expect(params.ownedMe).toEqual({});
    expect(params.ownedTe).toEqual({});
  });

  it("nets stock only when useStock is on", () => {
    const withStock = composeProfitParams(
      baseInput({ useStock: true, stock: { 5: 3 } }),
    );
    expect(withStock.stock).toEqual({ 5: 3 });

    const withoutStock = composeProfitParams(
      baseInput({ useStock: false, stock: { 5: 3 } }),
    );
    expect(withoutStock.stock).toEqual({});
  });

  it("converts percentage inputs to fractions", () => {
    const params = composeProfitParams(
      baseInput({
        costIndexPct: 12.5,
        facilityTaxPct: 2,
        includeSaleCost: true,
        sellTaxPct: 4.5,
        sellBrokerPct: 3,
      }),
    );
    expect(params.systemCostIndex).toBeCloseTo(0.125, 10);
    expect(params.facilityTax).toBeCloseTo(0.02, 10);
    expect(params.salesTax).toBeCloseTo(0.045, 10);
    expect(params.brokerFee).toBeCloseTo(0.03, 10);
  });

  it("folds structure + rig bonuses into the engine's meBonus/costBonus/structureTePct", () => {
    const params = composeProfitParams(
      baseInput({
        structure: "raitaru",
        rigMePct: 2,
        rigTePct: 5,
        rigCostPct: 10,
      }),
    );
    expect(params.meBonus).toBeCloseTo(0.99 * (1 - 2 / 100), 10);
    expect(params.structureTePct).toBe(15 + 5);
    expect(params.costBonus).toBeCloseTo(1 - (1 - 0.03) * (1 - 0.1), 10);
  });
});
