import { describe, it, expect } from "vitest";
import {
  POCHVEN_SYSTEMS,
  POCHVEN_META,
  entriesInRegion,
  pochvenRegions,
  systemsByRole,
  systemsByClade,
  INTERNAL,
} from "./data";

describe("Pochven data", () => {
  it("has all 27 systems", () => {
    expect(POCHVEN_SYSTEMS).toHaveLength(27);
  });

  it("finds entries whose C729 spawns in a region", () => {
    const forge = entriesInRegion("The Forge").map((m) => m.name);
    // Sample of the systems that list The Forge as a spawn region.
    expect(forge).toEqual(
      expect.arrayContaining(["Senda", "Otanuomi", "Niarja", "Sakenta"]),
    );
    // Angymonne only spawns in Everyshore — not The Forge.
    expect(forge).not.toContain("Angymonne");
  });

  it("reports candidate counts and other regions", () => {
    const senda = entriesInRegion("The Forge").find((m) => m.name === "Senda");
    expect(senda?.count).toBe(7);
    expect(senda?.others).toHaveLength(0); // Senda is Forge-only

    const niarja = entriesInRegion("Domain").find((m) => m.name === "Niarja");
    expect(niarja?.count).toBe(16);
    expect(niarja?.others.map((z) => z.region)).toEqual(
      expect.arrayContaining(["Kador", "The Citadel", "The Forge"]),
    );
  });

  it("has clade + role for every system, 9 per clade (1 Home/2 Border/6 Internal)", () => {
    expect(Object.keys(POCHVEN_META)).toHaveLength(27);
    // Every dataset system has metadata.
    for (const s of POCHVEN_SYSTEMS) expect(POCHVEN_META[s.name]).toBeDefined();

    const byClade = systemsByClade();
    expect(byClade.Perun).toHaveLength(9);
    expect(byClade.Svarog).toHaveLength(9);
    expect(byClade.Veles).toHaveLength(9);

    const byRole = systemsByRole();
    expect(byRole.Home).toHaveLength(3); // 1 per clade
    expect(byRole.Border).toHaveLength(6); // 2 per clade
    expect(byRole.Internal).toHaveLength(18); // 6 per clade
    expect(byRole.Home).toEqual(
      expect.arrayContaining(["Kino", "Niarja", "Archee"]),
    );
  });

  it("excludes the internal pseudo-region from k-space matches and region list", () => {
    expect(entriesInRegion(INTERNAL)).toHaveLength(0);
    expect(pochvenRegions()).not.toContain(INTERNAL);
    expect(pochvenRegions()).toEqual(
      expect.arrayContaining(["The Forge", "Domain", "Black Rise"]),
    );
  });
});
