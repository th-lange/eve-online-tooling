//! Projected effects (#178) — webs/paints/damps/… applied **onto** the fit.
//!
//! These are procedural effects: their application isn't in `modifierInfo`, so
//! each projected module reads a known attribute and post-percent modifies a
//! target-ship attribute (stacking-penalized across modules). A projected
//! module acts with its **base** attributes: there is no projecting ship or
//! pilot, so neither hull bonuses nor skills (Signature Focusing, Signal
//! Suppression, …) apply. That is what a bare projected module does in PYFA,
//! and the stacking is pinned against it (`projected_stacking_matches_pyfa`).
//!
//! Remote repairers (#1331) are projected too, but they change no attribute:
//! they deliver hit points to a layer, with the game's diminishing returns
//! across everything repairing that layer — see [`applied_remote_rep`].

use super::attr::{attr, AttrStore};
use super::modifier::Op;

// Source attributes the projected modules read.
const SPEED_FACTOR: i64 = 20; // stasis web: % to target maxVelocity
const SIG_RADIUS_BONUS: i64 = 554; // target painter: % to target signatureRadius
const MAX_TARGET_RANGE_BONUS: i64 = 309; // sensor damp: % to target lock range
const SCAN_RESOLUTION_BONUS: i64 = 566; // sensor damp: % to target scan resolution
                                        // Target ship attributes the effects write.
const SIGNATURE_RADIUS: i64 = 552;
const MAX_TARGET_RANGE: i64 = 76;
const SCAN_RESOLUTION: i64 = 564;
// Remote repairers: the amount one cycle delivers to a layer of the target.
const SHIELD_BONUS: i64 = 68; // remote shield booster
const ARMOR_DAMAGE_AMOUNT: i64 = 84; // remote armor repairer
const STRUCTURE_DAMAGE_AMOUNT: i64 = 83; // remote hull repairer
const DURATION: i64 = 73; // cycle time, ms
const MAX_RANGE: i64 = 54; // only a module that reaches another ship has one
const REPAIR_MULTIPLIER_BONUS_MAX: i64 = 2797; // mutadaptive spool ceiling

/// One projected module reduced to the attributes its effect reads.
#[derive(Debug, Clone, Default)]
pub struct ProjectedInput {
    /// `speedFactor` (20) — stasis web: % change to target max velocity (negative).
    pub speed_factor: f64,
    /// `signatureRadiusBonus` (554) — target painter: % change to sig radius.
    pub sig_radius_bonus: f64,
    /// `maxTargetRangeBonus` (309) — sensor damp: % change to lock range.
    pub max_target_range_bonus: f64,
    /// `scanResolutionBonus` (566) — sensor damp: % change to scan resolution.
    pub scan_resolution_bonus: f64,
}

/// Apply projected modules' effects to the target ship's store. Each effect is a
/// stacking-penalized post-percent on a ship attribute.
pub fn apply_projection(ship: &mut AttrStore, projected: &[ProjectedInput]) {
    for p in projected {
        if p.speed_factor != 0.0 {
            ship.apply(attr::MAX_VELOCITY, Op::PostPercent, p.speed_factor, true);
        }
        if p.sig_radius_bonus != 0.0 {
            ship.apply(SIGNATURE_RADIUS, Op::PostPercent, p.sig_radius_bonus, true);
        }
        if p.max_target_range_bonus != 0.0 {
            ship.apply(
                MAX_TARGET_RANGE,
                Op::PostPercent,
                p.max_target_range_bonus,
                true,
            );
        }
        if p.scan_resolution_bonus != 0.0 {
            ship.apply(
                SCAN_RESOLUTION,
                Op::PostPercent,
                p.scan_resolution_bonus,
                true,
            );
        }
    }
}

// T3 subsystem slot/hardpoint grants: `<x>SlotModifier`/`<x>HardPointModifier`
// add to the matching ship slot count. Procedural (not in modifierInfo).
const SUBSYSTEM_SLOT_GRANTS: [(i64, i64); 5] = [
    (1374, 14),  // hiSlotModifier → hiSlots
    (1375, 13),  // medSlotModifier → medSlots
    (1376, 12),  // lowSlotModifier → lowSlots
    (1368, 102), // turretHardPointModifier → turretHardpoints
    (1369, 101), // launcherHardPointModifier → launcherHardpoints
];

