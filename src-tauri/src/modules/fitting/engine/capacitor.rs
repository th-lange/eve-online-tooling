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
/// - `drain` — steady cap use (GJ/s) from active modules (for stability/stable%)
/// - `module_drains` — per-module `(capNeed GJ, cycle_ms)` for the discrete
///   depletion sim when unstable
pub fn capacitor(
    capacity: f64,
    recharge_ms: f64,
    drain: f64,
    module_drains: &[(f64, f64)],
) -> CapStats {
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
    // When unstable, run the discrete-activation sim (matching PYFA's capSim) to
    // the time the capacitor first goes negative.
    let depletion_seconds = if !stable && capacity > 0.0 && recharge_ms > 0.0 {
        Some(time_to_empty(capacity, recharge_ms, module_drains))
    } else {
        None
    };
    // Sampled cap-over-time curve for the UI: long enough to see a stable fit
    // settle, or to watch an unstable one decline to empty.
    let horizon = if stable {
        (tau * 3.0).clamp(60.0, 600.0)
    } else {
        depletion_seconds.unwrap_or(0.0).clamp(1.0, 600.0)
    };
    let trajectory = cap_trajectory(capacity, recharge_ms, drain, horizon);

    CapStats {
        capacity,
        recharge_seconds: tau,
        peak_recharge: peak,
        drain,
        stable,
        stable_pct,
        depletion_seconds,
        trajectory,
    }
}

/// Sample the capacitor fill curve from full over `horizon_s`, returning
/// `(seconds, percent)` points. Integrates EVE's recharge ODE
/// `dx/dt = (10/τ)·(√x − x) − D/Cmax` (x = fill fraction) against a steady drain,
/// so the curve settles at the stable level or declines to empty. Illustrative —
/// the precise depletion time comes from the discrete sim above.
fn cap_trajectory(capacity: f64, recharge_ms: f64, drain: f64, horizon_s: f64) -> Vec<(f64, f64)> {
    let tau = recharge_ms / 1000.0;
    if tau <= 0.0 || capacity <= 0.0 || horizon_s <= 0.0 {
        return Vec::new();
    }
    const POINTS: usize = 120;
    const SUBSTEPS: usize = 8; // per-point integration substeps for accuracy
    let dt = horizon_s / POINTS as f64;
    let h = dt / SUBSTEPS as f64;
    let mut x = 1.0_f64;
    let mut out = Vec::with_capacity(POINTS + 1);
    out.push((0.0, 100.0));
    for i in 1..=POINTS {
        for _ in 0..SUBSTEPS {
            let dx = (10.0 / tau) * (x.max(0.0).sqrt() - x) - drain / capacity;
            x = (x + dx * h).clamp(0.0, 1.0);
        }
        out.push((i as f64 * dt, x * 100.0));
    }
    out
}

/// Seconds until the capacitor first goes negative, simulating discrete module
/// activations: each module consumes `capNeed` at its cycle start, with the exact
/// analytical recharge between events, until an activation drives cap below zero
/// (the same stop condition PYFA's capSim uses). `drains` = `(capNeed, cycle_ms)`.
fn time_to_empty(capacity: f64, recharge_ms: f64, drains: &[(f64, f64)]) -> f64 {
    let tau = recharge_ms / 5.0; // PYFA: recharge / 5, in ms
                                 // Per-module next-activation time (ms), starting at 0.
    let mut events: Vec<(f64, f64, f64)> = drains
        .iter()
        .filter(|(need, cyc)| *need > 0.0 && *cyc > 0.0)
        .map(|(need, cyc)| (0.0_f64, *need, *cyc))
        .collect();
    if events.is_empty() {
        return 0.0;
    }
    let cap_max = capacity;
    let mut cap = capacity;
    let mut t_last = 0.0;
    loop {
        // Earliest pending activation.
        let i = (0..events.len())
            .min_by(|&a, &b| events[a].0.partial_cmp(&events[b].0).unwrap())
            .unwrap();
        let (t_now, need, cyc) = events[i];
        if t_now > 6.0 * 3600.0 * 1000.0 {
            return t_last / 1000.0; // stable enough; bail
        }
        if t_now > t_last {
            let frac = (cap / cap_max).max(0.0).sqrt();
            cap = (1.0 + (frac - 1.0) * ((t_last - t_now) / tau).exp()).powi(2) * cap_max;
        }
        t_last = t_now;
        cap -= need;
        if cap < 0.0 {
            return t_now / 1000.0;
        }
        if cap > cap_max {
            cap = cap_max;
        }
        events[i].0 = t_now + cyc;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn no_drain_is_fully_stable() {
        let c = capacitor(250.0, 125_000.0, 0.0, &[]);
        assert!(c.stable);
        assert_eq!(c.stable_pct, Some(100.0)); // k=0 → x=1
                                               // Rifter peak: 2.5 * 250 / 125 = 5 GJ/s.
        assert!((c.peak_recharge - 5.0).abs() < 1e-9);
    }

    #[test]
    fn drain_above_peak_is_unstable() {
        let c = capacitor(250.0, 125_000.0, 6.0, &[(6.0, 1000.0)]); // 6 > 5 peak
        assert!(!c.stable);
        assert_eq!(c.stable_pct, None);
    }

    #[test]
    fn unstable_reports_a_finite_depletion_time() {
        // 8 GJ/s drain via a 1 s, 8 GJ module — well above the 5 peak.
        let c = capacitor(250.0, 125_000.0, 8.0, &[(8.0, 1000.0)]);
        assert!(!c.stable);
        let t = c
            .depletion_seconds
            .expect("unstable cap should report a time");
        assert!(t > 0.0 && t < 36_000.0, "depletion = {t}");
    }

    #[test]
    fn drain_at_peak_is_stable_at_25_percent() {
        // Exactly peak drain ⇒ equilibrium at the peak point, 25%.
        let c = capacitor(250.0, 125_000.0, 5.0, &[]);
        assert!(c.stable);
        let pct = c.stable_pct.unwrap();
        assert!((pct - 25.0).abs() < 1e-6, "stable% = {pct}");
    }

    #[test]
    fn partial_drain_settles_high() {
        // Light drain settles near full cap (high stable %).
        let c = capacitor(1000.0, 200_000.0, 2.0, &[]);
        let pct = c.stable_pct.unwrap();
        assert!(pct > 90.0 && pct < 100.0, "stable% = {pct}");
    }

    #[test]
    fn trajectory_starts_full_and_settles_at_stable_level() {
        let c = capacitor(1000.0, 200_000.0, 2.0, &[]);
        assert_eq!(c.trajectory.first().unwrap().1, 100.0); // starts full
        let end = c.trajectory.last().unwrap().1;
        let stable = c.stable_pct.unwrap();
        // The curve converges toward the analytic stable level.
        assert!((end - stable).abs() < 1.0, "end {end} vs stable {stable}");
    }

    #[test]
    fn trajectory_declines_toward_empty_when_unstable() {
        let c = capacitor(250.0, 125_000.0, 8.0, &[(8.0, 1000.0)]);
        let end = c.trajectory.last().unwrap().1;
        assert!(end < 20.0, "unstable cap should be near empty, got {end}%");
    }
}
