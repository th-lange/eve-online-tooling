import { describe, expect, it } from "vitest";
import { maxShipLabel, whTypeByCode } from "./whTypes";
import type { WormholeType } from "../../lib/api";

const TYPES: WormholeType[] = [
  {
    typeId: 30832,
    code: "N766",
    destClassId: 2,
    destClassLabel: "C2",
    maxStableMass: 2_000_000_000,
    maxJumpMass: 300_000_000,
    maxStableTimeMin: 1440,
    massRegen: 0,
  },
  {
    typeId: 30371,
    code: "K162",
    destClassId: 0,
    destClassLabel: "exit (variable)",
    maxStableMass: 3_000_000_000,
    maxJumpMass: 1_000_000_000,
    maxStableTimeMin: 1440,
    massRegen: 0,
  },
];

describe("whTypeByCode", () => {
  it("matches case-insensitively and trims", () => {
    expect(whTypeByCode("n766", TYPES)?.code).toBe("N766");
    expect(whTypeByCode("  K162 ", TYPES)?.destClassLabel).toBe("exit (variable)");
  });
  it("returns undefined for empty or unknown codes", () => {
    expect(whTypeByCode("", TYPES)).toBeUndefined();
    expect(whTypeByCode("ZZZZ", TYPES)).toBeUndefined();
  });
});

describe("maxShipLabel", () => {
  it("buckets max jump mass into hull classes", () => {
    expect(maxShipLabel(5_000_000)).toBe("frigate");
    expect(maxShipLabel(62_000_000)).toBe("cruiser");
    expect(maxShipLabel(300_000_000)).toBe("battleship");
    expect(maxShipLabel(1_000_000_000)).toBe("freighter");
    expect(maxShipLabel(1_350_000_000)).toBe("capital");
    expect(maxShipLabel(null)).toBe("unknown");
    expect(maxShipLabel(0)).toBe("unknown");
  });
});
