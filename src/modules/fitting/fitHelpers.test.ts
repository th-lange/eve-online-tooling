import { describe, expect, it } from "vitest";
import { stackCargo } from "./fitHelpers";
import type { Fit } from "../../lib/api";

const FIT: Fit = {
  id: "",
  name: "test",
  shipTypeId: 587,
  items: [
    { typeId: 10, slot: "high", index: 0, state: "active", quantity: 1 },
    { typeId: 20, slot: "cargo", index: 0, state: "active", quantity: 100 },
    { typeId: 20, slot: "cargo", index: 1, state: "active", quantity: 50 },
    { typeId: 30, slot: "cargo", index: 2, state: "active", quantity: 1 },
    { typeId: 40, slot: "drone", index: 0, state: "active", quantity: 5 },
  ],
};

describe("stackCargo", () => {
  it("merges duplicate cargo into one stack, summing quantity", () => {
    const t20 = stackCargo(FIT).items.filter(
      (i) => i.slot === "cargo" && i.typeId === 20,
    );
    expect(t20).toHaveLength(1);
    expect(t20[0].quantity).toBe(150);
  });

  it("leaves distinct cargo, modules and drones untouched", () => {
    const items = stackCargo(FIT).items;
    // Two cargo types remain (20 merged, 30 distinct).
    expect(items.filter((i) => i.slot === "cargo")).toHaveLength(2);
    expect(items.filter((i) => i.slot === "high")).toHaveLength(1);
    const drone = items.find((i) => i.slot === "drone");
    expect(drone?.quantity).toBe(5);
  });

  it("reindexes cargo stacks from zero in first-seen order", () => {
    const cargo = stackCargo(FIT).items.filter((i) => i.slot === "cargo");
    expect(cargo.map((i) => i.index)).toEqual([0, 1]);
  });

  it("is idempotent", () => {
    const once = stackCargo(FIT);
    expect(stackCargo(once)).toEqual(once);
  });
});
