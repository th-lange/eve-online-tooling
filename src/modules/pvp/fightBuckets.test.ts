import { describe, expect, it } from "vitest";
import { isCombatBucket, nextFightBuckets } from "./fightBuckets";
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

/** Post-roll window the provider passes in; matches the recorder default. */
const POST_ROLL = 10;
const step = (prev: DpsBucket[], b: DpsBucket) =>
  nextFightBuckets(prev, b, POST_ROLL);

describe("nextFightBuckets", () => {
  it("doesn't start until real combat begins", () => {
    expect(step([], bucket(0))).toEqual([]);
    const started = step([], bucket(5, { damageIn: 10 }));
    expect(started).toHaveLength(1);
  });

  it("appends while the fight is live, including the empty wind-down bucket", () => {
    let buf: DpsBucket[] = [];
    buf = step(buf, bucket(0, { damageIn: 10 })); // fight
    buf = step(buf, bucket(5, { damageIn: 4 })); // decaying
    buf = step(buf, bucket(10)); // 5s of silence — appended once
    expect(buf.map((b) => b.start)).toEqual([0, 5, 10]);
  });

  it("freezes after one empty bucket and stays frozen", () => {
    let buf: DpsBucket[] = [];
    buf = step(buf, bucket(0, { damageIn: 10 }));
    buf = step(buf, bucket(5)); // wind-down, appended
    const frozen = buf;
    buf = step(buf, bucket(10)); // idle — dropped
    buf = step(buf, bucket(15)); // idle — dropped
    expect(buf).toBe(frozen);
    expect(buf.map((b) => b.start)).toEqual([0, 5]);
  });

  it("resumes the same fight when combat returns within the post-roll (#1173)", () => {
    let buf: DpsBucket[] = [];
    buf = step(buf, bucket(0, { damageIn: 10 }));
    buf = step(buf, bucket(5)); // frozen, tail ends at 10
    buf = step(buf, bucket(15, { damageIn: 8 })); // 5 s gap <= post-roll
    expect(buf.map((b) => b.start)).toEqual([0, 5, 15]);
    expect(isCombatBucket(buf[buf.length - 1])).toBe(true);
  });

  it("starts a new fight when combat returns after the post-roll (#1173)", () => {
    // NPC-only burst froze the hidden buffer; a later real attack must not
    // be swallowed by it.
    let buf: DpsBucket[] = [];
    buf = step(buf, bucket(0, { damageOut: 10 }));
    buf = step(buf, bucket(5)); // frozen
    buf = step(buf, bucket(100, { damageIn: 8 }));
    expect(buf.map((b) => b.start)).toEqual([100]);
  });

  it("caps the live buffer at 120 buckets (10 minutes)", () => {
    let buf: DpsBucket[] = [];
    for (let i = 0; i < 150; i++) {
      buf = step(buf, bucket(i * 5, { damageOut: 1 }));
    }
    expect(buf).toHaveLength(120);
    expect(buf[0].start).toBe(30 * 5);
  });

  it("replaces a kept bucket on backend amendment instead of growing", () => {
    let buf: DpsBucket[] = [];
    buf = step(buf, bucket(0, { damageIn: 10 }));
    buf = step(buf, bucket(5, { damageIn: 4 }));
    // A late-flushed line re-opened bucket 0 — the re-emitted amendment
    // replaces the kept copy in place; the buffer must not stretch.
    buf = step(buf, bucket(0, { damageIn: 25 }));
    expect(buf.map((b) => b.start)).toEqual([0, 5]);
    expect(buf[0].damageIn).toBe(25);
  });
});
