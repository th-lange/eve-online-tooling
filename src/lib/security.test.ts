import { describe, expect, it } from "vitest";
import { SEC_HEX, SEC_TEXT_CLASS, secBand } from "./security";

describe("secBand", () => {
  it("bands clear-cut values like the game does", () => {
    expect(secBand(1.0)).toBe("hisec");
    expect(secBand(0.9)).toBe("hisec");
    expect(secBand(0.5)).toBe("hisec");
    expect(secBand(0.4)).toBe("lowsec");
    expect(secBand(0.1)).toBe("lowsec");
    expect(secBand(0.0)).toBe("nullsec");
    expect(secBand(-0.5)).toBe("nullsec");
    expect(secBand(-1.0)).toBe("nullsec");
  });

  it("rounds first at the hisec boundary: true sec 0.45–0.4999 displays as 0.5 and is high-sec in game", () => {
    expect(secBand(0.45)).toBe("hisec");
    expect(secBand(0.4527)).toBe("hisec");
    expect(secBand(0.4999)).toBe("hisec");
  });

  it("keeps true sec just under 0.45 in low-sec (displays as 0.4)", () => {
    expect(secBand(0.4499)).toBe("lowsec");
    expect(secBand(0.449999)).toBe("lowsec");
  });

  it("does not round barely-positive systems down into null-sec (they are low-sec in game)", () => {
    expect(secBand(0.01)).toBe("lowsec");
    expect(secBand(0.049)).toBe("lowsec");
  });
});

describe("colour maps", () => {
  it("cover every band in both rendering styles", () => {
    for (const band of ["hisec", "lowsec", "nullsec"] as const) {
      expect(SEC_TEXT_CLASS[band]).toMatch(/^text-/);
      expect(SEC_HEX[band]).toMatch(/^#[0-9a-f]{6}$/);
    }
  });
});
