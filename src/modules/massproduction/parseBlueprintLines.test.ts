import { describe, expect, it } from "vitest";
import {
  exportBlueprintLines,
  parseBlueprintLine,
  parseBlueprintLines,
} from "./parseBlueprintLines";

describe("parseBlueprintLine", () => {
  it("parses a bare name with no build-run override", () => {
    expect(parseBlueprintLine("5MN Microwarpdrive II Blueprint")).toEqual({
      name: "5MN Microwarpdrive II Blueprint",
      buildRuns: null,
    });
  });

  it("parses a name plus a count (tab or space separated)", () => {
    expect(parseBlueprintLine("Rifter Blueprint\t5")).toEqual({
      name: "Rifter Blueprint",
      buildRuns: 5,
    });
    expect(parseBlueprintLine("Rifter Blueprint 5")).toEqual({
      name: "Rifter Blueprint",
      buildRuns: 5,
    });
  });

  it("does not mistake a number inside the name for the count", () => {
    expect(
      parseBlueprintLine("125mm Gatling AutoCannon II Blueprint 10"),
    ).toEqual({
      name: "125mm Gatling AutoCannon II Blueprint",
      buildRuns: 10,
    });
  });

  it("handles thousands separators", () => {
    expect(parseBlueprintLine("Tritanium\t1,000")).toEqual({
      name: "Tritanium",
      buildRuns: 1000,
    });
  });

  it("leaves blank and quantity-first lines unparsed", () => {
    expect(parseBlueprintLine("   ")).toBeNull();
    expect(parseBlueprintLine("5 Rifter Blueprint")).toBeNull();
  });
});

describe("parseBlueprintLines", () => {
  it("keeps only parseable lines, preserving per-line override presence", () => {
    const text = [
      "5MN Microwarpdrive II Blueprint",
      "Rifter Blueprint\t5",
      "",
      "garbage 1000 trailing",
    ].join("\n");
    expect(parseBlueprintLines(text)).toEqual([
      { name: "5MN Microwarpdrive II Blueprint", buildRuns: null },
      { name: "Rifter Blueprint", buildRuns: 5 },
      { name: "garbage", buildRuns: 1000 },
    ]);
  });
});

describe("exportBlueprintLines", () => {
  it("round-trips through parseBlueprintLines", () => {
    const lines = [
      { name: "5MN Microwarpdrive II Blueprint", runs: null },
      { name: "Rifter Blueprint", runs: 5 },
    ];
    const text = exportBlueprintLines(lines);
    expect(text).toBe("5MN Microwarpdrive II Blueprint\nRifter Blueprint\t5");
    expect(parseBlueprintLines(text)).toEqual([
      { name: "5MN Microwarpdrive II Blueprint", buildRuns: null },
      { name: "Rifter Blueprint", buildRuns: 5 },
    ]);
  });

  it("omits the count for a null run value", () => {
    expect(
      exportBlueprintLines([{ name: "Rifter Blueprint", runs: null }]),
    ).toBe("Rifter Blueprint");
  });
});
