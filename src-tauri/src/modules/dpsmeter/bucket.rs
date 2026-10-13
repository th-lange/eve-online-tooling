//! Fixed-grid aggregation: a stream of [`DpsEvent`] → finalized, epoch-aligned
//! 5-second buckets (#983).
//!
//! Unlike the rolling [`super::aggregate::Window`] (a moving average sampled on
//! a wall-clock timer), a bucket is a fixed slice of *event time*:
//! `start = ts - ts % 5`, `end = start + 5`. Every event lands in exactly one
//! bucket, idle time produces explicitly empty buckets (so a time axis never
//! has holes to special-case), and replaying a log yields byte-identical
//! buckets to live-tailing the same lines — the fold has no notion of when it
//! was called, only of the event clock it is advanced along.
//!
//! The tail loops own one [`BucketFold`] each: they [`BucketFold::push`] every
//! parsed event, then [`BucketFold::advance_to`] the loop's clock (wall time
//! live, the virtual clock in playback) and emit whatever finalized.

use serde::Serialize;

use super::parser::{DpsEvent, EventKind};

/// Width of one detail-timeline bucket, in seconds.
pub const BUCKET_SECS: i64 = 5;

/// The epoch-aligned start of the bucket containing `ts`.
pub fn bucket_start(ts: i64) -> i64 {
    ts - ts.rem_euclid(BUCKET_SECS)
}

/// One finalized 5-second slice of combat activity. All amount fields are
/// **absolute sums over the bucket** (hp, GJ, m³) — per-second rates are
/// `sum / (end - start)`, derived at render time, so nothing is lost to
/// premature division.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DpsBucket {
    /// Inclusive start (unix seconds, a multiple of [`BUCKET_SECS`]).
    pub start: i64,
    /// Exclusive end: `start + BUCKET_SECS`.
    pub end: i64,
    pub damage_out: f64,
    pub damage_in: f64,
    pub rep_out: f64,
    pub rep_in: f64,
    pub cap_transfer_out: f64,
    pub cap_transfer_in: f64,
    pub cap_warfare_out: f64,
    pub cap_warfare_in: f64,
    /// Mined volume (m³) booked in this bucket.
    pub mining_m3: f64,
}

impl DpsBucket {
    fn empty(start: i64) -> Self {
        Self {
            start,
            end: start + BUCKET_SECS,
            damage_out: 0.0,
            damage_in: 0.0,
            rep_out: 0.0,
            rep_in: 0.0,
            cap_transfer_out: 0.0,
            cap_transfer_in: 0.0,
            cap_warfare_out: 0.0,
            cap_warfare_in: 0.0,
            mining_m3: 0.0,
        }
    }

    fn add(&mut self, ev: &DpsEvent) {
        let amt = ev.amount as f64;
        match ev.kind {
            EventKind::DamageOut => self.damage_out += amt,
            EventKind::DamageIn => self.damage_in += amt,
            EventKind::RepOut => self.rep_out += amt,
            EventKind::RepIn => self.rep_in += amt,
            EventKind::CapTransferOut => self.cap_transfer_out += amt,
            EventKind::CapTransferIn => self.cap_transfer_in += amt,
            EventKind::CapWarfareOut => self.cap_warfare_out += amt,
            EventKind::CapWarfareIn => self.cap_warfare_in += amt,
            EventKind::Mining => self.mining_m3 += ev.volume,
            // Tackle carries no magnitude; per-bucket flags arrive with the
            // full aggregates (#984).
            EventKind::ScramOut | EventKind::ScramIn | EventKind::PointOut | EventKind::PointIn => {
            }
        }
    }
}

/// Folds an ascending event stream into finalized buckets. The in-progress
/// bucket is held back until the clock passes its end — "complete buckets
/// only", per the parent plan.
#[derive(Debug, Default)]
pub struct BucketFold {
    current: Option<DpsBucket>,
}

impl BucketFold {
    pub fn new() -> Self {
        Self::default()
    }

