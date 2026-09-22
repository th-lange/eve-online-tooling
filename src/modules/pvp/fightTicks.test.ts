import { describe, expect, it } from "vitest";
import { isCombatTick, nextFightTicks } from "./FightOverlayProvider";
import type { DpsTick } from "../../lib/api";

const hq = {
  misses: 0,
  glances: 0,
  grazes: 0,
  hits: 0,
  penetrates: 0,
  smashes: 0,
  wrecks: 0,
};
function tick(over: Partial<DpsTick>, at = 0): DpsTick {
  return {
    dpsOut: 0,
    dpsIn: 0,
    logiOut: 0,
    logiIn: 0,
    capTransferOut: 0,
    capTransferIn: 0,
    capWarfareOut: 0,
    capWarfareIn: 0,
    miningM3: 0,
    hitsOut: hq,
    hitsIn: hq,
    byWeapon: [],
    byPilot: [],
    windowSecs: 10,
    at,
    ...over,
  };
}

describe("isCombatTick", () => {
  it("is true for damage or active tackle, false when idle", () => {
    expect(isCombatTick(tick({ dpsOut: 5 }))).toBe(true);
    expect(isCombatTick(tick({ dpsIn: 5 }))).toBe(true);
    expect(
      isCombatTick(
        tick({ byPilot: [{ name: "X", dpsOut: 0, dpsIn: 0, pointIn: true }] }),
      ),
    ).toBe(true);
    expect(isCombatTick(tick({}))).toBe(false);
  });
});

describe("nextFightTicks", () => {
  it("doesn't start until real combat begins", () => {
    expect(nextFightTicks([], tick({}, 1))).toEqual([]);
    const started = nextFightTicks([], tick({ dpsIn: 10 }, 2));
    expect(started).toHaveLength(1);
  });

  it("appends while live, incl. the final wind-down-to-zero tick", () => {
    let buf: DpsTick[] = [];
    buf = nextFightTicks(buf, tick({ dpsIn: 10 }, 1)); // fight
    buf = nextFightTicks(buf, tick({ dpsIn: 4 }, 2)); // decaying
    buf = nextFightTicks(buf, tick({}, 3)); // hit zero — appended once
    expect(buf.map((t) => t.at)).toEqual([1, 2, 3]);
  });

  it("freezes once combat is over — further idle ticks are dropped", () => {
    let buf: DpsTick[] = [];
    buf = nextFightTicks(buf, tick({ dpsIn: 10 }, 1));
    buf = nextFightTicks(buf, tick({}, 2)); // wind-down zero, appended
    const frozen = buf;
    buf = nextFightTicks(buf, tick({}, 3)); // idle — dropped
    buf = nextFightTicks(buf, tick({}, 4)); // idle — dropped
    expect(buf).toBe(frozen);
    expect(buf.map((t) => t.at)).toEqual([1, 2]);
  });

  it("starts a fresh buffer when a new fight begins after a freeze", () => {
    let buf: DpsTick[] = [];
    buf = nextFightTicks(buf, tick({ dpsIn: 10 }, 1));
    buf = nextFightTicks(buf, tick({}, 2)); // frozen
    buf = nextFightTicks(buf, tick({ dpsIn: 8 }, 20)); // new fight
    expect(buf.map((t) => t.at)).toEqual([20]);
  });

  it("caps the live buffer at 120 ticks", () => {
    let buf: DpsTick[] = [];
    for (let i = 0; i < 200; i++)
      buf = nextFightTicks(buf, tick({ dpsIn: 1 }, i));
    expect(buf).toHaveLength(120);
    expect(buf[buf.length - 1].at).toBe(199);
  });
});
