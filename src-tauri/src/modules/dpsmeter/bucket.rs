//! Fixed-grid aggregation: a stream of [`DpsEvent`] → finalized, epoch-aligned
//! 5-second buckets (#983, #984).
//!
//! Unlike the rolling [`super::aggregate::Window`] (a moving average sampled on
//! a wall-clock timer), a bucket is a fixed slice of *event time*:
//! `start = ts - ts % 5`, `end = start + 5`. Every event lands in exactly one
//! bucket, idle time produces explicitly empty buckets (so a time axis never
//! has holes to special-case), and replaying a log yields byte-identical
//! buckets to live-tailing the same lines — the fold has no notion of when it
//! was called, only of the event clock it is advanced along.
//!
//! Each bucket carries everything the rolling tick carried (#984): hit-quality
//! tallies, damage-by-weapon, and the per-pilot engagement breakdown — in the
//! same row shapes ([`WeaponRate`], [`PilotRate`]), so the UI and the SDE
//! enrichment apply unchanged. Unlike the window there is no top-N cut: a 5 s
//! slice is small, so every pilot/weapon row is kept (sorted by rate, desc).
//!
//! The tail loops own one [`BucketFold`] each: they [`BucketFold::push`] every
//! parsed event, then [`BucketFold::advance_to`] the loop's clock (wall time
//! live, the virtual clock in playback) and emit whatever finalized.

use std::collections::HashMap;

use serde::Serialize;

use super::aggregate::{HitQuality, PilotRate, WeaponRate};
use super::parser::{DpsEvent, EventKind};

/// Width of one detail-timeline bucket, in seconds.
pub const BUCKET_SECS: i64 = 5;

/// The epoch-aligned start of the bucket containing `ts`.
pub fn bucket_start(ts: i64) -> i64 {
    ts - ts.rem_euclid(BUCKET_SECS)
}

/// One finalized 5-second slice of combat activity. The scalar fields are
/// **absolute sums over the bucket** (hp, GJ, m³) — per-second rates are
/// `sum / (end - start)`, derived at render time, so nothing is lost to
/// premature division. The breakdown rows (`by_weapon`, `by_pilot`) reuse the
/// rolling tick's shapes, whose fields are **per-second rates** — kept that
/// way so every consumer and the SDE enrichment work on both unchanged.
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
    /// Hit-quality tally of your hits within the bucket.
    pub hits_out: HitQuality,
    /// Hit-quality tally of hits on you within the bucket.
    pub hits_in: HitQuality,
    /// Your outgoing damage by weapon/ammo/drone (rates; all rows, sorted).
    pub by_weapon: Vec<WeaponRate>,
    /// Per-pilot engagement (rates + tackle flags; all rows, sorted).
    pub by_pilot: Vec<PilotRate>,
    /// The raw combat-log events this bucket aggregates (#1000): the log is
    /// rendered from these, so log segments and chart buckets are literally
    /// the same data — nothing to correlate after the fact.
    pub events: Vec<DpsEvent>,
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
            hits_out: HitQuality::default(),
            hits_in: HitQuality::default(),
            by_weapon: Vec::new(),
            by_pilot: Vec::new(),
            events: Vec::new(),
        }
    }
}

/// Per-pilot accumulator for the in-progress bucket — same attribution rules
/// as the rolling window's (ship from incoming lines, per-source damage maps,
/// tackle as sticky flags within the bucket).
#[derive(Default)]
struct PilotAcc {
    out: f64,
    inc: f64,
    ship: Option<String>,
    weapons_out: HashMap<String, f64>,
    weapons_in: HashMap<String, f64>,
    quality_out: HitQuality,
    quality_in: HitQuality,
    scram_out: bool,
    point_out: bool,
    scram_in: bool,
    point_in: bool,
}

/// The in-progress bucket: scalar sums on the [`DpsBucket`] itself (its
/// breakdown vecs stay empty until finalize) plus the breakdown accumulators.
struct Acc {
    bucket: DpsBucket,
    weapons: HashMap<String, f64>,
    pilots: HashMap<String, PilotAcc>,
}

impl Acc {
    fn new(start: i64) -> Self {
        Self {
            bucket: DpsBucket::empty(start),
            weapons: HashMap::new(),
            pilots: HashMap::new(),
        }
    }