/// Add a T3 subsystem's slot/hardpoint grants to the ship (#178). `get` reads the
/// subsystem's finalized attributes.
pub fn apply_subsystem_slots(ship: &mut AttrStore, get: impl Fn(i64) -> f64) {
    for (modifier_attr, slot_attr) in SUBSYSTEM_SLOT_GRANTS {
        let v = get(modifier_attr);
        if v != 0.0 {
            ship.apply(slot_attr, Op::ModAdd, v, false);
        }
    }
}

/// Build a [`ProjectedInput`] from a type's raw attributes.
pub fn projected_from_attrs(get: impl Fn(i64) -> f64) -> ProjectedInput {
    ProjectedInput {
        speed_factor: get(SPEED_FACTOR),
        sig_radius_bonus: get(SIG_RADIUS_BONUS),
        max_target_range_bonus: get(MAX_TARGET_RANGE_BONUS),
        scan_resolution_bonus: get(SCAN_RESOLUTION_BONUS),
    }
}

/// The layer a repairer mends.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RepairLayer {
    Shield,
    Armor,
    Hull,
}

/// One remote repairer landing on the fit.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RemoteRep {
    pub layer: RepairLayer,
    /// Hit points one cycle delivers.
    pub amount: f64,
    pub cycle_seconds: f64,
}

/// Read a projected type as a remote repairer, or `None` if it isn't one.
///
/// A repairer is remote exactly when it has a range: local boosters and
/// repairers carry the same amount attributes but no `maxRange`, so one of
/// those dropped into the projected list repairs nothing — as in PYFA.
///
/// A mutadaptive repairer counts fully spooled (`1 + repairMultiplierBonusMax`),
/// the same default the fit's own spooling weapons use.
pub fn remote_rep_from_attrs(get: impl Fn(i64) -> f64) -> Option<RemoteRep> {
    let cycle_seconds = get(DURATION) / 1000.0;
    if get(MAX_RANGE) <= 0.0 || cycle_seconds <= 0.0 {
        return None;
    }
    let (layer, amount) = [
        (RepairLayer::Shield, get(SHIELD_BONUS)),
        (RepairLayer::Armor, get(ARMOR_DAMAGE_AMOUNT)),
        (RepairLayer::Hull, get(STRUCTURE_DAMAGE_AMOUNT)),
    ]
    .into_iter()
    .find(|&(_, amount)| amount > 0.0)?;
    Some(RemoteRep {
        layer,
        amount: amount * (1.0 + get(REPAIR_MULTIPLIER_BONUS_MAX).max(0.0)),
        cycle_seconds,
    })
}

