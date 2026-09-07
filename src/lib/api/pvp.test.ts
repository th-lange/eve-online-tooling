import { describe, expect, it, vi } from "vitest";

// pvp.ts imports `invoke` at module load; stub it (lostFitToEft never calls it).
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

import { lostFitToEft, type LostFit } from "./pvp";

const FIT: LostFit = {
  hullTypeId: 587,
  hullName: "Rifter",
  lostCount: 1,
  killmailId: 1,
  lastLost: "2026-01-01T00:00:00Z",
  modules: [
    { typeId: 1, name: "200mm AutoCannon II", slot: "high", quantity: 3 },
    { typeId: 2, name: "1MN Afterburner II", slot: "mid", quantity: 1 },
    { typeId: 3, name: "Gyrostabilizer II", slot: "low", quantity: 2 },
    {
      typeId: 4,
      name: "Small Projectile Collision Accelerator I",
      slot: "rig",
      quantity: 1,
    },
    { typeId: 5, name: "Warrior II", slot: "drone", quantity: 5 },
  ],
};

describe("lostFitToEft", () => {
  it("opens with the EFT hull header", () => {
    expect(lostFitToEft(FIT).split("\n")[0]).toBe("[Rifter, Rifter]");
  });

  it("orders module slots low → mid → high → rig", () => {
    const lines = lostFitToEft(FIT).split("\n");
    expect(lines.indexOf("Gyrostabilizer II")).toBeLessThan(
      lines.indexOf("1MN Afterburner II"),
    );
    expect(lines.indexOf("1MN Afterburner II")).toBeLessThan(
      lines.indexOf("200mm AutoCannon II"),
    );
    expect(lines.indexOf("200mm AutoCannon II")).toBeLessThan(
      lines.indexOf("Small Projectile Collision Accelerator I"),
    );
  });

  it("repeats a module once per unit of quantity", () => {
    const lines = lostFitToEft(FIT).split("\n");
    expect(lines.filter((l) => l === "200mm AutoCannon II")).toHaveLength(3);
    expect(lines.filter((l) => l === "Gyrostabilizer II")).toHaveLength(2);
  });

  it("puts drones after a blank line as name x<qty>", () => {
    expect(lostFitToEft(FIT)).toContain("\n\nWarrior II x5");
  });

  it("skips a slot with no modules and needs no drone block", () => {
    const eft = lostFitToEft({
      ...FIT,
      modules: [
        { typeId: 2, name: "1MN Afterburner II", slot: "mid", quantity: 1 },
      ],
    });
    expect(eft).toBe("[Rifter, Rifter]\n1MN Afterburner II");
  });
});
