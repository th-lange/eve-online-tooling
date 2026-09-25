//! Triglavian/spoolable weapon + rep ramp-up (#872) — pure.
//!
//! Entropic Disintegrators (and a handful of spoolable reps) increase their
//! effective multiplier every cycle up to a cap: `damageMultiplierBonusMax`
//! (2734) / `damageMultiplierBonusPerCycle` (2733) for weapons,
//! `repairMultiplierBonusMax` (2797) / `repairMultiplierBonusPerCycle` (2796)
//! for reps — both read off the *module's own* finalized attributes (not the
//! charge). Applied as a direct post-resolve adjustment exactly like
//! [`super::abyssal`]'s weather bonuses: not a dogma effect, so nothing in
//! `resolve.rs` produces it.
//!
//! Pyfa's `eos.utils.spoolSupport.calculateSpoolup` (`SPOOL_SCALE` mode) is
//! the reference: a requested fraction of max resolves to a *whole* number of
//! cycles (never linear interpolation between cycles), then the boost is
//! re-derived for that many complete cycles. We port that approach — game
//! math is factual — not Pyfa's (GPL-3.0) code:
//! `cycles = ceil(max × pct ÷ per_cycle)`, `boost = min(max, cycles × per_cycle)`.

use super::attr::{attr, AttrStore};
use super::modifier::Op;

const DAMAGE_BONUS_PER_CYCLE: i64 = 2733;
const DAMAGE_BONUS_MAX: i64 = 2734;
const REPAIR_AMOUNT: i64 = 84; // armorDamageAmount — the only rep mechanic this engine models (local reps)
const REPAIR_BONUS_PER_CYCLE: i64 = 2796;
const REPAIR_BONUS_MAX: i64 = 2797;

/// Multiplier increment at `pct` (0.0..=1.0 of the way to fully spooled) from
/// a module's own finalized `…BonusMax`/`…BonusPerCycle` pair. `0.0` when the
/// entity isn't spoolable (either attribute missing/zero — the non-
/// Triglavian fast path) or `pct` rounds to no whole cycles.
pub fn spool_boost(max: f64, per_cycle: f64, pct: f64) -> f64 {
    if max <= 0.0 || per_cycle <= 0.0 {
        return 0.0;
    }
    let pct = pct.clamp(0.0, 1.0);
    if pct <= 0.0 {
        return 0.0;
    }
    let raw_cycles = max * pct / per_cycle;
    // Round away float noise (e.g. 2.3/0.1 landing on 22.999999999999996)
    // before ceiling — a whole-cycle count must be exact, not fractional.
    let cycles = (raw_cycles * 1e9).round() / 1e9;
    (cycles.ceil() * per_cycle).min(max)
}