    fn add(&mut self, ev: &DpsEvent) {
        let b = &mut self.bucket;
        // The raw line rides along with the aggregates (#1000) — the combat
        // log renders straight from the finalized bucket's events.
        b.events.push(ev.clone());
        let v = ev.amount as f64;
        match ev.kind {
            EventKind::DamageOut => {
                b.damage_out += v;
                b.hits_out.count(ev.quality.as_deref());
            }
            EventKind::DamageIn => {
                b.damage_in += v;
                b.hits_in.count(ev.quality.as_deref());
            }
            EventKind::RepOut => b.rep_out += v,
            EventKind::RepIn => b.rep_in += v,
            EventKind::CapTransferOut => b.cap_transfer_out += v,
            EventKind::CapTransferIn => b.cap_transfer_in += v,
            EventKind::CapWarfareOut => b.cap_warfare_out += v,
            EventKind::CapWarfareIn => b.cap_warfare_in += v,
            EventKind::Mining => b.mining_m3 += ev.volume,
            // Tackle carries no magnitude — per-pilot flags below.
            EventKind::ScramOut | EventKind::ScramIn | EventKind::PointOut | EventKind::PointIn => {
            }
        }
        // Global "damage by weapon" — your outgoing weapons only.
        if ev.kind == EventKind::DamageOut {
            if let Some(w) = ev.weapon.as_deref() {
                *self.weapons.entry(w.to_string()).or_default() += v;
            }
        }
        if let Some(p) = ev.pilot.as_deref() {
            let slot = self.pilots.entry(p.to_string()).or_default();
            let weapon = ev.weapon.as_deref();
            match ev.kind {
                EventKind::DamageOut => {
                    slot.out += v;
                    slot.quality_out.count(ev.quality.as_deref());
                    if let Some(w) = weapon {
                        *slot.weapons_out.entry(w.to_string()).or_default() += v;
                    }
                }
                EventKind::DamageIn => {
                    slot.inc += v;
                    slot.quality_in.count(ev.quality.as_deref());
                    if let Some(w) = weapon {
                        *slot.weapons_in.entry(w.to_string()).or_default() += v;
                    }
                    // Capture the attacker's ship (keep most-recent).
                    if ev.ship.is_some() {
                        slot.ship = ev.ship.clone();
                    }
                }
                EventKind::ScramOut => slot.scram_out = true,
                EventKind::PointOut => slot.point_out = true,
                EventKind::ScramIn => slot.scram_in = true,
                EventKind::PointIn => slot.point_in = true,
                _ => {}
            }
        }
    }

    fn finalize(self) -> DpsBucket {
        let w = BUCKET_SECS as f64;
        let mut b = self.bucket;
        b.by_weapon = weapon_rates(self.weapons, w);
        let mut by_pilot: Vec<PilotRate> = self
            .pilots
            .into_iter()
            .map(|(name, acc)| PilotRate {
                name,
                dps_out: acc.out / w,
                dps_in: acc.inc / w,
                ship: acc.ship,
                weapons_out: weapon_rates(acc.weapons_out, w),
                weapons_in: weapon_rates(acc.weapons_in, w),
                quality_out: acc.quality_out,
                quality_in: acc.quality_in,
                scram_out: acc.scram_out,
                point_out: acc.point_out,
                scram_in: acc.scram_in,
                point_in: acc.point_in,
            })
            .collect();
        by_pilot.sort_by(|a, b| {
            (b.dps_out + b.dps_in)
                .partial_cmp(&(a.dps_out + a.dps_in))
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| a.name.cmp(&b.name))
        });
        b.by_pilot = by_pilot;
        b
    }
}

/// Owned-key sibling of the window's `weapon_rates`: per-source damage sums →
/// sorted per-second rates (deterministic: rate desc, then name).
fn weapon_rates(map: HashMap<String, f64>, window: f64) -> Vec<WeaponRate> {
    let mut v: Vec<WeaponRate> = map
        .into_iter()
        .map(|(name, dmg)| WeaponRate {
            name,
            dps: dmg / window,
            kind: None,
            damage: None,
        })
        .collect();
    v.sort_by(|a, b| {
        b.dps
            .partial_cmp(&a.dps)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.name.cmp(&b.name))
    });
    v
}

