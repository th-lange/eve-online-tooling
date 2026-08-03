//! Abyssal Deadspace weather — static, hardcoded bonus/penalty pairs.
//!
//! Unlike Pochven metaliminal storms (dogma-driven, see
//! [`super::super::stats::run_dogma`]'s `environment_effect`), true Abyssal
//! Deadspace weather has **no dogma-attribute representation anywhere in the
//! SDE**: it's computed dynamically per pocket instance server-side. Neither
//! the flavor marker types (e.g. "Electrical Storm", typeID 47862-47866) nor
//! any tier of filament item carries a single dogma effect or attribute for
//! it — verified directly against the SDE. These magnitudes are therefore
//! hardcoded from community reference data (the penalty scales with filament
//! tier — 30/50/70% is the commonly cited range; the bonus is a flat 50%
//! regardless of tier), applied as a direct post-resolve adjustment exactly
//! like [`super::projection`]'s projected effects (webs/paints/damps) — no
//! dogma effect entity backs this either.

use super::attr::{attr, AttrStore};
use super::modifier::Op;
use crate::modules::fitting::types::{AbyssalWeather, AbyssalWeatherSelection};

const SCAN_RESOLUTION: i64 = 564;
const ARMOR_HP: i64 = 265;
const MAX_RANGE: i64 = 54; // turret optimal range
const FALLOFF: i64 = 158;

const SHIELD_EM_RESONANCE: i64 = 271;
const SHIELD_EXPLOSIVE_RESONANCE: i64 = 272;
const SHIELD_KINETIC_RESONANCE: i64 = 273;
const SHIELD_THERMAL_RESONANCE: i64 = 274;
const ARMOR_EM_RESONANCE: i64 = 267;
const ARMOR_KINETIC_RESONANCE: i64 = 269;
const ARMOR_THERMAL_RESONANCE: i64 = 270;
const ARMOR_EXPLOSIVE_RESONANCE: i64 = 268;
const HULL_EM_RESONANCE: i64 = 113;
const HULL_KINETIC_RESONANCE: i64 = 109;
const HULL_THERMAL_RESONANCE: i64 = 110;
const HULL_EXPLOSIVE_RESONANCE: i64 = 111;

/// Apply a resist penalty (raises resonance — i.e. *lowers* resistance — by
/// `pct`) across all three tank layers for one damage type. Stacking-
/// penalized like any other post-percent ship modifier.
fn apply_resist_penalty(ship: &mut AttrStore, layer_attrs: [i64; 3], pct: f64) {
    for attr_id in layer_attrs {
        ship.apply(attr_id, Op::PostPercent, pct, true);
    }
}

