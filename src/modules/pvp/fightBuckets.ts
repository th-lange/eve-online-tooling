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
 *  bucket** (5 s of silence) — and **stay** frozen, no matter what arrives
 *  next, until the caller explicitly clears the buffer (the panel's Dismiss
 *  button). That only-Dismiss-resets rule is #950: a stray quiet moment
 *  between volleys must never silently throw the collected fight away; on
 *  the 5 s grid a quiet moment is a whole empty bucket, which is also the
 *  freeze signal — so the freeze keeps the fight ON screen, and resumption
 *  only ever starts from a deliberately-cleared slate. Exported for tests. */
export function nextFightBuckets(
  prev: DpsBucket[],
  bucket: DpsBucket,
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
  // Already frozen: stays exactly as-is regardless of what arrives.
  if (!isCombatBucket(prev[prev.length - 1])) return prev;
  // Still live (or this is the final empty bucket that freezes it): append.
  return [...prev, bucket].slice(-120);
}
