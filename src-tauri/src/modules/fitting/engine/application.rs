//! Hit-quality (application) factors for turrets and missiles (#701).
//!
//! All math is pure: no SDE, no async. The resolved stores supply the
//! weapon attributes; the target profile supplies the target.

/// Turret application: falloff × tracking penalties folded into a single
/// `0.5^(falloff_term^2 + tracking_term^2)` factor.
/// - `optimal_m`, `falloff_m` — attrs 54 / 158 from the resolved module store.
/// - `tracking_speed` — attr 160 (rad/s).
/// - `sig_resolution` — attr 105 (m) — the turret’s own resolution (40m light, etc.).
/// - `target_speed`, `target_sig` — from the target profile (m/s, m).
/// - `distance` — range to target (m).
pub fn turret_application(
    optimal_m: f64,
    falloff_m: f64,
    tracking_speed: f64,
    sig_resolution: f64,
    target_speed: f64,
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
    let tracking_term = if distance > 0.0 && tracking_speed > 0.0 && target_sig > 0.0 {
        (target_speed / distance) * (sig_resolution / (target_sig * tracking_speed))
    } else {
        0.0
    };
    (0.5f64).powf(falloff_term.powi(2) + tracking_term.powi(2))
}

/// Missile application (explosion radius/velocity model).
/// - `explosion_radius` — attr 103 on the loaded charge (m).
/// - `explosion_velocity` — attr 104 on the loaded charge (m/s).
/// - `target_sig` — target signature radius (m).
/// - `target_speed` — target speed (m/s).
pub fn missile_application(
    explosion_radius: f64,
    explosion_velocity: f64,
    target_sig: f64,
    target_speed: f64,
) -> f64 {
    if explosion_radius <= 0.0 {
        return 1.0;
    }
    let r = target_sig / explosion_radius;
    if r >= 1.0 {
        return 1.0;
    }
    if explosion_velocity <= 0.0 || target_speed <= 0.0 {
        return r; // r^1 = r (base formula without velocity term)
    }
    let v = explosion_velocity / target_speed;
    if v <= 1.0 {
        return r; // target moves faster than explosion velocity: r^1
    }
    let exponent = (r.ln() / v.ln()).max(0.0);
    r.powf(exponent).clamp(0.0, 1.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turret_full_application_at_optimal() {
        // At optimal range with zero tracking term: application should be 1.0.
        let app = turret_application(10_000.0, 5_000.0, 1.0, 40.0, 0.0, 40.0, 5_000.0);
        assert!((app - 1.0).abs() < 1e-6, "expected 1.0 at optimal, got {app}");
    }

    #[test]
    fn turret_half_at_one_falloff_beyond_optimal() {
        // At optimal + 1*falloff with zero tracking: 0.5^1 = 0.5.
        let app = turret_application(10_000.0, 5_000.0, 1.0, 40.0, 0.0, 40.0, 15_000.0);
        assert!((app - 0.5).abs() < 1e-6, "expected 0.5, got {app}");
    }

    #[test]
    fn missile_full_on_large_target() {
        // sig_radius >= explosion_radius → 1.0
        let app = missile_application(40.0, 1000.0, 100.0, 200.0);
        assert!((app - 1.0).abs() < 1e-6);
    }

    #[test]
    fn missile_partial_on_small_fast_target() {
        // sig_radius < explosion_radius and the target outruns the explosion
        // (explosion_velocity < target_speed, v <= 1) → partial, r^1 = r.
        let app = missile_application(100.0, 200.0, 30.0, 300.0);
        assert!((app - 0.3).abs() < 1e-9, "expected r=0.3, got {app}");
    }
}
