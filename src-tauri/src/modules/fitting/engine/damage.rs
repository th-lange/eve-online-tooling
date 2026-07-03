//! Damage: turret / missile / drone DPS (#174) — pure.
//!
//! Each weapon's DPS is `damage_mult × damage_per_shot × count / rof_seconds`.
//! Turrets read a *finalized* `damageMultiplier` (64) and rate of fire (`speed`,
//! 51) — so gun mods, ship bonuses and gunnery skills are already folded in —
//! and the loaded charge supplies the base damage split. Missiles have no
//! turret multiplier (their damage rides on the charge); drones carry their own
//! multiplier + damage. Hit quality (tracking/falloff, explosion radius) is a
//! later refinement; this is full-application DPS.

use crate::modules::fitting::types::DpsBreakdown;

/// One weapon group reduced to its DPS inputs.
#[derive(Debug, Clone, Copy)]
pub struct Weapon {
    pub damage_mult: f64,
    /// Summed base damage of one shot (the four damage types).
    pub damage_per_shot: f64,
    pub rof_seconds: f64,
    pub count: i32,
}

impl Weapon {
    fn dps(&self) -> f64 {
        if self.rof_seconds > 0.0 && self.count > 0 {
            self.damage_mult * self.damage_per_shot * self.count as f64 / self.rof_seconds
        } else {
            0.0
        }
    }
}

fn sum_dps(weapons: &[Weapon]) -> f64 {
    weapons.iter().map(Weapon::dps).sum()
}

/// Aggregate turret/missile/drone DPS into a breakdown.
pub fn damage(turrets: &[Weapon], missiles: &[Weapon], drones: &[Weapon]) -> DpsBreakdown {
    let turret = sum_dps(turrets);
    let missile = sum_dps(missiles);
    let drone = sum_dps(drones);
    DpsBreakdown {
        turret,
        missile,
        drone,
        total: turret + missile + drone,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turret_dps_matches_hand_calc() {
        // 200mm AC II + Barrage S at base: 3.465 × 11 / 3.75 = 10.164 dps.
        let gun = Weapon {
            damage_mult: 3.465,
            damage_per_shot: 11.0,
            rof_seconds: 3.75,
            count: 1,
        };
        let d = damage(&[gun], &[], &[]);
        assert!((d.turret - 10.164).abs() < 1e-3, "turret = {}", d.turret);
        assert!((d.total - d.turret).abs() < 1e-9);
    }

    #[test]
    fn drone_dps_and_count_scale() {
        // Hobgoblin II base: 1.92 × 20 / 4.0 = 9.6 each; ×5 = 48.
        let drone = Weapon {
            damage_mult: 1.92,
            damage_per_shot: 20.0,
            rof_seconds: 4.0,
            count: 5,
        };
        let d = damage(&[], &[], &[drone]);
        assert!((d.drone - 48.0).abs() < 1e-6, "drone = {}", d.drone);
    }

    #[test]
    fn missile_has_no_multiplier() {
        // Missile damage rides on the charge: 30 dmg / 5 s = 6 dps.
        let m = Weapon {
            damage_mult: 1.0,
            damage_per_shot: 30.0,
            rof_seconds: 5.0,
            count: 1,
        };
        let d = damage(&[], &[m], &[]);
        assert!((d.missile - 6.0).abs() < 1e-9);
    }

    #[test]
    fn zero_rof_or_count_is_zero() {
        let bad = Weapon {
            damage_mult: 5.0,
            damage_per_shot: 10.0,
            rof_seconds: 0.0,
            count: 1,
        };
        assert_eq!(damage(&[bad], &[], &[]).total, 0.0);
    }
}
