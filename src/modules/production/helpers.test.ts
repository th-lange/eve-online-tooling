import { describe, expect, it } from "vitest";
import { classifyPaste, dedupNames, isExcludedMetaGroup } from "./helpers";

describe("dedupNames", () => {
  it("keeps first occurrence, case-insensitive, in input order", () => {
    expect(
      dedupNames([
        { name: "Rifter" },
        { name: "Warrior II" },
        { name: "rifter" },
        { name: "Warrior II" },
      ]),
    ).toEqual(["Rifter", "Warrior II"]);
  });
});

describe("isExcludedMetaGroup", () => {
  it("flags Abyssal, Faction, Storyline, Deadspace, and Officer", () => {
    expect(isExcludedMetaGroup("Abyssal")).toBe(true);
    expect(isExcludedMetaGroup("Faction")).toBe(true);
    expect(isExcludedMetaGroup("Storyline")).toBe(true);
    expect(isExcludedMetaGroup("Deadspace")).toBe(true);
    expect(isExcludedMetaGroup("Officer")).toBe(true);
  });

  it("leaves plain Tech I/II untouched (mutually exclusive groups)", () => {
    expect(isExcludedMetaGroup("Tech I")).toBe(false);
    expect(isExcludedMetaGroup("Tech II")).toBe(false);
  });

  it("treats missing meta group as not excluded", () => {
    expect(isExcludedMetaGroup(null)).toBe(false);
    expect(isExcludedMetaGroup(undefined)).toBe(false);
  });
});

describe("classifyPaste", () => {
  const rows = [
    { productName: "Rifter", roi: 0.5 }, // 50%
    { productName: "Warrior II", roi: -0.1 }, // -10%
    { productName: "Hobgoblin II", roi: 0.05 }, // 5%
    { productName: "Capital Ship", roi: null }, // zero cost / unknowable
  ];

  it("counts items at or above the min ROI as worth selling", () => {
    const v = classifyPaste(
      ["Rifter", "Warrior II", "Hobgoblin II", "Capital Ship", "Tritanium"],
      rows,
      0.2, // 20%
    );
    expect(v).toEqual({
      worth: ["Rifter"],
      skip: ["Warrior II", "Hobgoblin II", "Capital Ship"],
      notBuildable: ["Tritanium"],
    });
  });

  it("lowering the threshold promotes items into worth", () => {
    const v = classifyPaste(["Hobgoblin II", "Warrior II"], rows, 0.05);
    expect(v.worth).toEqual(["Hobgoblin II"]);
    expect(v.skip).toEqual(["Warrior II"]);
  });

  it("null ROI never clears the bar, even at 0%", () => {
    expect(classifyPaste(["Capital Ship"], rows, 0).skip).toEqual([
      "Capital Ship",
    ]);
  });

  it("matches product names case-insensitively", () => {
    expect(classifyPaste(["rIfTeR"], rows, 0.2).worth).toEqual(["rIfTeR"]);
  });

  it("empty input yields empty buckets", () => {
    expect(classifyPaste([], rows, 0.2)).toEqual({
      worth: [],
      skip: [],
      notBuildable: [],
    });
  });
});
