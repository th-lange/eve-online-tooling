//! Fighter squadron damage (#877): per-ability cycle damage from the
//! fighter type's own `fighterAbility*` attributes, scaled by squadron
//! size. Ported approach only (game math is factual) — mirrors the
//! turret/missile precedent in `damage.rs`/`cycle.rs`; Pyfa's
//! `eos.saveddata.fighter`/`fighterAbility` (GPL-3.0) was consulted for the
//! mechanic, never its code.
//!
//! Unlike turrets/launchers, a fighter type's damage figures live directly
//! on its own attributes — no separate charge/ammo split. Verified against
//! the SDE: every player-fittable fighter type (`invGroups.categoryID`
//! 87 — Light/Support/Heavy Fighter) that deals damage today carries one or
//! both of the two families below (`attackMissile`, the short-range
//! "Rockets" ability, and `missiles`, the longer-range "Fighter Missiles"
//! ability); no live type uses the turret- or kamikaze-shaped attributes the
//! SDE also defines, so those aren't modeled. A pure support/EW squadron
//! (e.g. an energy-neutralizer-only support fighter) carries neither and
//! contributes no DPS, matching the game.

use super::application::{missile_application, turret_chance_to_hit};
use super::attr::{attr, AttrStore};
use super::cycle::cycle_of;

/// One offensive ability family a fighter type may carry, keyed by a stable
/// slug (`FitItem::fighter_ability` uses the same key) with a human label
/// for the UI. Attribute ids verified against the SDE (`dgmAttributeTypes`).
struct AbilityAttrs {
    key: &'static str,
    label: &'static str,
    /// Rate of fire, ms (`fighterAbility*Duration`).
    duration: i64,
    /// `fighterAbility*DamageMultiplier`.
    damage_mult: i64,
    em: i64,
    therm: i64,
    kin: i64,
    exp: i64,
    /// `fighterAbility*ExplosionRadius` / `…ExplosionVelocity`: the ability is
    /// a missile attack, applied like one (#1272).
    explosion_radius: i64,
    explosion_velocity: i64,
    /// `…ReductionFactor` / `…ReductionSensitivity`: the damage-reduction
    /// factor comes in two halves on fighters, combined in [`aggregated_drf`].
    reduction_factor: i64,
    reduction_sensitivity: i64,
    /// `…RangeOptimal` (or plain `…Range`), and `…RangeFalloff` where the
    /// ability has one (`0` = none).
    range_optimal: i64,
    range_falloff: i64,
}

/// The two damage-ability families real fighter types carry today (#877).
const FAMILIES: [AbilityAttrs; 2] = [
    AbilityAttrs {
        key: "attackMissile",
        label: "Rockets",
        duration: 2233,              // fighterAbilityAttackMissileDuration
        damage_mult: 2226,           // fighterAbilityAttackMissileDamageMultiplier
        em: 2227,                    // fighterAbilityAttackMissileDamageEM
        therm: 2228,                 // fighterAbilityAttackMissileDamageTherm
        kin: 2229,                   // fighterAbilityAttackMissileDamageKin
        exp: 2230,                   // fighterAbilityAttackMissileDamageExp
        explosion_radius: 2234,      // fighterAbilityAttackMissileExplosionRadius
        explosion_velocity: 2235,    // fighterAbilityAttackMissileExplosionVelocity
        reduction_factor: 2231,      // fighterAbilityAttackMissileReductionFactor
        reduction_sensitivity: 2232, // fighterAbilityAttackMissileReductionSensitivity
        range_optimal: 2236,         // fighterAbilityAttackMissileRangeOptimal
        range_falloff: 2237,         // fighterAbilityAttackMissileRangeFalloff
    },
    AbilityAttrs {
        key: "missiles",
        label: "Fighter Missiles",
        duration: 2182,              // fighterAbilityMissilesDuration
        damage_mult: 2130,           // fighterAbilityMissilesDamageMultiplier
        em: 2131,                    // fighterAbilityMissilesDamageEM
        therm: 2132,                 // fighterAbilityMissilesDamageTherm
        kin: 2133,                   // fighterAbilityMissilesDamageKin
        exp: 2134,                   // fighterAbilityMissilesDamageExp
        explosion_radius: 2125,      // fighterAbilityMissilesExplosionRadius
        explosion_velocity: 2126,    // fighterAbilityMissilesExplosionVelocity
        reduction_factor: 2127,      // fighterAbilityMissilesDamageReductionFactor
        reduction_sensitivity: 2128, // fighterAbilityMissilesDamageReductionSensitivity
        range_optimal: 2149,         // fighterAbilityMissilesRange
        range_falloff: 0,            // no falloff attribute on this ability
    },
];