    /// Fold one event in; returns every bucket this finalizes (the current one
    /// plus explicit empty gap buckets) when the event belongs to a later
    /// bucket than the one in progress. An event *older* than the current
    /// bucket (slight reorder across a poll boundary) is clamped into the
    /// current bucket rather than resurrecting an already-finalized one.
    pub fn push(&mut self, ev: &DpsEvent) -> Vec<DpsBucket> {
        let target = bucket_start(ev.ts);
        let mut done = Vec::new();
        match &mut self.current {
            None => {
                let mut b = DpsBucket::empty(target);
                b.add(ev);
                self.current = Some(b);
            }
            Some(cur) if target <= cur.start => {
                cur.add(ev);
            }
            Some(_) => {
                done = self.roll_to(target);
                self.current
                    .as_mut()
                    .expect("roll_to leaves a current bucket")
                    .add(ev);
            }
        }
        done
    }

    /// Advance the fold's clock to `now`, finalizing every bucket whose end
    /// has passed — including empty ones for idle stretches — and leaving the
    /// (unemitted) bucket containing `now` in progress. Before anything has
    /// been pushed or advanced, the first call anchors the grid at `now`.
    pub fn advance_to(&mut self, now: i64) -> Vec<DpsBucket> {
        let target = bucket_start(now);
        match &self.current {
            None => {
                self.current = Some(DpsBucket::empty(target));
                Vec::new()
            }
            Some(cur) if target <= cur.start => Vec::new(),
            Some(_) => self.roll_to(target),
        }
    }

