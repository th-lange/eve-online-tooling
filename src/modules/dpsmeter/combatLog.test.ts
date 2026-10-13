import { describe, expect, it } from "vitest";
import type { DpsEvent } from "../../lib/api";
import {
  appendEvents,
  groupEventsByBucket,
  LOG_BUFFER,
  pendingGhostBucket,
} from "./dpsMeterShared";
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

describe("appendEvents", () => {
  it("appends uncapped by default — the page log keeps the whole session", () => {
    const full = Array.from({ length: LOG_BUFFER }, () => ev({}));
    const next = appendEvents(full, [ev({ amount: 999 })]);
    expect(next).toHaveLength(LOG_BUFFER + 1);
    expect(next[next.length - 1].amount).toBe(999);
  });

  it("caps at the given limit — the fight overlay's rolling footer", () => {
    const full = Array.from({ length: LOG_BUFFER }, () => ev({}));
    const overflowed = appendEvents(full, [ev({ amount: 999 })], LOG_BUFFER);
    expect(overflowed).toHaveLength(LOG_BUFFER);
    // The oldest entry was dropped, the new one kept at the tail.
    expect(overflowed[overflowed.length - 1].amount).toBe(999);
  });

  it("is a no-op append for an empty batch", () => {
    const prev = [ev({})];
    expect(appendEvents(prev, [])).toBe(prev);
  });
});

describe("groupEventsByBucket", () => {
  it("groups time-ordered events onto the 5 s grid, keyed by bucket start", () => {
    const events = [
      ev({ ts: 1000 }),
      ev({ ts: 1003 }),
      ev({ ts: 1005 }),
      ev({ ts: 1012 }), // bucket 1010 — the empty 1005..1010 gap is no group
    ];
    const groups = groupEventsByBucket(events);
    expect(groups.map((g) => g.start)).toEqual([1000, 1005, 1010]);
    expect(groups[0].events).toHaveLength(2);
    expect(groups[1].events).toHaveLength(1);
    expect(groups[2].events[0].ts).toBe(1012);
  });

  it("returns no groups for an empty log", () => {
    expect(groupEventsByBucket([])).toEqual([]);
  });
});

describe("pendingGhostBucket", () => {
  it("sums damage in/out over the newest event's bucket when it isn't finalized", () => {
    const events = [
      ev({ ts: 1003, amount: 50 }), // older bucket — excluded
      ev({ ts: 1006, kind: "damageOut", amount: 100 }),
      ev({ ts: 1008, kind: "damageIn", amount: 30 }),
      ev({ ts: 1009, kind: "mining", amount: 40 }), // not damage — ignored
    ];
    expect(pendingGhostBucket(events, 1005)).toEqual({
      start: 1005,
      damageOut: 100,
      damageIn: 30,
    });
  });

  it("is null once the newest bucket is already finalized, and for no events", () => {
    expect(pendingGhostBucket([ev({ ts: 1003 })], 1005)).toBeNull();
    expect(pendingGhostBucket([], null)).toBeNull();
  });

  it("covers the very first bucket when nothing is finalized yet", () => {
    expect(pendingGhostBucket([ev({ ts: 1002, amount: 10 })], null)).toEqual({
      start: 1000,
      damageOut: 10,
      damageIn: 0,
    });
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