/// One resolved ability's DPS at a single fighter (before squadron-size
/// scaling), plus what it takes to apply that damage to a target.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct FighterAbility {
    pub key: &'static str,
    pub label: &'static str,
    /// Per-fighter burst DPS (no reload derating).
    pub dps_per_fighter: f64,
    /// Per-fighter sustained DPS (#871 reload accounting, via the shared
    /// `cycle_of` helper). Equal to `dps_per_fighter` today since no fighter
    /// ability carries `capacity`/`reloadTime` attributes in the SDE — the
    /// derating is wired through for any future ability that gains a clip,
    /// not currently exercised.
    pub sustained_dps_per_fighter: f64,
    /// Explosion radius (m) and velocity (m/s) of the ability's missile.
    pub explosion_radius: f64,
    pub explosion_velocity: f64,
    /// Damage reduction factor in the single-number form the missile formula
    /// takes — see [`aggregated_drf`].
    pub drf: f64,
    /// Optimal and falloff (m) of the ability; falloff is `0` when it has none.
    pub optimal: f64,
    pub falloff: f64,
}

/// Fighters carry the missile damage-reduction factor as two attributes,
/// `reductionFactor` and `reductionSensitivity`; the application formula wants
/// the one exponent `ln(factor) / ln(sensitivity)` (PYFA `_calcAggregatedDrf`).
/// `0` when either half is missing or degenerate, which makes
/// `missile_application` skip the speed term instead of producing NaN.
pub fn aggregated_drf(reduction_factor: f64, reduction_sensitivity: f64) -> f64 {
    if reduction_factor <= 0.0 || reduction_sensitivity <= 0.0 || reduction_sensitivity == 1.0 {
        return 0.0;
    }
    reduction_factor.ln() / reduction_sensitivity.ln()
}

/// Which fighter-tube category a squadron belongs to (#877) — the hull's
/// `fighterLightSlots`/`fighterSupportSlots`/`fighterHeavySlots` each cap a
/// different one of these independently, on top of the shared `fighterTubes`
/// total.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FighterCategory {
    Light,
    Support,
    Heavy,
}

/// Every offensive ability a *resolved* fighter type's attribute store
/// carries (non-zero total damage and rate of fire). `store` must be the
/// fighter's own finalized attributes (post dogma resolution), so carrier
/// skill/ship fighter-damage bonuses (`fighterBonus*`) are reflected.
pub fn abilities_of(store: &AttrStore) -> Vec<FighterAbility> {
    FAMILIES
        .iter()
        .filter_map(|f| {
            let damage = store.get(f.em) + store.get(f.therm) + store.get(f.kin) + store.get(f.exp);
            let duration_seconds = store.get(f.duration) / 1000.0;
            if damage <= 0.0 || duration_seconds <= 0.0 {
                return None;
            }
            let mult = store.get(f.damage_mult);
            let mult = if mult > 0.0 { mult } else { 1.0 };
            let burst = damage * mult / duration_seconds;
            // Reload accounting (#871): reuses the shared clip/reload helper
            // exactly like turrets/launchers (see module doc comment).
            let factor = cycle_of(store, None).sustained_factor(duration_seconds);
            Some(FighterAbility {
                key: f.key,
                label: f.label,
                dps_per_fighter: burst,
                sustained_dps_per_fighter: burst * factor,
                explosion_radius: store.get(f.explosion_radius),
                explosion_velocity: store.get(f.explosion_velocity),
                drf: aggregated_drf(
                    store.get(f.reduction_factor),
                    store.get(f.reduction_sensitivity),
                ),
                optimal: store.get(f.range_optimal),
                falloff: if f.range_falloff > 0 {
                    store.get(f.range_falloff)
                } else {
                    0.0
                },
            })
        })
        .collect()
}

