import { describe, expect, it } from "vitest";
import type { DpsEvent, DpsTick } from "../../lib/api";
import { appendEvents, LOG_BUFFER, nearestTickIndex } from "./dpsMeterShared";
import { eventToneClass, formatEventLine } from "./CombatLogPanel";

function ev(partial: Partial<DpsEvent>): DpsEvent {
  return {
    ts: 1_700_000_000,
    kind: "damageOut",
    amount: 100,
    pilot: "Bob",
    ship: "Caracal",
    weapon: "Heavy Missile Launcher II",
    quality: "Hits",
    ore: null,
    volume: 0,
    ...partial,
  };
}

const hq = {
  misses: 0,
  glances: 0,
  grazes: 0,
  hits: 0,
  penetrates: 0,
  smashes: 0,
  wrecks: 0,
};

function tick(at: number): DpsTick {
  return {
    at,
    windowSecs: 10,
    dpsOut: 0,
    dpsIn: 0,
    logiOut: 0,
    logiIn: 0,
    capWarfareOut: 0,
    capWarfareIn: 0,
    capTransferOut: 0,
    capTransferIn: 0,
    miningM3: 0,
    hitsOut: hq,
    hitsIn: hq,
    byWeapon: [],
    byPilot: [],
  };
}

describe("appendEvents", () => {
  it("appends a batch and caps the buffer at LOG_BUFFER", () => {
    const next = appendEvents([ev({})], [ev({}), ev({})]);
    expect(next).toHaveLength(3);

    const full = Array.from({ length: LOG_BUFFER }, () => ev({}));
    const overflowed = appendEvents(full, [ev({ amount: 999 })]);
    expect(overflowed).toHaveLength(LOG_BUFFER);
    // The oldest entry was dropped, the new one kept at the tail.
    expect(overflowed[overflowed.length - 1].amount).toBe(999);
  });

  it("is a no-op append for an empty batch", () => {
    const prev = [ev({})];
    expect(appendEvents(prev, [])).toEqual(prev);
  });
});

describe("formatEventLine", () => {
  it("renders a normal hit with quality and weapon", () => {
    expect(
      formatEventLine(
        ev({
          kind: "damageOut",
          amount: 450,
          pilot: "Target Pilot",
          ship: "Cruiser",
          weapon: "Dual Giga Pulse Laser II",
          quality: "Wrecks",
        }),
      ),
    ).toBe(
      "450 dmg → Target Pilot (Cruiser) — Dual Giga Pulse Laser II [Wrecks]",
    );
  });

  it("renders a miss without an amount or quality bracket", () => {
    expect(
      formatEventLine(
        ev({ kind: "damageIn", quality: "Misses", pilot: "Attacker" }),
      ),
    ).toBe("Misses ← Attacker (Caracal) — Heavy Missile Launcher II");
  });

  it("renders non-damage kinds without weapon/quality", () => {
    expect(
      formatEventLine(
        ev({
          kind: "repOut",
          amount: 600,
          pilot: "Logi Bro",
          ship: null,
          weapon: null,
          quality: null,
        }),
      ),
    ).toBe("600 repaired → Logi Bro");
    expect(
      formatEventLine(
        ev({
          kind: "scramIn",
          amount: 0,
          pilot: "Tackler",
          ship: null,
          weapon: null,
          quality: null,
        }),
      ),
    ).toBe("Scrambled ← Tackler");
  });

  it("renders mining with ore and volume", () => {
    expect(
      formatEventLine(
        ev({
          kind: "mining",
          amount: 340,
          pilot: null,
          ship: null,
          weapon: null,
          quality: null,
          ore: "Veldspar",
          volume: 136,
        }),
      ),
    ).toBe("Mined 340 Veldspar (136 m³)");
  });
});

describe("eventToneClass", () => {
  it("dims misses regardless of direction", () => {
    expect(eventToneClass(ev({ kind: "damageOut", quality: "Misses" }))).toBe(
      "text-zinc-600",
    );
  });

  it("colors outgoing warm and incoming cool", () => {
    expect(eventToneClass(ev({ kind: "damageOut" }))).toBe("text-sky-400");
    expect(eventToneClass(ev({ kind: "damageIn" }))).toBe("text-rose-400");
  });

  it("colors mining amber", () => {
    expect(eventToneClass(ev({ kind: "mining", quality: null }))).toBe(
      "text-amber-400",
    );
  });
});

describe("nearestTickIndex", () => {
  it("picks the closest tick by time, breaking a tie toward the earlier one", () => {
    const ticks = [tick(100), tick(110), tick(120), tick(130)];
    expect(nearestTickIndex(ticks, 100)).toBe(0);
    expect(nearestTickIndex(ticks, 113)).toBe(1);
    expect(nearestTickIndex(ticks, 118)).toBe(2);
    expect(nearestTickIndex(ticks, 999)).toBe(3); // clamps to the last tick
    expect(nearestTickIndex(ticks, 115)).toBe(1); // exact midpoint — earlier wins
  });

  it("returns null for an empty buffer", () => {
    expect(nearestTickIndex([], 100)).toBeNull();
  });
});
