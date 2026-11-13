import type { DpsBucket } from "../../lib/api";

/** Whether a bucket shows live combat: damage dealt/taken, or active tackle.
 *  The overlay stops accumulating once combat ends, so the chart freezes on
 *  the fight instead of scrolling an empty grid as the idle capture keeps
 *  emitting empty buckets. Exported for tests. */
export function isCombatBucket(b: DpsBucket): boolean {
  return (
    b.damageOut > 0 ||
    b.damageIn > 0 ||
    b.byPilot.some((p) => p.scramIn || p.pointIn || p.scramOut || p.pointOut)
  );
}

/** Overlay bucket-buffer reducer (#986): begin on the first combat bucket,
 *  keep appending while the fight is live (capped at 120 buckets = 10 min,
 *  incl. the final empty wind-down bucket), then freeze after **one empty
 *  bucket** (5 s of silence) so the panel keeps showing the fight instead of
 *  scrolling an empty grid.
 *
 *  A frozen buffer is not dead (#1173): when a new combat bucket arrives
 *  - within `reengageSecs` of the frozen tail (the recorder's post-roll), the
 *    fight resumed — it is appended, so `live` rises again and the recording
 *    keeps rolling;
 *  - later than that, it is a new fight — the buffer restarts from it. This
 *    matters when the earlier burst was NPC-only: the panel never opened, so
 *    there is nothing to Dismiss, yet a later real PvP attack must still be
 *    detected.
 *  Exported for tests. */
export function nextFightBuckets(
  prev: DpsBucket[],
  bucket: DpsBucket,
  reengageSecs: number,
): DpsBucket[] {
  if (prev.length === 0) {
    return isCombatBucket(bucket) ? [bucket] : prev;
  }
  // Not past the kept tail: either a backend amendment of a kept bucket
  // (late-flushed line re-opened it — replace in place, even when frozen:
  // it's the same data, just completed) or a stale duplicate (drop).
  if (bucket.start <= prev[prev.length - 1].start) {
    for (let i = prev.length - 1; i >= 0; i--) {
      if (prev[i].start === bucket.start) {
        const next = [...prev];
        next[i] = bucket;
        return next;
      }
      if (prev[i].start < bucket.start) break;
    }
    return prev;
  }
  const tail = prev[prev.length - 1];
  if (!isCombatBucket(tail)) {
    // Frozen: idle buckets are dropped; combat either resumes the fight
    // (within the post-roll) or starts a new one.
    if (!isCombatBucket(bucket)) return prev;
    if (bucket.start - tail.end > reengageSecs) return [bucket];
  }
  // Still live (or this is the final empty bucket that freezes it): append.
  return [...prev, bucket].slice(-120);
}