impl FighterAbility {
    /// Fraction of this ability's paper damage that lands on a target (PYFA
    /// `getFighterAbilityMult`): the missile explosion-radius/velocity factor,
    /// times a range factor.
    ///
    /// `closes_range` says the squadron can fly to the target and hold its own
    /// optimal — range then costs nothing. Otherwise the squadron is taken to
    /// sit on the carrier and shoot from `distance`, so the ability's optimal
    /// and falloff apply (an ability without falloff simply stops at optimal).
    pub fn application(
        &self,
        closes_range: bool,
        target_sig: f64,
        target_speed: f64,
        distance: f64,
    ) -> f64 {
        let range = if closes_range {
            1.0
        } else {
            // Tracking terms zeroed: what is left of the turret formula is
            // exactly the optimal/falloff curve.
            turret_chance_to_hit(self.optimal, self.falloff, 0.0, 0.0, 0.0, 0.0, distance)
        };
        range
            * missile_application(
                self.explosion_radius,
                self.explosion_velocity,
                self.drf,
                target_sig,
                target_speed,
            )
    }
}

/// Pick one ability to fire: the pilot's explicit choice (`selected`, a key
/// from [`abilities_of`]) when the type actually carries it, else the
/// highest-DPS one available. `None` when the squadron has no offensive
/// ability at all (a pure support/EW type).
pub fn selected_ability<'a>(
    abilities: &'a [FighterAbility],
    selected: Option<&str>,
) -> Option<&'a FighterAbility> {
    if let Some(key) = selected {
        if let Some(found) = abilities.iter().find(|a| a.key == key) {
            return Some(found);
        }
    }
    abilities
        .iter()
        .max_by(|a, b| a.dps_per_fighter.total_cmp(&b.dps_per_fighter))
}

/// Which tube category a fighter type's *finalized* attributes flag it as
/// (`fighterSquadronIsLight`/`IsSupport`/`IsHeavy`) — exactly one is set on
/// any real fighter type; `None` if somehow none are (defensive, never hit
/// against the real SDE).
pub fn category_of(store: &AttrStore) -> Option<FighterCategory> {
    category_from_flags(
        store.get(attr::FIGHTER_SQUADRON_IS_LIGHT),
        store.get(attr::FIGHTER_SQUADRON_IS_SUPPORT),
        store.get(attr::FIGHTER_SQUADRON_IS_HEAVY),
    )
}

