//! Projected effects (#178) — webs/paints/damps/… applied **onto** the fit.
//!
//! These are procedural effects: their application isn't in `modifierInfo`, so
//! each projected module reads a known attribute and post-percent modifies a
//! target-ship attribute (stacking-penalized across modules). Modelled at all-V
//! (no source-ship bonuses), matching a bare projected module in PYFA.

use super::attr::{attr, AttrStore};
use super::modifier::Op;

/// Named attribute ids the projected effects read/write.
const SPEED_FACTOR: i64 = 20; // stasis web: % to target maxVelocity
const SIG_RADIUS_BONUS: i64 = 554; // target painter: % to target signatureRadius
const SIGNATURE_RADIUS: i64 = 552;

/// One projected module reduced to the attributes its effect reads.
#[derive(Debug, Clone, Default)]
pub struct ProjectedInput {
    /// `speedFactor` (20) — stasis web: % change to target max velocity (negative).
    pub speed_factor: f64,
    /// `signatureRadiusBonus` (554) — target painter: % change to sig radius.
    pub sig_radius_bonus: f64,
}

/// Apply projected modules' effects to the target ship's store. Each effect is a
/// stacking-penalized post-percent on a ship attribute.
pub fn apply_projection(ship: &mut AttrStore, projected: &[ProjectedInput]) {
    for p in projected {
        if p.speed_factor != 0.0 {
            ship.apply(attr::MAX_VELOCITY, Op::PostPercent, p.speed_factor, true);
        }
        if p.sig_radius_bonus != 0.0 {
            ship.apply(SIGNATURE_RADIUS, Op::PostPercent, p.sig_radius_bonus, true);
        }
    }
}

/// Build a [`ProjectedInput`] from a type's raw attributes.
pub fn projected_from_attrs(get: impl Fn(i64) -> f64) -> ProjectedInput {
    ProjectedInput {
        speed_factor: get(SPEED_FACTOR),
        sig_radius_bonus: get(SIG_RADIUS_BONUS),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn web_reduces_velocity_painter_grows_sig() {
        let mut ship = AttrStore::new();
        ship.seed(&[(attr::MAX_VELOCITY, 456.25), (SIGNATURE_RADIUS, 35.0)]);
        apply_projection(
            &mut ship,
            &[
                ProjectedInput { speed_factor: -60.0, ..Default::default() },
                ProjectedInput { sig_radius_bonus: 30.0, ..Default::default() },
            ],
        );
        // -60% velocity, +30% sig.
        assert!((ship.get(attr::MAX_VELOCITY) - 182.5).abs() < 1e-6);
        assert!((ship.get(SIGNATURE_RADIUS) - 45.5).abs() < 1e-6);
    }

    #[test]
    fn no_projection_is_a_no_op() {
        let mut ship = AttrStore::new();
        ship.seed(&[(attr::MAX_VELOCITY, 456.25)]);
        apply_projection(&mut ship, &[ProjectedInput::default()]);
        assert_eq!(ship.get(attr::MAX_VELOCITY), 456.25);
    }
}
