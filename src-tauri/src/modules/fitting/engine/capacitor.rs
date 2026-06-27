//! Capacitor peak-recharge stability (#172) — pure.
//!
//! EVE's capacitor recharges along `regen(x) = (10/τ)·Cmax·(√x − x)` where `x`
//! is the fill fraction and `τ` the recharge time (seconds). That peaks at
//! `x = 0.25` with `peak = 2.5·Cmax/τ` — the same constant PYFA/EFT use.
//!
//! A fit is cap-stable iff steady drain `D ≤ peak`; the stable fill fraction is
//! the lower root of `√x − x = D·τ/(10·Cmax)`. (Time-series simulation for
//! neut/boost scenarios is deferred to P3.)

use crate::modules::fitting::types::CapStats;

/// Compute capacitor stability from finalized attributes.
/// - `capacity` — `capacitorCapacity` (GJ)
/// - `recharge_ms` — `rechargeRate` (ms)
/// - `drain` — steady cap use (GJ/s) from active modules
pub fn capacitor(capacity: f64, recharge_ms: f64, drain: f64) -> CapStats {
    let tau = recharge_ms / 1000.0;
    let peak = if tau > 0.0 { 2.5 * capacity / tau } else { 0.0 };
    let stable = drain <= peak && tau > 0.0 && capacity > 0.0;
    let stable_pct = if stable {
        // √x − x = k has two roots; the capacitor settles at the *upper* (stable)
        // one: u = √x = (1 + √(1−4k)) / 2, so x = u². k=0 ⇒ full, k=0.25 ⇒ 25%.
        let k = drain * tau / (10.0 * capacity);
        let u = (1.0 + (1.0 - 4.0 * k).max(0.0).sqrt()) / 2.0;
        Some(u * u * 100.0)
    } else {
        None
    };
    // When unstable, integrate the cap equation from full to empty to get the
    // time-to-dry (a small time-series sim; the closed form is messy).
    let depletion_seconds = if !stable && capacity > 0.0 && tau > 0.0 && drain > 0.0 {
        Some(time_to_empty(capacity, tau, drain))
    } else {
        None
    };
    CapStats {
        capacity,
        recharge_seconds: tau,
        peak_recharge: peak,
        drain,
        stable,
        stable_pct,
        depletion_seconds,
    }
}

/// Seconds for the capacitor to fall from full to empty under constant `drain`
/// (GJ/s) that exceeds peak recharge. Integrates `dC/dt = regen(C) − drain` with
/// `regen(C) = (10/τ)·Cmax·(√(C/Cmax) − C/Cmax)`.
fn time_to_empty(capacity: f64, tau: f64, drain: f64) -> f64 {
    let dt = 0.25;
    let mut c = capacity;
    let mut t = 0.0;
    // Safety bound: if it somehow doesn't drain (shouldn't, drain > peak), bail.
    while c > 0.0 && t < 36_000.0 {
        let frac = (c / capacity).clamp(0.0, 1.0);
        let regen = (10.0 / tau) * capacity * (frac.sqrt() - frac);
        c += (regen - drain) * dt;
        t += dt;
    }
    t
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_drain_is_fully_stable() {
        let c = capacitor(250.0, 125_000.0, 0.0);
        assert!(c.stable);
        assert_eq!(c.stable_pct, Some(100.0)); // k=0 → x=1
        // Rifter peak: 2.5 * 250 / 125 = 5 GJ/s.
        assert!((c.peak_recharge - 5.0).abs() < 1e-9);
    }

    #[test]
    fn drain_above_peak_is_unstable() {
        let c = capacitor(250.0, 125_000.0, 6.0); // 6 > 5 peak
        assert!(!c.stable);
        assert_eq!(c.stable_pct, None);
    }

    #[test]
    fn unstable_reports_a_finite_depletion_time() {
        let c = capacitor(250.0, 125_000.0, 8.0); // well above the 5 peak
        assert!(!c.stable);
        let t = c.depletion_seconds.expect("unstable cap should report a time");
        assert!(t > 0.0 && t < 36_000.0, "depletion = {t}");
    }

    #[test]
    fn drain_at_peak_is_stable_at_25_percent() {
        // Exactly peak drain ⇒ equilibrium at the peak point, 25%.
        let c = capacitor(250.0, 125_000.0, 5.0);
        assert!(c.stable);
        let pct = c.stable_pct.unwrap();
        assert!((pct - 25.0).abs() < 1e-6, "stable% = {pct}");
    }

    #[test]
    fn partial_drain_settles_high() {
        // Light drain settles near full cap (high stable %).
        let c = capacitor(1000.0, 200_000.0, 2.0);
        let pct = c.stable_pct.unwrap();
        assert!(pct > 90.0 && pct < 100.0, "stable% = {pct}");
    }
}