/// Apply an Abyssal Deadspace weather's fixed bonus/penalty pair (#env-
/// selector). `modules` is `resolved.modules`, mutated in place — Dark's
/// range penalty lands on every fitted module's own `maxRange`/`falloff`
/// (a no-op on modules without those attributes), not a ship-wide stat.
pub fn apply_abyssal_weather(
    ship: &mut AttrStore,
    modules: &mut [AttrStore],
    selection: AbyssalWeatherSelection,
) {
    let penalty = selection.tier_pct;
    match selection.weather {
        AbyssalWeather::Dark => {
            for m in modules.iter_mut() {
                m.apply(MAX_RANGE, Op::PostPercent, -penalty, true);
                m.apply(FALLOFF, Op::PostPercent, -penalty, true);
            }
            ship.apply(attr::MAX_VELOCITY, Op::PostPercent, 50.0, true);
        }
        AbyssalWeather::Electrical => {
            apply_resist_penalty(
                ship,
                [SHIELD_EM_RESONANCE, ARMOR_EM_RESONANCE, HULL_EM_RESONANCE],
                penalty,
            );
            ship.apply(attr::RECHARGE_RATE, Op::PostPercent, -50.0, true);
        }
        AbyssalWeather::Exotic => {
            apply_resist_penalty(
                ship,
                [
                    SHIELD_KINETIC_RESONANCE,
                    ARMOR_KINETIC_RESONANCE,
                    HULL_KINETIC_RESONANCE,
                ],
                penalty,
            );
            ship.apply(SCAN_RESOLUTION, Op::PostPercent, 50.0, true);
        }
        AbyssalWeather::Firestorm => {
            apply_resist_penalty(
                ship,
                [
                    SHIELD_THERMAL_RESONANCE,
                    ARMOR_THERMAL_RESONANCE,
                    HULL_THERMAL_RESONANCE,
                ],
                penalty,
            );
            ship.apply(ARMOR_HP, Op::PostPercent, 50.0, true);
        }
        AbyssalWeather::Gamma => {
            apply_resist_penalty(
                ship,
                [
                    SHIELD_EXPLOSIVE_RESONANCE,
                    ARMOR_EXPLOSIVE_RESONANCE,
                    HULL_EXPLOSIVE_RESONANCE,
                ],
                penalty,
            );
            ship.apply(attr::SHIELD_CAPACITY, Op::PostPercent, 50.0, true);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn seeded(attrs: &[(i64, f64)]) -> AttrStore {
        let mut s = AttrStore::new();
        s.seed(attrs);
        s
    }

    #[test]
    fn electrical_halves_recharge_time_and_cuts_em_resist_on_all_layers() {
        let mut ship = seeded(&[
            (attr::RECHARGE_RATE, 140_625.0), // ms
            (SHIELD_EM_RESONANCE, 0.4),
            (ARMOR_EM_RESONANCE, 0.5),
            (HULL_EM_RESONANCE, 0.6),
        ]);
        let mut modules: Vec<AttrStore> = Vec::new();
        apply_abyssal_weather(
            &mut ship,
            &mut modules,
            AbyssalWeatherSelection {
                weather: AbyssalWeather::Electrical,
                tier_pct: 30.0,
            },
        );
        assert!(
            (ship.get(attr::RECHARGE_RATE) - 70_312.5).abs() < 1e-6,
            "recharge time should halve: got {}",
            ship.get(attr::RECHARGE_RATE)
        );
        assert!((ship.get(SHIELD_EM_RESONANCE) - 0.52).abs() < 1e-9);
        assert!((ship.get(ARMOR_EM_RESONANCE) - 0.65).abs() < 1e-9);
        assert!((ship.get(HULL_EM_RESONANCE) - 0.78).abs() < 1e-9);
    }

    #[test]
    fn dark_cuts_every_module_range_and_boosts_ship_velocity() {
        let mut ship = seeded(&[(attr::MAX_VELOCITY, 200.0)]);
        let mut modules = vec![
            seeded(&[(MAX_RANGE, 10_000.0), (FALLOFF, 5_000.0)]),
            seeded(&[(MAX_RANGE, 20_000.0), (FALLOFF, 0.0)]),
        ];
        apply_abyssal_weather(
            &mut ship,
            &mut modules,
            AbyssalWeatherSelection {
                weather: AbyssalWeather::Dark,
                tier_pct: 50.0,
            },
        );
        assert!((ship.get(attr::MAX_VELOCITY) - 300.0).abs() < 1e-9);
        assert!((modules[0].get(MAX_RANGE) - 5_000.0).abs() < 1e-9);
        assert!((modules[0].get(FALLOFF) - 2_500.0).abs() < 1e-9);
        assert!((modules[1].get(MAX_RANGE) - 10_000.0).abs() < 1e-9);
    }

    #[test]
    fn gamma_boosts_shield_hp_by_a_flat_fifty_percent_regardless_of_tier() {
        for tier_pct in [30.0, 50.0, 70.0] {
            let mut ship = seeded(&[(attr::SHIELD_CAPACITY, 1_000.0)]);
            let mut modules: Vec<AttrStore> = Vec::new();
            apply_abyssal_weather(
                &mut ship,
                &mut modules,
                AbyssalWeatherSelection {
                    weather: AbyssalWeather::Gamma,
                    tier_pct,
                },
            );
            assert!(
                (ship.get(attr::SHIELD_CAPACITY) - 1_500.0).abs() < 1e-9,
                "shield HP bonus is always +50%, independent of the {tier_pct}% penalty tier"
            );
        }
    }
}
