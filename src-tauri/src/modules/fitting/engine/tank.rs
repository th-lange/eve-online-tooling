//! Tank: resists, EHP and local reps (#173) — pure.
//!
//! Resonance is the fraction of damage that gets through (1.0 = 0% resist,
//! 0.9 = 10% resist); resist% = 1 − resonance. A layer's effective resonance
//! against a damage profile is the profile-weighted average of its four
//! resonances, and EHP = HP / effective_resonance. Total EHP sums the shield,
//! armor and hull layers. The command reads *finalized* resonances/HP, so
//! hardeners, rigs and skills are already applied.

use crate::modules::fitting::types::TankStats;

/// Damage-type weighting for EHP. Order: `[em, thermal, kinetic, explosive]`.
#[derive(Debug, Clone, Copy)]
pub struct DamageProfile(pub [f64; 4]);

impl Default for DamageProfile {
    /// An even 25/25/25/25 split — the conventional default EHP basis.
    fn default() -> Self {
        DamageProfile([0.25, 0.25, 0.25, 0.25])
    }
}

/// One defensive layer: hit points and the four damage resonances.
#[derive(Debug, Clone, Copy)]
pub struct Layer {
    pub hp: f64,
    /// `[em, thermal, kinetic, explosive]` resonances (damage taken fraction).
    pub resonance: [f64; 4],
}

impl Layer {
    /// Profile-weighted effective resonance (clamped to ≥ a tiny epsilon so an
    /// all-immune layer doesn't divide by zero).
    fn effective_resonance(&self, profile: &DamageProfile) -> f64 {
        let eff: f64 = (0..4).map(|i| profile.0[i] * self.resonance[i]).sum();
        eff.max(1e-9)
    }

    fn ehp(&self, profile: &DamageProfile) -> f64 {
        self.hp / self.effective_resonance(profile)
    }

    fn resists(&self) -> [f64; 4] {
        [
            1.0 - self.resonance[0],
            1.0 - self.resonance[1],
            1.0 - self.resonance[2],
            1.0 - self.resonance[3],
        ]
    }
}

/// Compute tank stats from the three layers, a damage profile, and local rep/s.
pub fn tank(
    shield: Layer,
    armor: Layer,
    hull: Layer,
    profile: &DamageProfile,
    shield_rep_s: f64,
    armor_rep_s: f64,
) -> TankStats {
    TankStats {
        shield_hp: shield.hp,
        armor_hp: armor.hp,
        hull_hp: hull.hp,
        ehp: shield.ehp(profile) + armor.ehp(profile) + hull.ehp(profile),
        shield_resists: shield.resists(),
        armor_resists: armor.resists(),
        hull_resists: hull.resists(),
        shield_rep_s,
        armor_rep_s,
        // Filled by the caller from the resolved hull (needs recharge time).
        passive_shield_s: 0.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ehp_with_no_resists_equals_raw_hp() {
        let layer = Layer {
            hp: 1000.0,
            resonance: [1.0; 4],
        };
        let t = tank(
            layer,
            Layer { hp: 0.0, resonance: [1.0; 4] },
            Layer { hp: 0.0, resonance: [1.0; 4] },
            &DamageProfile::default(),
            0.0,
            0.0,
        );
        assert!((t.ehp - 1000.0).abs() < 1e-9);
    }

    #[test]
    fn uniform_resist_scales_ehp_inversely() {
        // 50% resist across the board ⇒ resonance 0.5 ⇒ EHP = 2x raw.
        let layer = Layer {
            hp: 1000.0,
            resonance: [0.5; 4],
        };
        let t = tank(
            layer,
            Layer { hp: 0.0, resonance: [1.0; 4] },
            Layer { hp: 0.0, resonance: [1.0; 4] },
            &DamageProfile::default(),
            0.0,
            0.0,
        );
        assert!((t.ehp - 2000.0).abs() < 1e-6);
        assert!((t.shield_resists[0] - 0.5).abs() < 1e-9);
    }

    #[test]
    fn profile_weights_pick_the_weak_resonance() {
        // 0% em resist (res 1.0), 90% on the rest; an all-em profile sees raw HP.
        let layer = Layer {
            hp: 1000.0,
            resonance: [1.0, 0.1, 0.1, 0.1],
        };
        let em_only = DamageProfile([1.0, 0.0, 0.0, 0.0]);
        let t = tank(
            layer,
            Layer { hp: 0.0, resonance: [1.0; 4] },
            Layer { hp: 0.0, resonance: [1.0; 4] },
            &em_only,
            0.0,
            0.0,
        );
        assert!((t.ehp - 1000.0).abs() < 1e-6);
    }

    #[test]
    fn layers_and_reps_sum() {
        let t = tank(
            Layer { hp: 500.0, resonance: [1.0; 4] },
            Layer { hp: 450.0, resonance: [1.0; 4] },
            Layer { hp: 350.0, resonance: [1.0; 4] },
            &DamageProfile::default(),
            12.0,
            0.0,
        );
        assert!((t.ehp - 1300.0).abs() < 1e-9);
        assert_eq!(t.shield_rep_s, 12.0);
    }
}
