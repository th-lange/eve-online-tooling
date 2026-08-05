//! Navigation + targeting (#175) — pure.
//!
//! Reads finalized attributes, so propulsion modules, nanofibers/inertial
//! stabilizers and skills are already applied. Align time uses the standard EVE
//! formula `t = −ln(0.25) · mass · agility / 1e6` (time to reach 75% velocity,
//! the warp threshold).

use crate::modules::fitting::engine::stacking;
use crate::modules::fitting::types::{NavStats, TargetStats};

/// `−ln(0.25)` — the align-time constant.
const ALIGN_K: f64 = 1.386_294_361_119_890_6;

/// Afterburner/MWD velocity boost (#178). Each prop module multiplies max
/// velocity by `1 + speedFactor·speedBoostFactor/mass` (a procedural effect, not
/// in `modifierInfo`); `speedFactor` is read finalized so Acceleration Control
/// etc. count. Multiple prop mods are stacking-penalized. `props` is each prop
/// module's `(speedFactor (20), speedBoostFactor (567))`.
pub fn prop_velocity(base_velocity: f64, mass: f64, props: &[(f64, f64)]) -> f64 {
    if mass <= 0.0 {
        return base_velocity;
    }
    let mut bonuses: Vec<f64> = props
        .iter()
        .filter(|(sf, sbf)| *sf != 0.0 && *sbf != 0.0)
        .map(|(sf, sbf)| sf * sbf / mass / 100.0)
        .collect();
    if bonuses.is_empty() {
        return base_velocity;
    }
    // Stacking penalty across multiple prop mods (strongest first, full weight).
    bonuses.sort_by(|a, b| b.abs().partial_cmp(&a.abs()).unwrap());
    let total: f64 = bonuses
        .iter()
        .enumerate()
        .map(|(i, b)| b * stacking::penalty(i))
        .sum();
    base_velocity * (1.0 + total)
}

/// Navigation stats from finalized attributes.
pub fn navigation(max_velocity: f64, mass: f64, agility: f64, signature_radius: f64) -> NavStats {
    let align_time = if mass > 0.0 && agility > 0.0 {
        ALIGN_K * mass * agility / 1_000_000.0
    } else {
        0.0
    };
    NavStats {
        max_velocity,
        align_time,
        agility,
        signature_radius,
    }
}

/// Targeting stats from finalized attributes. `sensor_strength` is
/// `[radar, ladar, magnetometric, gravimetric]`.
pub fn targeting(
    max_targets: f64,
    lock_range: f64,
    scan_resolution: f64,
    sensor_strength: [f64; 4],
) -> TargetStats {
    TargetStats {
        max_targets: max_targets as i64,
        lock_range,
        scan_resolution,
        sensor_strength,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prop_velocity_boosts_by_speed_factor_over_mass() {
        // 1MN AB II on an all-V Rifter: speedFactor 168.75 (135 × Accel Control V),
        // speedBoostFactor 1.5e6, mass 1.567e6 (hull + AB) → +161.5% → ~1193.
        let v = prop_velocity(456.25, 1_567_000.0, &[(168.75, 1_500_000.0)]);
        assert!((v - 1193.2).abs() < 1.0, "velocity = {v}, want ~1193");
    }

    #[test]
    fn prop_velocity_no_prop_is_unchanged() {
        assert_eq!(prop_velocity(456.25, 1_067_000.0, &[]), 456.25);
        // A non-prop module (zero factors) contributes nothing.
        assert_eq!(prop_velocity(456.25, 1_067_000.0, &[(0.0, 0.0)]), 456.25);
    }

    #[test]
    fn align_time_uses_mass_and_agility() {
        // t = 1.38629 * 1_000_000 * 3.0 / 1e6 = 4.159 s.
        let n = navigation(300.0, 1_000_000.0, 3.0, 35.0);
        assert!(
            (n.align_time - 4.1589).abs() < 1e-3,
            "align = {}",
            n.align_time
        );
        assert_eq!(n.max_velocity, 300.0);
    }

    #[test]
    fn zero_mass_yields_zero_align() {
        let n = navigation(300.0, 0.0, 3.0, 35.0);
        assert_eq!(n.align_time, 0.0);
    }

    #[test]
    fn targeting_passes_through_and_floors_targets() {
        let t = targeting(7.9, 60_000.0, 200.0, [12.0, 0.0, 0.0, 0.0]);
        assert_eq!(t.max_targets, 7);
        assert_eq!(t.lock_range, 60_000.0);
        assert_eq!(t.sensor_strength[0], 12.0);
    }
}
