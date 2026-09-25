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
}

/// The two damage-ability families real fighter types carry today (#877).
const FAMILIES: [AbilityAttrs; 2] = [
    AbilityAttrs {
        key: "attackMissile",
        label: "Rockets",
        duration: 2233,    // fighterAbilityAttackMissileDuration
        damage_mult: 2226, // fighterAbilityAttackMissileDamageMultiplier
        em: 2227,          // fighterAbilityAttackMissileDamageEM
        therm: 2228,       // fighterAbilityAttackMissileDamageTherm
        kin: 2229,         // fighterAbilityAttackMissileDamageKin
        exp: 2230,         // fighterAbilityAttackMissileDamageExp
    },
    AbilityAttrs {
        key: "missiles",
        label: "Fighter Missiles",
        duration: 2182,    // fighterAbilityMissilesDuration
        damage_mult: 2130, // fighterAbilityMissilesDamageMultiplier
        em: 2131,          // fighterAbilityMissilesDamageEM
        therm: 2132,       // fighterAbilityMissilesDamageTherm
        kin: 2133,         // fighterAbilityMissilesDamageKin
        exp: 2134,         // fighterAbilityMissilesDamageExp
    },
];

/// One resolved ability's DPS at a single fighter (before squadron-size
/// scaling).
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
            })
        })
        .collect()
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
}
