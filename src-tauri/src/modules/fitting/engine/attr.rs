//! Per-item attribute store with bucketed modifiers + deterministic finalize
//! (#170).
//!
//! Each item gets an [`AttrStore`]: base attribute values plus accumulated
//! modifier buckets. Modifiers are only *added* during the resolution passes;
//! [`AttrStore::get`] collapses the buckets on read in the fixed EVE order
//! (preAssign → pre-multiply → add → post-multiply (stacking) → postAssign), so
//! the engine is a pure function of its inputs.

use std::collections::HashMap;

use super::modifier::Op;
use super::stacking::combine_penalized;

/// Named dogma attribute ids used across the engine (verified against the SDE).
/// Centralised so the stat calculators (#173–#175) read `attr::CPU_OUTPUT`, not
/// magic numbers.
#[allow(dead_code)] // ids land here as the tank/damage/nav calculators consume them
pub mod attr {
    pub const MASS: i64 = 4;
    pub const POWER_OUTPUT: i64 = 11;
    pub const LOW_SLOTS: i64 = 12;
    pub const MED_SLOTS: i64 = 13;
    pub const HI_SLOTS: i64 = 14;
    pub const POWER_USAGE: i64 = 30;
    pub const MAX_VELOCITY: i64 = 37;
    pub const CPU_OUTPUT: i64 = 48;
    pub const CPU_USAGE: i64 = 50;
    pub const RATE_OF_FIRE: i64 = 51;
    pub const RECHARGE_RATE: i64 = 55;
    pub const DAMAGE_MULTIPLIER: i64 = 64;
    pub const AGILITY: i64 = 70;
    pub const LAUNCHER_HARDPOINTS: i64 = 101;
    pub const TURRET_HARDPOINTS: i64 = 102;
    pub const EM_DAMAGE: i64 = 114;
    pub const EXPLOSIVE_DAMAGE: i64 = 116;
    pub const KINETIC_DAMAGE: i64 = 117;
    pub const THERMAL_DAMAGE: i64 = 118;
    pub const SHIELD_CAPACITY: i64 = 263;
    pub const DRONE_CAPACITY: i64 = 283;
    pub const CAPACITOR_CAPACITY: i64 = 482;
    pub const CALIBRATION: i64 = 1132;
    pub const CALIBRATION_COST: i64 = 1153;
    pub const RIG_SLOTS: i64 = 1137;
    pub const DRONE_BANDWIDTH: i64 = 1271;
    pub const SUBSYSTEM_SLOTS: i64 = 1367;
}

/// A single attribute's base value plus accumulating modifier buckets.
#[derive(Debug, Clone, Default)]
struct Value {
    base: f64,
    pre_assign: Option<f64>,
    /// preMul factors (preDiv stored as 1/x).
    pre_factors: Vec<f64>,
    /// modAdd amounts (modSub stored as -x).
    add: Vec<f64>,
    /// post-multiplicative factors with their penalized flag (postPercent stored
    /// as 1 + p/100, postDiv as 1/x).
    post: Vec<(f64, bool)>,
    post_assign: Option<f64>,
}

impl Value {
    fn finalize(&self) -> f64 {
        let mut v = self.pre_assign.unwrap_or(self.base);
        for f in &self.pre_factors {
            v *= f;
        }
        for a in &self.add {
            v += a;
        }
        // Unpenalized factors multiply in fully; penalized ones stack-penalize.
        let mut unpenalized = 1.0;
        let mut penalized = Vec::new();
        for &(f, p) in &self.post {
            if p {
                penalized.push(f);
            } else {
                unpenalized *= f;
            }
        }
        v *= unpenalized;
        v *= combine_penalized(&penalized);
        if let Some(pa) = self.post_assign {
            v = pa;
        }
        v
    }
}

/// Per-item attribute store: base values + accumulated modifier buckets,
/// collapsed on read by [`AttrStore::get`].
#[derive(Debug, Clone, Default)]
pub struct AttrStore {
    values: HashMap<i64, Value>,
}

impl AttrStore {
    pub fn new() -> Self {
        Self::default()
    }

    /// Seed base attribute values (e.g. from the SDE's `type_attributes_raw`).
    pub fn seed(&mut self, attrs: &[(i64, f64)]) {
        for &(id, v) in attrs {
            self.values.entry(id).or_default().base = v;
        }
    }

