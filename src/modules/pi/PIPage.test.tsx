import { describe, expect, it } from "vitest";
import { extractionAdvice } from "./PIPage";
import type { ColonyView } from "../../lib/api";

const PLASMOID = 1;
const WATER = 2;
const T2_ITEM = 3;

/** Colony where plasmoids (extracted P0) have piled up in storage while the
 * factory is starved of water (also extracted, but storage is empty and the
 * balance is running a deficit). */
function colony(overrides: Partial<ColonyView> = {}): ColonyView {
  return {
    planetId: 1,
    systemId: 1,
    systemName: "Jita",
    planetType: "gas",
    upgradeLevel: 3,
    pinCount: 6,
    extractors: [
      {
        productTypeId: PLASMOID,
        product: "Plasmoids",
        qtyPerCycle: 1000,
        cycleTime: 3600,
        installTime: null,
        expiryTime: null,
      },
      {
        productTypeId: WATER,
        product: "Water",
        qtyPerCycle: 1000,
        cycleTime: 3600,
        installTime: null,
        expiryTime: null,
      },
    ],
    storage: [
      {
        name: "Storage Facility",
        usedVolume: 9500,
        capacity: 10000,
        contents: [
          { typeId: PLASMOID, name: "Plasmoids", amount: 9000, volume: 9000 },
          { typeId: WATER, name: "Water", amount: 0, volume: 0 },
        ],
      },
    ],
    balance: [
      // Plasmoids: extracted faster than the factory consumes -> net positive,
      // and it's already sitting on a huge stockpile.
      {
        typeId: PLASMOID,
        name: "Plasmoids",
        producedPerHour: 1000,
        consumedPerHour: 400,
        net: 600,
      },
      // Water: extracted, but the factory eats more than comes in and there's
      // zero buffer left.
      {
        typeId: WATER,
        name: "Water",
        producedPerHour: 200,
        consumedPerHour: 400,
        net: -200,
      },
      {
        typeId: T2_ITEM,
        name: "T2 Item",
        producedPerHour: 10,
        consumedPerHour: 0,
        net: 10,
      },
    ],
    produced: [],
    needsAttention: false,
    ...overrides,
  };
}

describe("extractionAdvice", () => {
  it("ranks a near-empty, deficit input above the raw net-negative amount alone", () => {
    const { short } = extractionAdvice(colony());
    expect(short[0]?.typeId).toBe(WATER);
    expect(short[0]?.stock).toBe(0);
    expect(short[0]?.runwayHours).toBe(0);
  });

  it("flags an extracted commodity as banking once it's piled up in storage, even without consulting net alone", () => {
    const { over } = extractionAdvice(colony());
    const plasmoids = over.find((r) => r.typeId === PLASMOID);
    expect(plasmoids).toBeDefined();
    expect(plasmoids?.stock).toBe(9000);
  });

  it("still flags banking when net is roughly zero but the stockpile dominates storage", () => {
    const c = colony({
      balance: [
        {
          typeId: PLASMOID,
          name: "Plasmoids",
          producedPerHour: 400,
          consumedPerHour: 400,
          net: 0,
        },
      ],
    });
    const { over } = extractionAdvice(c);
    expect(over.map((r) => r.typeId)).toContain(PLASMOID);
  });

  it("does not flag a non-extracted product as something to ease off", () => {
    const { over } = extractionAdvice(colony());
    expect(over.map((r) => r.typeId)).not.toContain(T2_ITEM);
  });
});
