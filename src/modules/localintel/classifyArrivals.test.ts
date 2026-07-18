import { describe, expect, it } from "vitest";
import type { LocalPilot } from "../../lib/api";
import { classifyArrivals } from "./classifyArrivals";

function pilot(overrides: Partial<LocalPilot> & { characterId: number }): LocalPilot {
  return {
    name: `Pilot ${overrides.characterId}`,
    corporationId: 98_000_001,
    corporation: "Some Corp",
    allianceId: null,
    alliance: null,
    standing: null,
    threat: "neutral",
    ...overrides,
  };
}

const OPTS_DEFAULT = { alertAnyRed: true, alertNeutrals: false };

describe("classifyArrivals", () => {
  it("alerts on first scan — every pilot is 'new' when prevIds is empty", () => {
    const pilots = [pilot({ characterId: 1, threat: "red" })];
    const result = classifyArrivals(new Set(), pilots, new Set(), OPTS_DEFAULT);

    expect(result.newIds).toEqual(new Set([1]));
    expect(result.notice).toEqual({ kind: "red", pilots: [pilots[0]] });
    expect(result.alarm).toBe(true);
  });

  it("watchlist beats red when both arrive together", () => {
    const watched = pilot({ characterId: 1, corporationId: 5, threat: "red" });
    const red = pilot({ characterId: 2, threat: "red" });
    const result = classifyArrivals(
      new Set(),
      [watched, red],
      new Set([5]),
      OPTS_DEFAULT,
    );

    expect(result.notice).toEqual({ kind: "watchlist", pilots: [watched] });
    expect(result.alarm).toBe(true);
  });

  it("handles alliance-null pilots without throwing", () => {
    const p = pilot({ characterId: 1, allianceId: null, threat: "blue" });
    expect(() =>
      classifyArrivals(new Set(), [p], new Set([999]), OPTS_DEFAULT),
    ).not.toThrow();
    const result = classifyArrivals(new Set(), [p], new Set([999]), OPTS_DEFAULT);
    expect(result.notice).toBeNull();
    expect(result.alarm).toBe(false);
  });

  it("re-pasting the same pilots is a no-op (no new notice, no alarm)", () => {
    const pilots = [
      pilot({ characterId: 1, threat: "red" }),
      pilot({ characterId: 2, threat: "neutral" }),
    ];
    const prevIds = new Set(pilots.map((p) => p.characterId));
    const result = classifyArrivals(prevIds, pilots, new Set(), OPTS_DEFAULT);

    expect(result.newIds.size).toBe(0);
    expect(result.notice).toBeNull();
    expect(result.alarm).toBe(false);
  });

  it("respects alertAnyRed=false — no red notice or alarm even on arrival", () => {
    const pilots = [pilot({ characterId: 1, threat: "red" })];
    const result = classifyArrivals(new Set(), pilots, new Set(), {
      alertAnyRed: false,
      alertNeutrals: false,
    });

    expect(result.notice).toBeNull();
    expect(result.alarm).toBe(false);
  });

  it("respects alertNeutrals opt-in", () => {
    const pilots = [pilot({ characterId: 1, threat: "neutral" })];
    const withOptIn = classifyArrivals(new Set(), pilots, new Set(), {
      alertAnyRed: false,
      alertNeutrals: true,
    });
    expect(withOptIn.notice).toEqual({ kind: "neutral", pilots });
    expect(withOptIn.alarm).toBe(true);

    const withoutOptIn = classifyArrivals(new Set(), pilots, new Set(), {
      alertAnyRed: false,
      alertNeutrals: false,
    });
    expect(withoutOptIn.notice).toBeNull();
    expect(withoutOptIn.alarm).toBe(false);
  });

  it("matches on allianceId membership in watchIds, not just corporationId", () => {
    const p = pilot({
      characterId: 1,
      corporationId: 1,
      allianceId: 42,
      threat: "blue",
    });
    const result = classifyArrivals(new Set(), [p], new Set([42]), OPTS_DEFAULT);
    expect(result.notice).toEqual({ kind: "watchlist", pilots: [p] });
  });
});