/// Folds an ascending event stream into finalized buckets. The in-progress
/// bucket is held back until the clock passes its end — "complete buckets
/// only", per the parent plan.
#[derive(Default)]
pub struct BucketFold {
    current: Option<Acc>,
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
                let mut acc = Acc::new(target);
                acc.add(ev);
                self.current = Some(acc);
            }
            Some(cur) if target <= cur.bucket.start => {
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
                self.current = Some(Acc::new(target));
                Vec::new()
            }
            Some(cur) if target <= cur.bucket.start => Vec::new(),
            Some(_) => self.roll_to(target),
        }
    }

    /// Finalize from the current bucket up to (not including) the bucket at
    /// `target`, filling the gap with empty buckets; the bucket at `target`
    /// becomes the new in-progress one. Caller guarantees `target` is a later
    /// bucket start than the current one.
    fn roll_to(&mut self, target: i64) -> Vec<DpsBucket> {
        let cur = self.current.take().expect("roll_to requires a bucket");
        let start = cur.bucket.start;
        let mut done = Vec::with_capacity(((target - start) / BUCKET_SECS) as usize);
        let mut next_start = start + BUCKET_SECS;
        done.push(cur.finalize());
        while next_start < target {
            done.push(DpsBucket::empty(next_start));
            next_start += BUCKET_SECS;
        }
        self.current = Some(Acc::new(target));
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

    fn combat(
        ts: i64,
        kind: EventKind,
        amount: i64,
        pilot: &str,
        ship: Option<&str>,
        weapon: Option<&str>,
        quality: Option<&str>,
    ) -> DpsEvent {
        DpsEvent {
            ts,
            kind,
            amount,
            pilot: Some(pilot.to_string()),
            ship: ship.map(String::from),
            weapon: weapon.map(String::from),
            quality: quality.map(String::from),
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
        // The raw lines ride along for the log view (#1000), in push order.
        assert_eq!(done[0].events.len(), 3);
        assert_eq!(
            done[0].events.iter().map(|e| e.ts).collect::<Vec<_>>(),
            vec![100, 103, 104]
        );
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
            combat(
                100,
                EventKind::DamageOut,
                10,
                "A",
                None,
                Some("Gun"),
                Some("Hits"),
            ),
            ev(101, EventKind::DamageIn, 5),
            combat(
                104,
                EventKind::DamageOut,
                20,
                "A",
                None,
                Some("Gun"),
                Some("Wrecks"),
            ),
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

    #[test]
    fn pilot_breakdown_mirrors_the_window_attribution_rules() {
        let mut f = BucketFold::new();
        // Outgoing: 100 dmg to A with Gun (Wrecks), 50 to B with Launcher.
        f.push(&combat(
            100,
            EventKind::DamageOut,
            100,
            "A",
            None,
            Some("Gun"),
            Some("Wrecks"),
        ));
        f.push(&combat(
            101,
            EventKind::DamageOut,
            50,
            "B",
            None,
            Some("Launcher"),
            Some("Hits"),
        ));
        // Incoming: 25 from A (Rifter, Autocannon), plus A scrams us.
        f.push(&combat(
            102,
            EventKind::DamageIn,
            25,
            "A",
            Some("Rifter"),
            Some("Autocannon"),
            Some("Grazes"),
        ));
        f.push(&combat(103, EventKind::ScramIn, 0, "A", None, None, None));
        let done = f.advance_to(105);
        let b = &done[0];

        // Global weapon rows: outgoing only, rate = sum / 5, sorted desc.
        assert_eq!(b.by_weapon.len(), 2);
        assert_eq!(b.by_weapon[0].name, "Gun");
        assert_eq!(b.by_weapon[0].dps, 20.0);
        assert_eq!(b.by_weapon[1].name, "Launcher");
        assert_eq!(b.by_weapon[1].dps, 10.0);

        // Pilot rows: A first (engaged 125), then B; ship from the incoming
        // line; tackle flags sticky; hit-quality tallied per direction.
        assert_eq!(b.by_pilot.len(), 2);
        let a = &b.by_pilot[0];
        assert_eq!(a.name, "A");
        assert_eq!(a.dps_out, 20.0);
        assert_eq!(a.dps_in, 5.0);
        assert_eq!(a.ship.as_deref(), Some("Rifter"));
        assert!(a.scram_in);
        assert!(!a.point_in);
        assert_eq!(a.quality_out.wrecks, 1);
        assert_eq!(a.quality_in.grazes, 1);
        assert_eq!(a.weapons_out.len(), 1);
        assert_eq!(a.weapons_out[0].name, "Gun");
        assert_eq!(a.weapons_in[0].name, "Autocannon");
        assert_eq!(b.by_pilot[1].name, "B");

        // Bucket-level hit quality covers both directions.
        assert_eq!(b.hits_out.wrecks, 1);
        assert_eq!(b.hits_out.hits, 1);
        assert_eq!(b.hits_in.grazes, 1);
    }

    #[test]
    fn a_pure_tackler_still_gets_a_pilot_row() {
        let mut f = BucketFold::new();
        f.push(&combat(100, EventKind::PointIn, 0, "T", None, None, None));
        let done = f.advance_to(105);
        let b = &done[0];
        assert_eq!(b.by_pilot.len(), 1);
        assert_eq!(b.by_pilot[0].name, "T");
        assert!(b.by_pilot[0].point_in);
        assert_eq!(b.by_pilot[0].dps_out + b.by_pilot[0].dps_in, 0.0);
    }
}
