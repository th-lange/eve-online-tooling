import { describe, expect, it } from "vitest";
import { tickDown, tickSize, tickUp } from "./orderTick";

describe("order price ticks (#1167)", () => {
  it("is 0.01 ISK below 100 and scales with the decade above it", () => {
    expect(tickSize(5)).toBe(0.01);
    expect(tickSize(99.99)).toBe(0.01);
    expect(tickSize(1234)).toBe(1);
    expect(tickSize(1_234_000)).toBe(1000);
  });

  it("undercuts a 1,234,000 sell to 1,233,000, not 1,233,999.99", () => {
    expect(tickDown(1_234_000)).toBe(1_233_000);
  });

  it("overbids a buy by one valid tick", () => {
    expect(tickUp(1_234_000)).toBe(1_235_000);
    expect(tickUp(12.34)).toBe(12.35);
  });

  it("crosses decade boundaries with the finer tick", () => {
    expect(tickDown(1000)).toBe(999.9);
    expect(tickUp(999.9)).toBe(1000);
    expect(tickDown(100)).toBe(99.99);
  });

  it("never goes below zero", () => {
    expect(tickDown(0.01)).toBe(0);
    expect(tickDown(0)).toBe(0);
  });
});