/// Apply weapon + rep spool-up (#872) to every module/drone's own finalized
/// `damageMultiplier` (64) / `armorDamageAmount` (84), scaling each by
/// `1 + spool_boost(...)` from its own max/per-cycle attributes. A no-op on
/// non-spoolable entities — zero behavioral change for the rest of the game.
/// `pct` is the requested spool fraction: `0.0` = cold (no ramp), `1.0` =
/// fully spooled (how players quote Triglavian DPS). Returns whether the fit
/// carries *any* spoolable module/drone, independent of `pct` — the UI's
/// "show the spool selector at all" gate.
pub fn apply_spool(modules: &mut [AttrStore], drones: &mut [AttrStore], pct: f64) -> bool {
    let mut spoolable = false;
    for store in modules.iter_mut().chain(drones.iter_mut()) {
        let dmg_max = store.get(DAMAGE_BONUS_MAX);
        let dmg_per_cycle = store.get(DAMAGE_BONUS_PER_CYCLE);
        if dmg_max > 0.0 && dmg_per_cycle > 0.0 {
            spoolable = true;
            let boost = spool_boost(dmg_max, dmg_per_cycle, pct);
            if boost != 0.0 {
                store.apply(attr::DAMAGE_MULTIPLIER, Op::PostMul, 1.0 + boost, false);
            }
        }
        let rep_max = store.get(REPAIR_BONUS_MAX);
        let rep_per_cycle = store.get(REPAIR_BONUS_PER_CYCLE);
        if rep_max > 0.0 && rep_per_cycle > 0.0 {
            spoolable = true;
            let boost = spool_boost(rep_max, rep_per_cycle, pct);
            if boost != 0.0 {
                store.apply(REPAIR_AMOUNT, Op::PostMul, 1.0 + boost, false);
            }
        }
    }
    spoolable
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Real Heavy Entropic Disintegrator II attributes (Pyfa v2.67.0 bundled
    /// SDE): `damageMultiplierBonusPerCycle` 0.07 (7%/cycle),
    /// `damageMultiplierBonusMax` 2.125 (212.5%) — matches the issue's "+125%
    /// or more" on the hull line.
    const HEAVY_ED_II_PER_CYCLE: f64 = 0.07;
    const HEAVY_ED_II_MAX: f64 = 2.125;

    #[test]
    fn cold_weapon_has_no_boost() {
        assert_eq!(
            spool_boost(HEAVY_ED_II_MAX, HEAVY_ED_II_PER_CYCLE, 0.0),
            0.0
        );
    }

    #[test]
    fn fully_spooled_caps_at_max() {
        // ceil(2.125 / 0.07) = 31 cycles; 31 × 0.07 = 2.17 > max, so it caps
        // exactly at 2.125 — a 3.125× multiplier on the hull line.
        let boost = spool_boost(HEAVY_ED_II_MAX, HEAVY_ED_II_PER_CYCLE, 1.0);
        assert!((boost - HEAVY_ED_II_MAX).abs() < 1e-9, "boost {boost}");
    }

    #[test]
    fn half_spool_is_a_whole_cycle_count_not_linear_interpolation() {
        // raw_cycles = 2.125 × 0.5 ÷ 0.07 ≈ 15.18 → ceil to 16 whole cycles,
        // not exactly half of the fully-spooled 2.125 — SPOOL_SCALE resolves
        // to a *cycle count*, then re-derives the value for it.
        let boost = spool_boost(HEAVY_ED_II_MAX, HEAVY_ED_II_PER_CYCLE, 0.5);
        let want = 16.0 * HEAVY_ED_II_PER_CYCLE;
        assert!((boost - want).abs() < 1e-9, "boost {boost} want {want}");
        assert!(
            boost > HEAVY_ED_II_MAX * 0.5,
            "overshoots the linear midpoint"
        );
    }

    #[test]
    fn non_spoolable_module_is_untouched() {
        assert_eq!(spool_boost(0.0, 0.0, 1.0), 0.0);
        assert_eq!(spool_boost(0.5, 0.0, 1.0), 0.0); // per-cycle missing
        assert_eq!(spool_boost(0.0, 0.05, 1.0), 0.0); // max missing
    }

    #[test]
    fn apply_spool_scales_damage_multiplier_in_place() {
        let mut gun = AttrStore::new();
        gun.seed(&[
            (attr::DAMAGE_MULTIPLIER, 3.0),
            (DAMAGE_BONUS_MAX, HEAVY_ED_II_MAX),
            (DAMAGE_BONUS_PER_CYCLE, HEAVY_ED_II_PER_CYCLE),
        ]);
        let mut modules = [gun];
        let spoolable = apply_spool(&mut modules, &mut [], 1.0);
        assert!(spoolable);
        // 3.0 × (1 + 2.125) = 9.375.
        let got = modules[0].get(attr::DAMAGE_MULTIPLIER);
        assert!((got - 9.375).abs() < 1e-9, "got {got}");
    }

    #[test]
    fn apply_spool_at_zero_pct_leaves_damage_multiplier_unchanged() {
        let mut gun = AttrStore::new();
        gun.seed(&[
            (attr::DAMAGE_MULTIPLIER, 3.0),
            (DAMAGE_BONUS_MAX, HEAVY_ED_II_MAX),
            (DAMAGE_BONUS_PER_CYCLE, HEAVY_ED_II_PER_CYCLE),
        ]);
        let mut modules = [gun];
        // Still reports spoolable (the module *has* the attributes) — 0% just
        // means no cycles fired yet.
        let spoolable = apply_spool(&mut modules, &mut [], 0.0);
        assert!(spoolable);
        assert_eq!(modules[0].get(attr::DAMAGE_MULTIPLIER), 3.0);
    }

    #[test]
    fn non_triglavian_gun_is_zero_behavioral_change() {
        let mut gun = AttrStore::new();
        gun.seed(&[(attr::DAMAGE_MULTIPLIER, 3.465)]); // e.g. a 200mm AC II — no spool attrs at all
        let mut modules = [gun];
        let spoolable = apply_spool(&mut modules, &mut [], 1.0);
        assert!(!spoolable);
        assert_eq!(modules[0].get(attr::DAMAGE_MULTIPLIER), 3.465);
    }

    #[test]
    fn repair_multiplier_spools_the_same_way() {
        let mut rep = AttrStore::new();
        rep.seed(&[
            (REPAIR_AMOUNT, 120.0),
            (REPAIR_BONUS_MAX, 0.5),
            (REPAIR_BONUS_PER_CYCLE, 0.1),
        ]);
        let mut modules = [rep];
        apply_spool(&mut modules, &mut [], 1.0);
        // ceil(0.5/0.1) = 5 cycles × 0.1 = 0.5 = max exactly.
        let got = modules[0].get(REPAIR_AMOUNT);
        assert!((got - 180.0).abs() < 1e-9, "got {got}"); // 120 × 1.5
    }
}
