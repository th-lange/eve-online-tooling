import { describe, expect, it } from "vitest";
import { isCombatBucket, nextFightBuckets } from "./FightOverlayProvider";
import type { DpsBucket, PilotRate } from "../../lib/api";

const hq = {
  misses: 0,
  glances: 0,
  grazes: 0,
  hits: 0,
  penetrates: 0,
  smashes: 0,
  wrecks: 0,
};

function pilot(partial: Partial<PilotRate>): PilotRate {
  return {
    name: "X",
    dpsOut: 0,
    dpsIn: 0,
    weaponsOut: [],
    weaponsIn: [],
    qualityOut: hq,
    qualityIn: hq,
    scramOut: false,
    pointOut: false,
    scramIn: false,
    pointIn: false,
    ...partial,
  };
}

function bucket(start: number, partial: Partial<DpsBucket> = {}): DpsBucket {
  return {
    start,
    end: start + 5,
    damageOut: 0,
    damageIn: 0,
    repOut: 0,
    repIn: 0,
    capTransferOut: 0,
    capTransferIn: 0,
    capWarfareOut: 0,
    capWarfareIn: 0,
    miningM3: 0,
    hitsOut: hq,
    hitsIn: hq,
    byWeapon: [],
    byPilot: [],
    events: [],
    ...partial,
  };
}

describe("isCombatBucket", () => {
  it("is true for damage or active tackle, false when empty", () => {
    expect(isCombatBucket(bucket(0, { damageOut: 5 }))).toBe(true);
    expect(isCombatBucket(bucket(0, { damageIn: 5 }))).toBe(true);
    expect(
      isCombatBucket(bucket(0, { byPilot: [pilot({ pointIn: true })] })),
    ).toBe(true);
    expect(isCombatBucket(bucket(0))).toBe(false);
  });
});

describe("nextFightBuckets", () => {
  it("doesn't start until real combat begins", () => {
    expect(nextFightBuckets([], bucket(0))).toEqual([]);
    const started = nextFightBuckets([], bucket(5, { damageIn: 10 }));
    expect(started).toHaveLength(1);
  });

  it("appends while the fight is live, including the empty wind-down bucket", () => {
    let buf: DpsBucket[] = [];
    buf = nextFightBuckets(buf, bucket(0, { damageIn: 10 })); // fight
    buf = nextFightBuckets(buf, bucket(5, { damageIn: 4 })); // decaying
    buf = nextFightBuckets(buf, bucket(10)); // 5s of silence — appended once
    expect(buf.map((b) => b.start)).toEqual([0, 5, 10]);
  });

  it("freezes after one empty bucket and stays frozen", () => {
    let buf: DpsBucket[] = [];
    buf = nextFightBuckets(buf, bucket(0, { damageIn: 10 }));
    buf = nextFightBuckets(buf, bucket(5)); // wind-down, appended
    const frozen = buf;
    buf = nextFightBuckets(buf, bucket(10)); // idle — dropped
    buf = nextFightBuckets(buf, bucket(15)); // idle — dropped
    expect(buf).toBe(frozen);
    expect(buf.map((b) => b.start)).toEqual([0, 5]);
  });

  it("stays frozen even when combat resumes — only Dismiss resets (#950)", () => {
    let buf: DpsBucket[] = [];
    buf = nextFightBuckets(buf, bucket(0, { damageIn: 10 }));
    buf = nextFightBuckets(buf, bucket(5)); // frozen — columns keep this data
    const frozen = buf;
    // Activity resuming must never silently discard the collected fight;
    // only an explicitly cleared slate starts a new one.
    buf = nextFightBuckets(buf, bucket(100, { damageIn: 8 }));
    expect(buf).toBe(frozen);
    buf = nextFightBuckets([], bucket(100, { damageIn: 8 }));
    expect(buf.map((b) => b.start)).toEqual([100]);
  });

  it("caps the live buffer at 120 buckets (10 minutes)", () => {
    let buf: DpsBucket[] = [];
    for (let i = 0; i < 150; i++) {
      buf = nextFightBuckets(buf, bucket(i * 5, { damageOut: 1 }));
    }
    expect(buf).toHaveLength(120);
    expect(buf[0].start).toBe(30 * 5);
  });
});
