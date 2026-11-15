//! Hit-quality (application) factors for turrets and missiles (#701).
//!
//! All math is pure: no SDE, no async. The resolved stores supply the
//! weapon attributes; the target profile supplies the target.

/// Turret chance to hit (NOT a damage factor, see [`turret_damage_multiplier`]): falloff × tracking penalties folded into a single
/// `0.5^(falloff_term^2 + tracking_term^2)` factor.
/// - `optimal_m`, `falloff_m` — attrs 54 / 158 from the resolved module store.
/// - `tracking_speed` — attr 160 (rad/s).
/// - `sig_resolution` — attr 105 (m) — the turret’s own resolution (40m light, etc.).
/// - `angular_velocity` — from the target profile (rad/s), given directly
///   rather than derived from speed ÷ distance.
/// - `target_sig` — target signature radius (m), from the target profile.
/// - `distance` — range to target (m), for the falloff term only.
pub fn turret_chance_to_hit(
    optimal_m: f64,
    falloff_m: f64,
    tracking_speed: f64,
    sig_resolution: f64,
    angular_velocity: f64,
    target_sig: f64,
    distance: f64,
) -> f64 {
    let falloff_term = if falloff_m > 0.0 {
        ((distance - optimal_m).max(0.0) / falloff_m).max(0.0)
    } else if distance > optimal_m {
        return 0.0; // no falloff → outside optimal is zero
    } else {
        0.0
    };
    let tracking_term = if tracking_speed > 0.0 && target_sig > 0.0 {
        angular_velocity * (sig_resolution / (target_sig * tracking_speed))
    } else {
        0.0
    };
    (0.5f64).powf(falloff_term.powi(2) + tracking_term.powi(2))
}

/// Missile application (explosion radius/velocity model), pyfa
/// `_calcMissileFactor`: `min(1, S/E, (S·Ve / (E·Vt))^drf)`.
/// - `explosion_radius` — `aoeCloudSize` (654) on the loaded charge (m).
/// - `explosion_velocity` — `aoeVelocity` (653) on the loaded charge (m/s).
/// - `drf` — `aoeDamageReductionFactor` (1353) on the loaded charge. A value
///   `<= 0` skips the speed term (avoids `x^0`/NaN surprises).
/// - `target_sig` — target signature radius (m).
/// - `target_speed` — target speed (m/s); `<= 0` skips the speed term.
pub fn missile_application(
    explosion_radius: f64,
    explosion_velocity: f64,
    drf: f64,
    target_sig: f64,
    target_speed: f64,
) -> f64 {
    if explosion_radius <= 0.0 {
        return 1.0;
    }
    let size = target_sig / explosion_radius;
    let speed = if target_speed > 0.0 && drf > 0.0 {
        ((target_sig * explosion_velocity) / (explosion_radius * target_speed)).powf(drf)
    } else {
        1.0
    };
    1.0f64.min(size).min(speed).max(0.0)
}

/// Expected damage factor per shot for a turret/drone with the given chance
/// to hit (pyfa `_calcTurretMult`): 1% of shots are wrecking hits (3x damage),
/// the remaining hits average `(0.01 + cth) / 2 + 0.49` of paper damage.
/// Not equal to the chance to hit itself; reaches 1.015 at `cth = 1`.
/// Reference: <https://wiki.eveuniversity.org/Turret_mechanics#Damage>.
pub fn turret_damage_multiplier(cth: f64) -> f64 {
    let cth = cth.max(0.0);
    let wrecking_chance = cth.min(0.01);
    let wrecking = wrecking_chance * 3.0;
    let normal_chance = cth - wrecking_chance;
    let normal = if normal_chance > 0.0 {
        normal_chance * ((0.01 + cth) / 2.0 + 0.49)
    } else {
        0.0
    };
    normal + wrecking
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turret_full_application_at_optimal() {
        // At optimal range with zero tracking term: application should be 1.0.
        let app = turret_chance_to_hit(10_000.0, 5_000.0, 1.0, 40.0, 0.0, 40.0, 5_000.0);
        assert!(
            (app - 1.0).abs() < 1e-6,
            "expected 1.0 at optimal, got {app}"
        );
    }

    #[test]
    fn turret_half_at_one_falloff_beyond_optimal() {
        // At optimal + 1*falloff with zero tracking: 0.5^1 = 0.5.
        let app = turret_chance_to_hit(10_000.0, 5_000.0, 1.0, 40.0, 0.0, 40.0, 15_000.0);
        assert!((app - 0.5).abs() < 1e-6, "expected 0.5, got {app}");
    }

    #[test]
    fn turret_tracking_loss_from_angular_velocity_directly() {
        // At optimal (no falloff), tracking_speed=1.0 rad/s, sig_resolution=
        // target_sig=40 → tracking_term == angular_velocity exactly.
        let app = turret_chance_to_hit(10_000.0, 5_000.0, 1.0, 40.0, 0.02, 40.0, 10_000.0);
        let expected = 0.5f64.powf(0.02f64.powi(2));
        assert!(
            (app - expected).abs() < 1e-9,
            "expected {expected}, got {app}"
        );
    }

    #[test]
    fn missile_full_on_large_target() {
        // sig_radius >= explosion_radius, stationary → 1.0
        let app = missile_application(40.0, 1000.0, 0.682, 100.0, 0.0);
        assert!((app - 1.0).abs() < 1e-6);
    }

    #[test]
    fn missile_scourge_heavy_table() {
        // Scourge Heavy: E = 140, Ve = 85, drf = 0.682 (#1183).
        let cases = [
            (35.0, 0.0, 0.250),
            (35.0, 50.0, 0.250),
            (35.0, 200.0, 0.217),
            (35.0, 400.0, 0.135),
            (120.0, 60.0, 0.857),
            (120.0, 200.0, 0.502),
        ];
        for (sig, speed, expected) in cases {
            let app = missile_application(140.0, 85.0, 0.682, sig, speed);
            assert!(
                (app - expected).abs() < 1e-3,
                "sig {sig} speed {speed}: expected {expected}, got {app}"
            );
        }
    }

    #[test]
    fn missile_faster_explosion_never_full_on_small_target() {
        // Ve > Vt with S < E: the old formula returned 1.0.
        for speed in [10.0, 40.0, 60.0, 84.0] {
            let app = missile_application(140.0, 85.0, 0.682, 120.0, speed);
            assert!(app < 1.0, "speed {speed}: got {app}");
        }
    }

    #[test]
    fn missile_zero_drf_skips_speed_term() {
        let app = missile_application(140.0, 85.0, 0.0, 35.0, 200.0);
        assert!((app - 0.25).abs() < 1e-9, "got {app}");
    }

    #[test]
    fn turret_multiplier_table() {
        // #1267 table.
        let cases = [
            (1.0, 1.015),
            (0.9, 0.871),
            (0.75, 0.674),
            (0.5, 0.395),
            (0.25, 0.179),
            (0.1, 0.079),
        ];
        for (cth, expected) in cases {
            let m = turret_damage_multiplier(cth);
            assert!(
                (m - expected).abs() < 1e-3,
                "cth {cth}: expected {expected}, got {m}"
            );
        }
        assert_eq!(turret_damage_multiplier(0.0), 0.0);
        // Below the wrecking threshold everything is a 3x wrecking hit.
        assert!((turret_damage_multiplier(0.004) - 0.012).abs() < 1e-12);
    }
}
