//! Weapon cycle/clip/reload parameters (#871) — pure, and the **shared**
//! entry point for reload accounting: DPS sustained-rate derating here, cap
//! reload-pause in `engine::capacitor`, and the cap-booster injection sim
//! (#875) all build on [`cycle_of`]/[`ReloadCycle`] rather than duplicating
//! the clip-size math.
//!
//! Mirrors PYFA's `eos.saveddata.module.Module.getCycleParameters()`
//! approach (game math is factual, ported here — not PYFA's GPL-3.0 code):
//! a module's clip size is `floor(floor(capacity(38) / chargeVolume(161)) /
//! chargesPerCycle(56))` shots, after which it must `reloadTime(1795)`
//! before firing again. A module with no loaded charge, no `capacity`, or no
//! `reloadTime` has no clip at all — infinite ammo, exactly today's
//! behavior (sustained DPS == burst DPS, cap draw never pauses).

use super::attr::{attr, AttrStore};

/// One module's clip/reload cycle, derived from its own finalized `capacity`
/// (38) and its loaded charge's `volume` (161) + `chargesPerCycle` (56).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct ReloadCycle {
    /// Shots fired per clip before a reload is needed. `0.0` = infinite ammo
    /// (no charge loaded, or the module/charge carry no capacity/volume) —
    /// the module never reloads.
    pub clip_shots: f64,
    /// Reload pause, seconds. `0.0` when the module has no `reloadTime`
    /// attribute at all (most non-weapon modules).
    pub reload_seconds: f64,
}

impl ReloadCycle {
    /// Whether this module ever reloads — both a finite clip *and* a nonzero
    /// reload pause are required. The gate every reload-accounting branch
    /// (DPS derating, cap-drain pause) shares.
    pub fn reloads(&self) -> bool {
        self.clip_shots > 0.0 && self.reload_seconds > 0.0
    }

    /// Sustained-vs-burst scaling factor: the fraction of an "average cycle"
    /// (clip-firing time + reload pause) actually spent firing/drawing
    /// capacitor. `rof_seconds` is the module's normal per-shot cycle time
    /// (`speed`/duration). `1.0` (no derating) when the module doesn't
    /// reload — burst and sustained are then identical, matching today's
    /// infinite-ammo behavior exactly.
    pub fn sustained_factor(&self, rof_seconds: f64) -> f64 {
        if !self.reloads() || rof_seconds <= 0.0 {
            return 1.0;
        }
        let fire_seconds = self.clip_shots * rof_seconds;
        fire_seconds / (fire_seconds + self.reload_seconds)
    }
}

/// Derive a module's [`ReloadCycle`] from its own finalized attributes and
/// its loaded charge's (`None` for unloaded/chargeless modules — drones,
/// passive mods, reps with no ammo, …, which then always report an infinite
/// clip). `module`/`charge` are *finalized* [`AttrStore`]s (post dogma
/// resolution), so skill/ship bonuses to capacity are reflected.
pub fn cycle_of(module: &AttrStore, charge: Option<&AttrStore>) -> ReloadCycle {
    let reload_seconds = module.get(attr::RELOAD_TIME) / 1000.0;
    let Some(charge) = charge else {
        return ReloadCycle {
            clip_shots: 0.0,
            reload_seconds,
        };
    };
    let capacity = module.get(attr::CAPACITY);
    let volume = charge.get(attr::VOLUME);
    let clip_shots = if capacity > 0.0 && volume > 0.0 {
        let charges_per_cycle = {
            let c = module.get(attr::CHARGES_PER_CYCLE);
            if c > 0.0 {
                c
            } else {
                1.0
            }
        };
        ((capacity / volume).floor() / charges_per_cycle)
            .floor()
            .max(0.0)
    } else {
        0.0
    };
    ReloadCycle {
        clip_shots,
        reload_seconds,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store(attrs: &[(i64, f64)]) -> AttrStore {
        let mut s = AttrStore::default();
        for &(id, v) in attrs {
            s.set_base(id, v);
        }
        s
    }

    /// Rapid Light Missile Launcher II + Scourge Light Missile (real PYFA
    /// v2.67.0 SDE attribute values): capacity 0.3 m³, reloadTime 35s, RoF
    /// 6.24s; Scourge Light Missile volume 0.015 m³ → clip = floor(0.3 /
    /// 0.015) = 20 shots. Sustained factor = (20×6.24) / (20×6.24 + 35) =
    /// 124.8 / 159.8.
    #[test]
    fn rapid_light_missile_launcher_clip_and_sustained_factor() {
        let launcher = store(&[
            (attr::CAPACITY, 0.3),
            (attr::RELOAD_TIME, 35_000.0),
            (attr::RATE_OF_FIRE, 6_240.0),
        ]);
        let missile = store(&[(attr::VOLUME, 0.015)]);
        let cycle = cycle_of(&launcher, Some(&missile));
        assert_eq!(cycle.clip_shots, 20.0);
        assert_eq!(cycle.reload_seconds, 35.0);
        assert!(cycle.reloads());
        let factor = cycle.sustained_factor(6.24);
        assert!((factor - 124.8 / 159.8).abs() < 1e-9);
    }

    /// No `reloadTime` attribute (most turrets/lasers effectively never run
    /// dry in normal play) → infinite clip, no derating at all.
    #[test]
    fn no_reload_time_is_infinite_ammo() {
        let module = store(&[(attr::CAPACITY, 5.0)]);
        let charge = store(&[(attr::VOLUME, 0.05)]);
        let cycle = cycle_of(&module, Some(&charge));
        assert!(!cycle.reloads());
        assert_eq!(cycle.sustained_factor(2.0), 1.0);
    }

    /// No charge loaded (or no charge slot at all, e.g. drones/reps) →
    /// infinite clip regardless of the module's own reloadTime.
    #[test]
    fn no_charge_is_infinite_ammo() {
        let module = store(&[(attr::CAPACITY, 5.0), (attr::RELOAD_TIME, 10_000.0)]);
        let cycle = cycle_of(&module, None);
        assert_eq!(cycle.clip_shots, 0.0);
        assert!(!cycle.reloads());
    }

    /// `chargesPerCycle` > 1 divides the raw capacity/volume shot count.
    #[test]
    fn charges_per_cycle_divides_clip_size() {
        let module = store(&[
            (attr::CAPACITY, 10.0),
            (attr::RELOAD_TIME, 10_000.0),
            (attr::CHARGES_PER_CYCLE, 2.0),
        ]);
        let charge = store(&[(attr::VOLUME, 1.0)]);
        let cycle = cycle_of(&module, Some(&charge));
        assert_eq!(cycle.clip_shots, 5.0); // floor(10/1) / 2
    }
}