/// [`category_of`] over raw attribute values, for callers reading a type's
/// *base* (pre-dogma) attributes directly rather than a resolved store.
pub fn category_from_flags(
    is_light: f64,
    is_support: f64,
    is_heavy: f64,
) -> Option<FighterCategory> {
    if is_light > 0.0 {
        Some(FighterCategory::Light)
    } else if is_support > 0.0 {
        Some(FighterCategory::Support)
    } else if is_heavy > 0.0 {
        Some(FighterCategory::Heavy)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A Firbolg-shaped store: both `attackMissile` (short-range) and
    /// `missiles` (long-range) present, real PYFA v2.67.0/SDE magnitudes.
    fn firbolg() -> AttrStore {
        let mut s = AttrStore::new();
        s.set_base(2233, 5000.0); // attackMissile duration 5s
        s.set_base(2226, 1.0); // damage multiplier
        s.set_base(2228, 112.5); // thermal damage
        s.set_base(2182, 14000.0); // missiles duration 14s
        s.set_base(2130, 1.0);
        s.set_base(2132, 207.0); // thermal damage
        s
    }

    #[test]
    fn abilities_of_finds_both_families_with_correct_dps() {
        let abilities = abilities_of(&firbolg());
        assert_eq!(abilities.len(), 2);
        let attack = abilities.iter().find(|a| a.key == "attackMissile").unwrap();
        assert!((attack.dps_per_fighter - 112.5 / 5.0).abs() < 1e-9);
        let missiles = abilities.iter().find(|a| a.key == "missiles").unwrap();
        assert!((missiles.dps_per_fighter - 207.0 / 14.0).abs() < 1e-9);
        // No reload attributes on a fighter ability today — sustained == burst.
        assert_eq!(attack.dps_per_fighter, attack.sustained_dps_per_fighter);
    }

    #[test]
    fn selected_ability_defaults_to_highest_dps() {
        let abilities = abilities_of(&firbolg());
        // attackMissile: 112.5/5=22.5 dps; missiles: 207/14≈14.79 dps.
        let chosen = selected_ability(&abilities, None).unwrap();
        assert_eq!(chosen.key, "attackMissile");
    }

    #[test]
    fn selected_ability_honors_a_valid_explicit_choice() {
        let abilities = abilities_of(&firbolg());
        let chosen = selected_ability(&abilities, Some("missiles")).unwrap();
        assert_eq!(chosen.key, "missiles");
    }

    #[test]
    fn selected_ability_falls_back_when_the_choice_is_unavailable() {
        let abilities = abilities_of(&firbolg());
        let chosen = selected_ability(&abilities, Some("kamikaze")).unwrap();
        assert_eq!(chosen.key, "attackMissile"); // falls back to highest-DPS
    }

    #[test]
    fn a_pure_support_fighter_has_no_offensive_ability() {
        let s = AttrStore::new(); // no ability attributes at all
        assert!(abilities_of(&s).is_empty());
        assert!(selected_ability(&abilities_of(&s), None).is_none());
    }

    #[test]
    fn category_of_reads_the_squadron_flag() {
        let mut s = AttrStore::new();
        s.set_base(attr::FIGHTER_SQUADRON_IS_SUPPORT, 1.0);
        assert_eq!(category_of(&s), Some(FighterCategory::Support));
    }

    /// A rocket ability with round application numbers: 100 m explosion
    /// radius, 100 m/s explosion velocity, 10 km optimal + 5 km falloff, and
    /// reduction factor/sensitivity chosen so the exponent is exactly 0.5
    /// (`ln 2 / ln 4`).
    fn rockets() -> FighterAbility {
        let mut s = firbolg();
        s.set_base(2234, 100.0); // explosion radius
        s.set_base(2235, 100.0); // explosion velocity
        s.set_base(2231, 2.0); // reduction factor
        s.set_base(2232, 4.0); // reduction sensitivity
        s.set_base(2236, 10_000.0); // optimal
        s.set_base(2237, 5_000.0); // falloff
        *abilities_of(&s)
            .iter()
            .find(|a| a.key == "attackMissile")
            .unwrap()
    }

    #[test]
    fn the_two_reduction_attributes_fold_into_one_exponent() {
        assert!((rockets().drf - 0.5).abs() < 1e-12);
        // A missing or degenerate half must not turn into NaN or infinity.
        assert_eq!(aggregated_drf(0.0, 4.0), 0.0);
        assert_eq!(aggregated_drf(2.0, 0.0), 0.0);
        assert_eq!(aggregated_drf(2.0, 1.0), 0.0);
    }

    #[test]
    fn a_big_slow_target_takes_full_fighter_damage() {
        assert_eq!(rockets().application(true, 400.0, 0.0, 0.0), 1.0);
    }

    #[test]
    fn a_small_target_takes_the_signature_fraction() {
        // sig 40 against a 100 m explosion radius, standing still: 40 %.
        assert!((rockets().application(true, 40.0, 0.0, 0.0) - 0.4).abs() < 1e-12);
    }

    #[test]
    fn a_fast_target_takes_the_speed_term() {
        // sig 100 at 400 m/s: (100·100 / (100·400))^0.5 = 0.5, below the
        // signature term's 1.0.
        assert!((rockets().application(true, 100.0, 400.0, 0.0) - 0.5).abs() < 1e-12);
    }

    #[test]
    fn a_squadron_that_cannot_close_range_shoots_through_its_falloff() {
        let r = rockets();
        // Inside optimal: range costs nothing either way.
        assert_eq!(r.application(false, 400.0, 0.0, 10_000.0), 1.0);
        // One falloff past optimal: half.
        assert!((r.application(false, 400.0, 0.0, 15_000.0) - 0.5).abs() < 1e-12);
        // The same distance costs nothing once the squadron flies there.
        assert_eq!(r.application(true, 400.0, 0.0, 15_000.0), 1.0);
    }

    #[test]
    fn an_ability_without_falloff_stops_at_its_range() {
        let mut s = firbolg();
        s.set_base(2125, 100.0); // explosion radius
        s.set_base(2149, 20_000.0); // fighterAbilityMissilesRange
        let abilities = abilities_of(&s);
        let missiles = abilities.iter().find(|a| a.key == "missiles").unwrap();
        assert_eq!(missiles.falloff, 0.0);
        assert_eq!(missiles.application(false, 400.0, 0.0, 20_000.0), 1.0);
        assert_eq!(missiles.application(false, 400.0, 0.0, 20_001.0), 0.0);
    }
}