    /// Finalize from the current bucket up to (not including) the bucket at
    /// `target`, filling the gap with empty buckets; the bucket at `target`
    /// becomes the new in-progress one. Caller guarantees `target` is a later
    /// bucket start than the current one.
    fn roll_to(&mut self, target: i64) -> Vec<DpsBucket> {
        let cur = self.current.take().expect("roll_to requires a bucket");
        let mut done = Vec::with_capacity(((target - cur.start) / BUCKET_SECS) as usize);
        let mut next_start = cur.start + BUCKET_SECS;
        done.push(cur);
        while next_start < target {
            done.push(DpsBucket::empty(next_start));
            next_start += BUCKET_SECS;
        }
        self.current = Some(DpsBucket::empty(target));
        done
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(ts: i64, kind: EventKind, amount: i64) -> DpsEvent {
        DpsEvent {
            ts,
            kind,
            amount,
            pilot: None,
            ship: None,
            weapon: None,
            quality: None,
            ore: None,
            volume: 0.0,
        }
    }

    #[test]
    fn bucket_start_is_epoch_aligned() {
        assert_eq!(bucket_start(0), 0);
        assert_eq!(bucket_start(4), 0);
        assert_eq!(bucket_start(5), 5);
        assert_eq!(bucket_start(1_700_000_003), 1_700_000_000);
    }

    #[test]
    fn events_in_one_bucket_sum_and_stay_unemitted_until_the_clock_passes() {
        let mut f = BucketFold::new();
        assert!(f.push(&ev(100, EventKind::DamageOut, 40)).is_empty());
        assert!(f.push(&ev(103, EventKind::DamageOut, 60)).is_empty());
        assert!(f.push(&ev(104, EventKind::DamageIn, 25)).is_empty());
        // Clock still inside the bucket: nothing finalizes.
        assert!(f.advance_to(104).is_empty());
        // Clock passes the end: exactly one bucket, with the sums.
        let done = f.advance_to(105);
        assert_eq!(done.len(), 1);
        assert_eq!(done[0].start, 100);
        assert_eq!(done[0].end, 105);
        assert_eq!(done[0].damage_out, 100.0);
        assert_eq!(done[0].damage_in, 25.0);
    }

    #[test]
    fn idle_gaps_finalize_as_explicit_empty_buckets() {
        let mut f = BucketFold::new();
        f.push(&ev(100, EventKind::DamageOut, 10));
        // Next event three buckets later: the active bucket plus two empties.
        let done = f.push(&ev(117, EventKind::DamageOut, 20));
        assert_eq!(
            done.iter().map(|b| b.start).collect::<Vec<_>>(),
            vec![100, 105, 110]
        );
        assert_eq!(done[0].damage_out, 10.0);
        assert_eq!(done[1].damage_out, 0.0);
        assert_eq!(done[2].damage_out, 0.0);
        // The new current bucket holds the later event, not yet emitted.
        let done = f.advance_to(120);
        assert_eq!(done.len(), 1);
        assert_eq!(done[0].start, 115);
        assert_eq!(done[0].damage_out, 20.0);
    }

    #[test]
    fn advancing_the_clock_alone_emits_empty_buckets_while_idle() {
        let mut f = BucketFold::new();
        // First advance anchors the grid without emitting.
        assert!(f.advance_to(100).is_empty());
        let done = f.advance_to(112);
        assert_eq!(
            done.iter().map(|b| b.start).collect::<Vec<_>>(),
            vec![100, 105]
        );
        assert!(done.iter().all(|b| *b == DpsBucket::empty(b.start)));
    }

    #[test]
    fn late_event_is_clamped_into_the_current_bucket() {
        let mut f = BucketFold::new();
        f.push(&ev(107, EventKind::DamageOut, 10));
        // ts 104 belongs to the already-passed bucket at 100 — folded into the
        // current one instead of resurrecting it.
        assert!(f.push(&ev(104, EventKind::DamageOut, 5)).is_empty());
        let done = f.advance_to(110);
        assert_eq!(done.len(), 1);
        assert_eq!(done[0].start, 105);
        assert_eq!(done[0].damage_out, 15.0);
    }

    #[test]
    fn every_scalar_kind_lands_in_its_field_and_tackle_in_none() {
        let mut f = BucketFold::new();
        f.push(&ev(100, EventKind::DamageOut, 1));
        f.push(&ev(100, EventKind::DamageIn, 2));
        f.push(&ev(100, EventKind::RepOut, 3));
        f.push(&ev(100, EventKind::RepIn, 4));
        f.push(&ev(100, EventKind::CapTransferOut, 5));
        f.push(&ev(100, EventKind::CapTransferIn, 6));
        f.push(&ev(100, EventKind::CapWarfareOut, 7));
        f.push(&ev(100, EventKind::CapWarfareIn, 8));
        let mut mining = ev(101, EventKind::Mining, 34);
        mining.volume = 3.4;
        f.push(&mining);
        f.push(&ev(102, EventKind::ScramIn, 0));
        f.push(&ev(102, EventKind::PointOut, 0));
        let done = f.advance_to(105);
        let b = &done[0];
        assert_eq!(
            (b.damage_out, b.damage_in, b.rep_out, b.rep_in),
            (1.0, 2.0, 3.0, 4.0)
        );
        assert_eq!(
            (
                b.cap_transfer_out,
                b.cap_transfer_in,
                b.cap_warfare_out,
                b.cap_warfare_in
            ),
            (5.0, 6.0, 7.0, 8.0)
        );
        assert_eq!(b.mining_m3, 3.4);
    }

    #[test]
    fn chunking_does_not_change_the_buckets_live_equals_replay() {
        let events: Vec<DpsEvent> = vec![
            ev(100, EventKind::DamageOut, 10),
            ev(101, EventKind::DamageIn, 5),
            ev(104, EventKind::DamageOut, 20),
            ev(113, EventKind::RepOut, 7),
            ev(114, EventKind::DamageOut, 1),
            ev(126, EventKind::DamageIn, 9),
        ];
        let run = |chunks: &[&[DpsEvent]]| -> Vec<DpsBucket> {
            let mut f = BucketFold::new();
            let mut out = Vec::new();
            for chunk in chunks {
                for e in *chunk {
                    out.extend(f.push(e));
                }
                // Each "poll" advances to the last event seen so far, the way
                // the playback clock trails the batch it just released.
                if let Some(last) = chunk.last() {
                    out.extend(f.advance_to(last.ts));
                }
            }
            out.extend(f.advance_to(1_000_000));
            out
        };
        let whole = run(&[&events]);
        let split = run(&[&events[..2], &events[2..3], &events[3..], &[]]);
        assert_eq!(whole, split);
        // Sanity: continuous coverage from first to last bucket, no holes.
        let starts: Vec<i64> = whole.iter().map(|b| b.start).collect();
        assert_eq!(starts.first(), Some(&100));
        assert!(starts.windows(2).all(|w| w[1] - w[0] == BUCKET_SECS));
    }

    #[test]
    fn partial_last_bucket_is_never_emitted() {
        let mut f = BucketFold::new();
        f.push(&ev(100, EventKind::DamageOut, 10));
        // The clock never passes 105, so nothing is finalized — the bucket in
        // progress is withheld (complete buckets only).
        assert!(f.advance_to(104).is_empty());
    }
}