/// Hit points per second the remote repairers in `reps` deliver to `layer`,
/// after the game's diminishing returns on stacked remote repair (PYFA
/// `Fit.__getAppliedRr`).
///
/// Each repairer is scaled by `1 − ((r + m) / (R + m) − 1)²`, where `r` is its
/// own rate, `R` the summed rate of everything on that layer and
/// `m = 7000 + 20·r`. A lone repairer loses nothing; ten battleship-sized
/// ones lose about 0.6 %. For this weighting only, the cycle time is
/// truncated to whole seconds, as PYFA does.
pub fn applied_remote_rep(reps: &[RemoteRep], layer: RepairLayer) -> f64 {
    const ADDITION: f64 = 7000.0;
    const MULTIPLIER: f64 = 20.0;
    // Sub-second cycles don't exist on real repairers; the floor keeps a
    // malformed one from dividing by zero.
    let weighing_rate = |rep: &RemoteRep| rep.amount / rep.cycle_seconds.trunc().max(1.0);
    let on_layer = || reps.iter().filter(|rep| rep.layer == layer);
    let total: f64 = on_layer().map(weighing_rate).sum();
    on_layer()
        .map(|rep| {
            let rate = weighing_rate(rep);
            let modified = ADDITION + MULTIPLIER * rate;
            let scale = 1.0 - ((rate + modified) / (total + modified) - 1.0).powi(2);
            scale * rep.amount / rep.cycle_seconds
        })
        // Not `.sum()`: an empty float sum is -0.0, which would reach the UI.
        .fold(0.0, |total, rate| total + rate)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn attrs(pairs: &'static [(i64, f64)]) -> impl Fn(i64) -> f64 {
        move |id| {
            pairs
                .iter()
                .find(|&&(k, _)| k == id)
                .map_or(0.0, |&(_, v)| v)
        }
    }

    fn armor_rep(amount: f64, cycle_seconds: f64) -> RemoteRep {
        RemoteRep {
            layer: RepairLayer::Armor,
            amount,
            cycle_seconds,
        }
    }

    #[test]
    fn a_repairer_with_a_range_is_remote_and_one_without_is_not() {
        // Small Remote Armor Repairer II: 64 HP every 3 s, 8.4 km range.
        let remote = attrs(&[
            (ARMOR_DAMAGE_AMOUNT, 64.0),
            (DURATION, 3000.0),
            (MAX_RANGE, 8400.0),
        ]);
        assert_eq!(remote_rep_from_attrs(remote), Some(armor_rep(64.0, 3.0)));
        // Small Armor Repairer II: the same amount attribute, no range.
        let local = attrs(&[(ARMOR_DAMAGE_AMOUNT, 92.0), (DURATION, 6000.0)]);
        assert_eq!(remote_rep_from_attrs(local), None);
        // A web has a range and a cycle but repairs nothing.
        let web = attrs(&[
            (SPEED_FACTOR, -60.0),
            (DURATION, 5000.0),
            (MAX_RANGE, 10_000.0),
        ]);
        assert_eq!(remote_rep_from_attrs(web), None);
    }

    #[test]
    fn each_amount_attribute_mends_its_own_layer() {
        let shield = attrs(&[(SHIELD_BONUS, 85.0), (DURATION, 4000.0), (MAX_RANGE, 1.0)]);
        let hull = attrs(&[
            (STRUCTURE_DAMAGE_AMOUNT, 58.0),
            (DURATION, 6000.0),
            (MAX_RANGE, 1.0),
        ]);
        assert_eq!(
            remote_rep_from_attrs(shield).map(|r| r.layer),
            Some(RepairLayer::Shield)
        );
        assert_eq!(
            remote_rep_from_attrs(hull).map(|r| r.layer),
            Some(RepairLayer::Hull)
        );
    }

    #[test]
    fn a_mutadaptive_repairer_counts_fully_spooled() {
        // Heavy Mutadaptive Remote Armor Repairer II: 512 HP, spooling to +150 %.
        let rep = remote_rep_from_attrs(attrs(&[
            (ARMOR_DAMAGE_AMOUNT, 512.0),
            (DURATION, 6000.0),
            (MAX_RANGE, 12_000.0),
            (REPAIR_MULTIPLIER_BONUS_MAX, 1.5),
        ]))
        .unwrap();
        assert_eq!(rep.amount, 1280.0);
    }

    #[test]
    fn a_lone_repairer_delivers_its_full_rate() {
        let reps = [armor_rep(64.0, 3.0)];
        assert_eq!(applied_remote_rep(&reps, RepairLayer::Armor), 64.0 / 3.0);
        assert_eq!(applied_remote_rep(&reps, RepairLayer::Shield), 0.0);
        assert_eq!(applied_remote_rep(&[], RepairLayer::Armor), 0.0);
    }

    #[test]
    fn stacked_repairers_on_one_layer_diminish() {
        // Two at r = 64/3: R = 2r, m = 7000 + 20r, and each keeps
        // 1 − ((r + m)/(R + m) − 1)² of its rate.
        let r: f64 = 64.0 / 3.0;
        let m = 7000.0 + 20.0 * r;
        let want = 2.0 * r * (1.0 - ((r + m) / (2.0 * r + m) - 1.0).powi(2));
        let two = [armor_rep(64.0, 3.0); 2];
        let got = applied_remote_rep(&two, RepairLayer::Armor);
        assert!((got - want).abs() < 1e-12);
        assert!(got < 2.0 * r, "two repairers must lose a little: {got}");

        // A repairer on another layer is not part of the pool.
        let mixed = [
            armor_rep(64.0, 3.0),
            RemoteRep {
                layer: RepairLayer::Shield,
                amount: 85.0,
                cycle_seconds: 4.0,
            },
        ];
        assert_eq!(applied_remote_rep(&mixed, RepairLayer::Armor), r);
        assert_eq!(applied_remote_rep(&mixed, RepairLayer::Shield), 85.0 / 4.0);
    }

    #[test]
    fn the_returns_are_weighed_on_whole_second_cycles() {
        // 4.9 s weighs as 4 s for the penalty, but still delivers over 4.9 s.
        let two = [armor_rep(98.0, 4.9); 2];
        let r: f64 = 98.0 / 4.0;
        let m = 7000.0 + 20.0 * r;
        let want = 2.0 * (98.0 / 4.9) * (1.0 - ((r + m) / (2.0 * r + m) - 1.0).powi(2));
        assert!((applied_remote_rep(&two, RepairLayer::Armor) - want).abs() < 1e-12);
        // A malformed sub-second cycle must not divide by zero.
        assert!(applied_remote_rep(&[armor_rep(10.0, 0.5); 2], RepairLayer::Armor).is_finite());
    }

    #[test]
    fn web_reduces_velocity_painter_grows_sig() {
        let mut ship = AttrStore::new();
        ship.seed(&[(attr::MAX_VELOCITY, 456.25), (SIGNATURE_RADIUS, 35.0)]);
        apply_projection(
            &mut ship,
            &[
                ProjectedInput {
                    speed_factor: -60.0,
                    ..Default::default()
                },
                ProjectedInput {
                    sig_radius_bonus: 30.0,
                    ..Default::default()
                },
            ],
        );
        // -60% velocity, +30% sig.
        assert!((ship.get(attr::MAX_VELOCITY) - 182.5).abs() < 1e-6);
        assert!((ship.get(SIGNATURE_RADIUS) - 45.5).abs() < 1e-6);
    }

    #[test]
    fn damp_reduces_lock_range_and_scan_res() {
        let mut ship = AttrStore::new();
        ship.seed(&[(MAX_TARGET_RANGE, 28125.0), (SCAN_RESOLUTION, 825.0)]);
        apply_projection(
            &mut ship,
            &[ProjectedInput {
                max_target_range_bonus: -15.3,
                scan_resolution_bonus: -15.3,
                ..Default::default()
            }],
        );
        assert!((ship.get(MAX_TARGET_RANGE) - 23821.9).abs() < 0.1);
        assert!((ship.get(SCAN_RESOLUTION) - 698.78).abs() < 0.1);
    }

    #[test]
    fn subsystem_grants_slots_to_a_zero_slot_hull() {
        // A T3 hull starts with 0 slots; a subsystem adds 2 med + 2 low (#178).
        let mut ship = AttrStore::new();
        ship.seed(&[(14, 0.0), (13, 0.0), (12, 0.0)]);
        apply_subsystem_slots(&mut ship, |id| match id {
            1375 => 2.0, // medSlotModifier
            1376 => 2.0, // lowSlotModifier
            _ => 0.0,
        });
        assert_eq!(ship.get(13), 2.0);
        assert_eq!(ship.get(12), 2.0);
        assert_eq!(ship.get(14), 0.0);
    }

    #[test]
    fn no_projection_is_a_no_op() {
        let mut ship = AttrStore::new();
        ship.seed(&[(attr::MAX_VELOCITY, 456.25)]);
        apply_projection(&mut ship, &[ProjectedInput::default()]);
        assert_eq!(ship.get(attr::MAX_VELOCITY), 456.25);
    }
}