    /// Set a single base attribute value.
    #[allow(dead_code)] // used in tests + by calculators that inject derived bases (#173+)
    pub fn set_base(&mut self, attr: i64, value: f64) {
        self.values.entry(attr).or_default().base = value;
    }

    /// Apply a modifier to an attribute, routed into the right bucket by `op`.
    /// `value` is the magnitude read from the affecting item; `penalized` marks
    /// it for the stacking penalty (multiplicative ops only).
    pub fn apply(&mut self, attr: i64, op: Op, value: f64, penalized: bool) {
        let slot = self.values.entry(attr).or_default();
        match op {
            Op::PreAssign => slot.pre_assign = Some(value),
            Op::PreMul => slot.pre_factors.push(value),
            Op::PreDiv => {
                if value != 0.0 {
                    slot.pre_factors.push(1.0 / value);
                }
            }
            Op::ModAdd => slot.add.push(value),
            Op::ModSub => slot.add.push(-value),
            Op::PostMul => slot.post.push((value, penalized)),
            Op::PostDiv => {
                if value != 0.0 {
                    slot.post.push((1.0 / value, penalized));
                }
            }
            Op::PostPercent => slot.post.push((1.0 + value / 100.0, penalized)),
            Op::PostAssign => slot.post_assign = Some(value),
        }
    }

    /// The finalized value of an attribute (0.0 if unknown).
    pub fn get(&self, attr: i64) -> f64 {
        self.values.get(&attr).map(Value::finalize).unwrap_or(0.0)
    }

    /// The unmodified base value (0.0 if unknown).
    #[allow(dead_code)] // calculators that need pre-modifier values (#173+)
    pub fn base(&self, attr: i64) -> f64 {
        self.values.get(&attr).map(|v| v.base).unwrap_or(0.0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_and_get_return_base_when_unmodified() {
        let mut s = AttrStore::new();
        s.seed(&[(attr::CPU_OUTPUT, 130.0), (attr::POWER_OUTPUT, 41.0)]);
        assert_eq!(s.get(attr::CPU_OUTPUT), 130.0);
        assert_eq!(s.get(attr::POWER_OUTPUT), 41.0);
        assert_eq!(s.get(999), 0.0); // unknown
    }

    #[test]
    fn finalize_applies_add_before_post_percent() {
        let mut s = AttrStore::new();
        s.set_base(100, 100.0);
        s.apply(100, Op::ModAdd, 50.0, false); // 100 + 50 = 150
        s.apply(100, Op::PostPercent, 10.0, false); // 150 * 1.10 = 165
        assert!((s.get(100) - 165.0).abs() < 1e-9);
    }

    #[test]
    fn penalized_post_mul_stacks() {
        let mut s = AttrStore::new();
        s.set_base(64, 10.0);
        s.apply(64, Op::PostMul, 1.5, true);
        s.apply(64, Op::PostMul, 1.5, true);
        // 10 * combine([1.5, 1.5]) = 10 * 1.5 * (1 + 0.5*penalty(1)).
        let want = 10.0 * combine_penalized(&[1.5, 1.5]);
        assert!((s.get(64) - want).abs() < 1e-9);
        // Unpenalized identical factors would multiply fully (no attenuation).
        let mut u = AttrStore::new();
        u.set_base(64, 10.0);
        u.apply(64, Op::PostMul, 1.5, false);
        u.apply(64, Op::PostMul, 1.5, false);
        assert!((u.get(64) - 22.5).abs() < 1e-9);
    }

    #[test]
    fn pre_assign_replaces_base_and_post_assign_overrides_all() {
        let mut s = AttrStore::new();
        s.set_base(5, 100.0);
        s.apply(5, Op::PreAssign, 200.0, false); // start from 200
        s.apply(5, Op::ModAdd, 10.0, false); // 210
        assert!((s.get(5) - 210.0).abs() < 1e-9);
        s.apply(5, Op::PostAssign, 7.0, false); // overrides to 7
        assert_eq!(s.get(5), 7.0);
    }

    #[test]
    fn post_div_and_post_percent_convert_correctly() {
        let mut s = AttrStore::new();
        s.set_base(51, 4.0);
        s.apply(51, Op::PostDiv, 2.0, false); // 4 / 2 = 2
        assert!((s.get(51) - 2.0).abs() < 1e-9);
    }
}
