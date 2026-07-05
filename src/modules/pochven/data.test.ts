import { describe, expect, it } from "vitest";
import {
  POCHVEN_INTERNAL_LINKS,
  POCHVEN_META,
  pochvenTriangle,
  systemsByClade,
  systemsByRole,
} from "./data";
import { dominantBand } from "./visual";

describe("POCHVEN_META", () => {
  it("covers all 27 systems: 9 per clade, 1 home + 2 borders + 6 internal", () => {
    expect(Object.keys(POCHVEN_META)).toHaveLength(27);
    const byClade = systemsByClade();
    for (const clade of ["Perun", "Svarog", "Veles"] as const) {
      expect(byClade[clade]).toHaveLength(9);
    }
    const byRole = systemsByRole();
    expect(byRole.Home).toHaveLength(3);
    expect(byRole.Border).toHaveLength(6);
    expect(byRole.Internal).toHaveLength(18);
  });

  it("names the three clade homes", () => {
    expect(POCHVEN_META.Kino).toEqual({ clade: "Perun", role: "Home" });
    expect(POCHVEN_META.Archee).toEqual({ clade: "Veles", role: "Home" });
    expect(POCHVEN_META.Niarja).toEqual({ clade: "Svarog", role: "Home" });
  });
});

describe("POCHVEN_INTERNAL_LINKS", () => {
  it("references known systems only", () => {
    for (const [a, b] of POCHVEN_INTERNAL_LINKS) {
      expect(POCHVEN_META[a]).toBeDefined();
      expect(POCHVEN_META[b]).toBeDefined();
    }
  });
});

describe("pochvenTriangle", () => {
  it("positions every system and links every clade edge", () => {
    const tri = pochvenTriangle();
    for (const name of Object.keys(POCHVEN_META)) {
      expect(tri.pos[name]).toBeDefined();
    }
    // 3 edges × (7 line links + 1 home branch) + 3 corner links.
    expect(tri.edges.length).toBe(3 * 8 + 3);
  });
});

describe("dominantBand", () => {
  it("picks the band with most candidates, ties to the safer band", () => {
    expect(dominantBand({ hisec: 10, lowsec: 11, nullsec: 0 })).toBe("lowsec");
    expect(dominantBand({ hisec: 5, lowsec: 5, nullsec: 0 })).toBe("hisec");
    expect(dominantBand({ hisec: 0, lowsec: 2, nullsec: 7 })).toBe("nullsec");
  });
});
