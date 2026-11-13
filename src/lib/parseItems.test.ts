import { describe, expect, it } from "vitest";
import { parseItems, parseLine } from "./parseItems";

describe("shared paste item parser", () => {
  it("parses Multibuy name + quantity (space or tab)", () => {
    expect(parseLine("Tritanium 1000")).toEqual({
      name: "Tritanium",
      quantity: 1000,
    });
    expect(parseLine("Tritanium\t1000")).toEqual({
      name: "Tritanium",
      quantity: 1000,
    });
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

  it("parses a single-space multibuy line (appraisal's old weak parser required a tab or 2+ spaces)", () => {
    expect(parseLine("Tritanium 100")).toEqual({
      name: "Tritanium",
      quantity: 100,
    });
    expect(parseItems("Tritanium 100\nPyerite 250")).toEqual([
      { name: "Tritanium", quantity: 100 },
      { name: "Pyerite", quantity: 250 },
    ]);
  });

  it("keeps a number inside the name (#1165)", () => {
    // Tab: first cell is the name, whatever it contains.
    expect(parseLine("Navy Cap Booster 400\t20")).toEqual({
      name: "Navy Cap Booster 400",
      quantity: 20,
    });
    expect(parseLine("Cap Booster 25\t3\tCharge\t0.1 m3")).toEqual({
      name: "Cap Booster 25",
      quantity: 3,
    });
    // Spaces: the quantity is the last of the first numeric run.
    expect(parseLine("Navy Cap Booster 400 20")).toEqual({
      name: "Navy Cap Booster 400",
      quantity: 20,
    });
    expect(parseLine("Navy Cap Booster 400 x12")).toEqual({
      name: "Navy Cap Booster 400",
      quantity: 12,
    });
    // A leading X5-style token is part of the name when a quantity follows.
    expect(parseLine("X5 Enduring Stasis Webifier 2")).toEqual({
      name: "X5 Enduring Stasis Webifier",
      quantity: 2,
    });
    expect(parseLine("X5 Enduring Stasis Webifier\t2")).toEqual({
      name: "X5 Enduring Stasis Webifier",
      quantity: 2,
    });
  });
});
