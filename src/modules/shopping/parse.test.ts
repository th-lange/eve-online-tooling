import { describe, expect, it } from "vitest";
import { parseItems, parseLine } from "./parse";

describe("shopping paste parser", () => {
  it("parses Multibuy name + quantity (space or tab)", () => {
    expect(parseLine("Tritanium 1000")).toEqual({ name: "Tritanium", quantity: 1000 });
    expect(parseLine("Tritanium\t1000")).toEqual({ name: "Tritanium", quantity: 1000 });
  });

  it("keeps multi-word names and ignores trailing columns", () => {
    // Inventory paste: name, qty (with thousands comma), then group/category/volume.
    expect(parseLine("Damage Control II\t5\tModule\t0.5 m3")).toEqual({
      name: "Damage Control II",
      quantity: 5,
    });
    expect(parseLine("Tritanium\t1,000\tMineral\tMaterials")).toEqual({
      name: "Tritanium",
      quantity: 1000,
    });
  });

  it("does not mistake numbers inside a name for the quantity", () => {
    expect(parseLine("125mm Gatling AutoCannon II 10")).toEqual({
      name: "125mm Gatling AutoCannon II",
      quantity: 10,
    });
  });

  it("defaults to quantity 1 when there's no number", () => {
    expect(parseLine("Rifter")).toEqual({ name: "Rifter", quantity: 1 });
  });

  it("leaves blank and quantity-first lines unparsed", () => {
    expect(parseLine("   ")).toBeNull();
    expect(parseLine("1000 Tritanium")).toBeNull(); // name-first only
  });

  it("parseItems keeps only parseable lines", () => {
    const text = "Tritanium 100\n\nDamage Control II\t2\n1000 garbage";
    expect(parseItems(text)).toEqual([
      { name: "Tritanium", quantity: 100 },
      { name: "Damage Control II", quantity: 2 },
    ]);
  });
});
