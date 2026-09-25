//! Capacitor peak-recharge stability (#172) — pure.
//!
//! EVE's capacitor recharges along `regen(x) = (10/τ)·Cmax·(√x − x)` where `x`
//! is the fill fraction and `τ` the recharge time (seconds). That peaks at
//! `x = 0.25` with `peak = 2.5·Cmax/τ` — the same constant PYFA/EFT use.
//!
//! A fit is cap-stable iff steady drain `D ≤ peak`; the stable fill fraction is
//! the lower root of `√x − x = D·τ/(10·Cmax)`. That analytic test only models
//! *continuous* draw, though — it has no notion of a discrete GJ injection, so
//! a fitted cap booster or ASB (#875) instead gets the Pyfa-style verdict in
//! [`injected_stability`]: simulate the discrete event sim over one full
//! LCM period twice and check the trend.

use crate::modules::fitting::types::CapStats;

/// One cap-drawing module's discrete-sim inputs (#871): `need` (GJ) drawn
/// every `cycle_ms`, plus its own reload cycle (`engine::cycle::ReloadCycle`)
/// — `clip_shots` activations before a `reload_ms` pause with **no** cap draw
/// at all. `clip_shots`/`reload_ms` are `0.0` when the module never reloads,
/// or reload factoring is off: the sim then behaves exactly as it did before
/// #871 (draws every `cycle_ms`, forever).
///
/// Also doubles as a cap **injection** (#875): a fitted cap booster (or an
/// Ancillary Shield Booster, if a cap-booster charge were ever loaded to
/// draw straight from GJ rather than repair shield) feeds its charge's
/// `capacitorBonus` GJ into the capacitor every `cycle_ms`, for `clip_shots`
/// shots before the same `reload_ms` pause — identical shape, opposite sign.
/// [`capacitor`]'s `injections` parameter takes the very same struct.
#[derive(Debug, Clone, Copy, Default)]
pub struct ModuleDrain {
    pub need: f64,
    pub cycle_ms: f64,
    pub clip_shots: f64,
    pub reload_ms: f64,
}

/// Compute capacitor stability from finalized attributes.
/// - `capacity` — `capacitorCapacity` (GJ)
/// - `recharge_ms` — `rechargeRate` (ms)
/// - `drain` — steady cap use (GJ/s) from active modules (for stability/stable%);
///   the caller derates this by each module's own reload sustained-factor
///   when reload accounting is on (#871), so a reloading module contributes
///   less to the *average* steady drain even though its discrete pulses
///   (below) are still full-size.
/// - `module_drains` — per-module discrete depletion-sim inputs (used only
///   when unstable)
/// - `neut_gjs` — continuous steady drain (GJ/s) from projected neuts (#706),
///   added on top of `drain` everywhere the steady component is used
/// - `injections` — per-booster discrete cap-injection inputs (#875): when
///   nonempty, the analytic peak-vs-drain test is replaced by
///   [`injected_stability`]'s discrete period-trend verdict, since a
///   continuous-drain formula can't represent a discrete GJ injection.
///   Fits with no injectors (`&[]`) are numerically identical to before #875.
pub fn capacitor(
    capacity: f64,
    recharge_ms: f64,
    drain: f64,
    module_drains: &[ModuleDrain],
    neut_gjs: f64,
    injections: &[ModuleDrain],
) -> CapStats {
    let total_drain = drain + neut_gjs;
    let tau = recharge_ms / 1000.0;
    let peak = if tau > 0.0 { 2.5 * capacity / tau } else { 0.0 };

    let (stable, stable_pct, depletion_seconds, trajectory) = if injections.is_empty() {
        let stable = total_drain <= peak && tau > 0.0 && capacity > 0.0;
        let stable_pct = if stable {
            // √x − x = k has two roots; the capacitor settles at the *upper* (stable)
            // one: u = √x = (1 + √(1−4k)) / 2, so x = u². k=0 ⇒ full, k=0.25 ⇒ 25%.
            let k = total_drain * tau / (10.0 * capacity);
            let u = (1.0 + (1.0 - 4.0 * k).max(0.0).sqrt()) / 2.0;
            Some(u * u * 100.0)
        } else {
            None
        };
        // When unstable, run the discrete-activation sim (matching PYFA's capSim) to
        // the time the capacitor first goes negative.
        let depletion_seconds = if !stable && capacity > 0.0 && recharge_ms > 0.0 {
            Some(time_to_empty(
                capacity,
                recharge_ms,
                module_drains,
                neut_gjs,
                &[],
            ))
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
        let trajectory = cap_trajectory(capacity, recharge_ms, total_drain, horizon);
        (stable, stable_pct, depletion_seconds, trajectory)
    } else {
        let verdict =
            injected_stability(capacity, recharge_ms, module_drains, neut_gjs, injections);
        let depletion_seconds = if !verdict.stable && capacity > 0.0 && recharge_ms > 0.0 {
            Some(time_to_empty(
                capacity,
                recharge_ms,
                module_drains,
                neut_gjs,
                injections,
            ))
        } else {
            None
        };
        let horizon = if verdict.stable {
            (verdict.period_seconds * 2.0).clamp(60.0, 600.0)
        } else {
            depletion_seconds.unwrap_or(0.0).clamp(1.0, 600.0)
        };
        let trajectory = injected_trajectory(
            capacity,
            recharge_ms,
            module_drains,
            neut_gjs,
            injections,
            horizon,
        );
        (
            verdict.stable,
            verdict.stable_pct,
            depletion_seconds,
            trajectory,
        )
    };

    CapStats {
        capacity,
        recharge_seconds: tau,
        peak_recharge: peak,
        drain: total_drain,
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
/// the precise depletion time comes from the discrete sim above. Only used when
/// there are no cap injectors (#875) — see [`injected_trajectory`] otherwise.
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

/// Cap-level trajectory when injectors are present (#875): the plain
/// continuous-drain ODE above can't represent a discrete GJ injection, so
/// this samples the exact [`simulate`] discrete event sim onto the UI's
/// fixed 120-point grid instead — reconstructing each grid point from the
/// last known discrete sample via the same analytic recharge formula
/// `simulate` uses between events, so the recharge curve between events
/// stays exact and the injection jumps still show up as a sawtooth.
fn injected_trajectory(
    capacity: f64,
    recharge_ms: f64,
    drains: &[ModuleDrain],
    neut_gjs: f64,
    injections: &[ModuleDrain],
    horizon_s: f64,
) -> Vec<(f64, f64)> {
    if recharge_ms <= 0.0 || capacity <= 0.0 || horizon_s <= 0.0 {
        return Vec::new();
    }
    let horizon_ms = horizon_s * 1000.0;
    let (samples, _) = simulate(
        capacity,
        recharge_ms,
        drains,
        neut_gjs,
        injections,
        horizon_ms,
    );
    let tau = recharge_ms / 5.0; // PYFA: recharge / 5, in ms — matches `simulate`
    const POINTS: usize = 120;
    let dt_ms = horizon_ms / POINTS as f64;
    let mut out = Vec::with_capacity(POINTS + 1);
    out.push((0.0, 100.0));
    let mut idx = 0usize;
    for i in 1..=POINTS {
        let t_ms = i as f64 * dt_ms;
        while idx + 1 < samples.len() && samples[idx + 1].0 <= t_ms {
            idx += 1;
        }
        let (t0, cap0) = samples[idx];
        let frac = (cap0 / capacity).max(0.0).sqrt();
        let mut cap = (1.0 + (frac - 1.0) * ((t0 - t_ms) / tau).exp()).powi(2) * capacity;
        cap -= neut_gjs * (t_ms - t0) / 1000.0;
        cap = cap.clamp(0.0, capacity);
        out.push((t_ms / 1000.0, cap / capacity * 100.0));
    }
    out
}

/// Per-module discrete-sim activation state: `t` is the next activation
/// time (ms); `shots_left` counts down within the current clip (only
/// meaningful when `clip_shots > 0.0 && reload_ms > 0.0` — otherwise the
/// module never pauses and fires every `cyc` forever, pre-#871 behavior).
/// `need` carries the sign: positive for a drain, negative for an
/// injection (#875) — both share this exact same clip/reload state machine.
struct DrainEvent {
    t: f64,
    need: f64,
    cyc: f64,
    clip_shots: f64,
    reload_ms: f64,
    shots_left: f64,
}

impl DrainEvent {
    fn new(d: &ModuleDrain, signed_need: f64) -> Self {
        let reloads = d.clip_shots > 0.0 && d.reload_ms > 0.0;
        DrainEvent {
            t: 0.0,
            need: signed_need,
            cyc: d.cycle_ms,
            clip_shots: d.clip_shots,
            reload_ms: d.reload_ms,
            shots_left: if reloads { d.clip_shots } else { 0.0 },
        }
    }
}

/// Build the combined event list `simulate` drives: drains keep their
/// positive `need` (subtract GJ); injections (#875) get theirs negated (add
/// GJ) — the exact same per-module clip/reload state machine either way.
fn build_events(drains: &[ModuleDrain], injections: &[ModuleDrain]) -> Vec<DrainEvent> {
    drains
        .iter()
        .filter(|d| d.need > 0.0 && d.cycle_ms > 0.0)
        .map(|d| DrainEvent::new(d, d.need))
        .chain(
            injections
                .iter()
                .filter(|d| d.need > 0.0 && d.cycle_ms > 0.0)
                .map(|d| DrainEvent::new(d, -d.need)),
        )
        .collect()
}

/// Core discrete event sim (#875) shared by [`time_to_empty`],
/// [`injected_stability`] and [`injected_trajectory`]: each drain subtracts
/// `need` GJ on its own cycle/reload cadence; each injection (cap
/// booster/ASB charge feeding the ship's own capacitor) does exactly the
/// same thing with the sign flipped, via [`build_events`]. Analytic
/// recharge (PYFA: `recharge / 5`, ms) runs between events, plus continuous
/// neut drain (#706). Samples `(ms, cap_gj)` at the start and after every
/// processed event; stops at `horizon_ms` or the instant cap first goes
/// negative (returned as `Some(seconds)`).
fn simulate(
    capacity: f64,
    recharge_ms: f64,
    drains: &[ModuleDrain],
    neut_gjs: f64,
    injections: &[ModuleDrain],
    horizon_ms: f64,
) -> (Vec<(f64, f64)>, Option<f64>) {
    let tau = recharge_ms / 5.0; // PYFA: recharge / 5, in ms
    let mut events = build_events(drains, injections);
    let mut samples = vec![(0.0, capacity)];
    if events.is_empty() {
        if neut_gjs <= 0.0 {
            return (samples, None);
        }
        // No discrete module pulses to hang the loop off — tick at a fixed
        // cadence purely to sample the continuous neut drain against the
        // recharge curve (#706).
        const TICK_MS: f64 = 1000.0;
        events.push(DrainEvent {
            t: 0.0,
            need: 0.0,
            cyc: TICK_MS,
            clip_shots: 0.0,
            reload_ms: 0.0,
            shots_left: 0.0,
        });
    }
    let cap_max = capacity;
    let mut cap = capacity;
    let mut t_last = 0.0;
    loop {
        // Earliest pending activation.
        let i = (0..events.len())
            .min_by(|&a, &b| events[a].t.partial_cmp(&events[b].t).unwrap())
            .unwrap();
        let t_now = events[i].t;
        let need = events[i].need;
        if t_now > horizon_ms {
            return (samples, None);
        }
        if t_now > t_last {
            let frac = (cap / cap_max).max(0.0).sqrt();
            cap = (1.0 + (frac - 1.0) * ((t_last - t_now) / tau).exp()).powi(2) * cap_max;
            // Continuous neut drain over the elapsed gap (#706).
            cap -= neut_gjs * (t_now - t_last) / 1000.0;
        }
        t_last = t_now;
        cap -= need;
        if cap < 0.0 {
            samples.push((t_now, 0.0));
            return (samples, Some(t_now / 1000.0));
        }
        if cap > cap_max {
            cap = cap_max;
        }
        samples.push((t_now, cap));
        let reloads = events[i].clip_shots > 0.0 && events[i].reload_ms > 0.0;
        if reloads {
            events[i].shots_left -= 1.0;
            if events[i].shots_left <= 0.0 {
                events[i].t = t_now + events[i].cyc + events[i].reload_ms;
                events[i].shots_left = events[i].clip_shots;
            } else {
                events[i].t = t_now + events[i].cyc;
            }
        } else {
            events[i].t = t_now + events[i].cyc;
        }
    }
}

/// Seconds until the capacitor first goes negative, simulating discrete module
/// activations: each module consumes `capNeed` at its cycle start, with the exact
/// analytical recharge between events, until an activation drives cap below zero
/// (the same stop condition PYFA's capSim uses). A module whose [`ModuleDrain`]
/// carries a `clip_shots`/`reload_ms` pair (#871) draws nothing during its
/// reload window: once `clip_shots` consecutive activations fire, its next
/// event is pushed out by `reload_ms` instead of the usual `cycle_ms`. `injections`
/// (#875) inject GJ on their own clip/reload cycle instead of draining it —
/// see [`simulate`]/[`build_events`].
fn time_to_empty(
    capacity: f64,
    recharge_ms: f64,
    drains: &[ModuleDrain],
    neut_gjs: f64,
    injections: &[ModuleDrain],
) -> f64 {
    const BAIL_MS: f64 = 6.0 * 3600.0 * 1000.0; // stable enough; bail
    let (samples, dry_at) = simulate(capacity, recharge_ms, drains, neut_gjs, injections, BAIL_MS);
    dry_at.unwrap_or_else(|| samples.last().map(|&(t, _)| t / 1000.0).unwrap_or(0.0))
}

/// Full clip+reload period (ms) of one drain/injection event (#875): the
/// time for one complete clip to fire plus its reload pause, or just the
/// raw cycle when the item never reloads (infinite ammo/no charge).
fn full_period_ms(d: &ModuleDrain) -> f64 {
    if d.clip_shots > 0.0 && d.reload_ms > 0.0 {
        d.clip_shots * d.cycle_ms + d.reload_ms
    } else {
        d.cycle_ms
    }
}

fn gcd_ms(a: i64, b: i64) -> i64 {
    if b == 0 {
        a
    } else {
        gcd_ms(b, a % b)
    }
}

/// LCM (ms) of every drain/injection's own full period (#875) — the
/// smallest time window after which every module's clip/reload cycle lines
/// back up simultaneously. Rounded to whole milliseconds (dogma durations
/// already are integral ms) and capped at 48h so a pathological set of
/// coprime cycle times can't blow the discrete sim up — pyfa's own capSim
/// carries the same practical ceiling.
fn lcm_period_ms(periods: &[f64]) -> f64 {
    const MAX_PERIOD_MS: f64 = 48.0 * 3600.0 * 1000.0;
    let mut acc: i64 = 1;
    for &p in periods {
        if p <= 0.0 {
            continue;
        }
        let p_ms = (p.round() as i64).max(1);
        let g = gcd_ms(acc, p_ms);
        acc = acc / g * p_ms;
        if acc as f64 > MAX_PERIOD_MS {
            return MAX_PERIOD_MS;
        }
    }
    acc as f64
}

/// Pyfa-style stability verdict, and stable percentage, once cap
/// boosters/ASBs are injecting GJ (#875): see the module doc comment.
struct InjectedVerdict {
    stable: bool,
    stable_pct: Option<f64>,
    /// LCM (seconds) of every drain's/injection's own clip+reload period —
    /// used only to size the trajectory chart's horizon so at least a
    /// couple of full cycles are visible; not load-bearing for the verdict.
    period_seconds: f64,
}

/// Run the discrete drain/injection sim out to the same long bounded
/// horizon [`time_to_empty`] bails out at: starting from a full capacitor,
/// the initial excess above whatever level the drain/injection cycle
/// actually settles into takes many periods to bleed off whenever the
/// recharge time constant (minutes) dwarfs the injector's own cycle
/// (seconds) — comparing just one or two periods against each other would
/// mistake that settling transient for a genuine decline. If the
/// capacitor never goes negative across the whole horizon, its
/// drain/injection cycle has settled into a steady oscillating band and
/// holds indefinitely (the same "does not trend down over a full period"
/// verdict, just checked far enough out to be sure); [`time_to_empty`]
/// (given the same `injections`) reports when it doesn't.
fn injected_stability(
    capacity: f64,
    recharge_ms: f64,
    drains: &[ModuleDrain],
    neut_gjs: f64,
    injections: &[ModuleDrain],
) -> InjectedVerdict {
    const HORIZON_MS: f64 = 6.0 * 3600.0 * 1000.0; // matches time_to_empty's bail-out
    let periods: Vec<f64> = drains
        .iter()
        .chain(injections.iter())
        .filter(|d| d.need > 0.0 && d.cycle_ms > 0.0)
        .map(full_period_ms)
        .collect();
    let period_ms = if periods.is_empty() {
        1000.0
    } else {
        lcm_period_ms(&periods)
    };
    let (samples, dry_at) = simulate(
        capacity,
        recharge_ms,
        drains,
        neut_gjs,
        injections,
        HORIZON_MS,
    );
    if dry_at.is_some() {
        return InjectedVerdict {
            stable: false,
            stable_pct: None,
            period_seconds: period_ms / 1000.0,
        };
    }
    // Stable: report the average cap level over the tail third of the
    // horizon (well past the initial settling transient) as "stable %" —
    // smooths the sawtooth into one representative steady-state reading,
    // mirroring the single number the analytic branch reports.
    let tail_start = HORIZON_MS * 2.0 / 3.0;
    let tail: Vec<f64> = samples
        .iter()
        .filter(|&&(t, _)| t >= tail_start)
        .map(|&(_, c)| c)
        .collect();
    let avg = if tail.is_empty() {
        samples.last().map(|&(_, c)| c).unwrap_or(capacity)
    } else {
        tail.iter().sum::<f64>() / tail.len() as f64
    };
    InjectedVerdict {
        stable: true,
        stable_pct: Some((avg / capacity * 100.0).clamp(0.0, 100.0)),
        period_seconds: period_ms / 1000.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A non-reloading module drain (pre-#871 shape): fires `need` GJ every
    /// `cycle_ms`, forever.
    fn drain(need: f64, cycle_ms: f64) -> ModuleDrain {
        ModuleDrain {
            need,
            cycle_ms,
            clip_shots: 0.0,
            reload_ms: 0.0,
        }
    }

    #[test]
    fn no_drain_is_fully_stable() {
        let c = capacitor(250.0, 125_000.0, 0.0, &[], 0.0, &[]);
        assert!(c.stable);
        assert_eq!(c.stable_pct, Some(100.0)); // k=0 → x=1
                                               // Rifter peak: 2.5 * 250 / 125 = 5 GJ/s.
        assert!((c.peak_recharge - 5.0).abs() < 1e-9);
    }

    #[test]
    fn drain_above_peak_is_unstable() {
        let c = capacitor(250.0, 125_000.0, 6.0, &[drain(6.0, 1000.0)], 0.0, &[]); // 6 > 5 peak
        assert!(!c.stable);
        assert_eq!(c.stable_pct, None);
    }

    #[test]
    fn unstable_reports_a_finite_depletion_time() {
        // 8 GJ/s drain via a 1 s, 8 GJ module — well above the 5 peak.
        let c = capacitor(250.0, 125_000.0, 8.0, &[drain(8.0, 1000.0)], 0.0, &[]);
        assert!(!c.stable);
        let t = c
            .depletion_seconds
            .expect("unstable cap should report a time");
        assert!(t > 0.0 && t < 36_000.0, "depletion = {t}");
    }

    #[test]
    fn drain_at_peak_is_stable_at_25_percent() {
        // Exactly peak drain ⇒ equilibrium at the peak point, 25%.
        let c = capacitor(250.0, 125_000.0, 5.0, &[], 0.0, &[]);
        assert!(c.stable);
        let pct = c.stable_pct.unwrap();
        assert!((pct - 25.0).abs() < 1e-6, "stable% = {pct}");
    }

    #[test]
    fn partial_drain_settles_high() {
        // Light drain settles near full cap (high stable %).
        let c = capacitor(1000.0, 200_000.0, 2.0, &[], 0.0, &[]);
        let pct = c.stable_pct.unwrap();
        assert!(pct > 90.0 && pct < 100.0, "stable% = {pct}");
    }

    #[test]
    fn trajectory_starts_full_and_settles_at_stable_level() {
        let c = capacitor(1000.0, 200_000.0, 2.0, &[], 0.0, &[]);
        assert_eq!(c.trajectory.first().unwrap().1, 100.0); // starts full
        let end = c.trajectory.last().unwrap().1;
        let stable = c.stable_pct.unwrap();
        // The curve converges toward the analytic stable level.
        assert!((end - stable).abs() < 1.0, "end {end} vs stable {stable}");
    }

    #[test]
    fn trajectory_declines_toward_empty_when_unstable() {
        let c = capacitor(250.0, 125_000.0, 8.0, &[drain(8.0, 1000.0)], 0.0, &[]);
        let end = c.trajectory.last().unwrap().1;
        assert!(end < 20.0, "unstable cap should be near empty, got {end}%");
    }

    /// A neut projecting continuous GJ/s drain (#706) tips an otherwise-stable
    /// fit into instability, same as an equivalent module drain would.
    #[test]
    fn neut_drain_can_destabilize_a_stable_fit() {
        // 4 GJ/s module drain alone is under the 5 GJ/s peak (stable); +2 GJ/s
        // neut pushes total steady drain to 6, over peak.
        let stable = capacitor(250.0, 125_000.0, 4.0, &[drain(4.0, 1000.0)], 0.0, &[]);
        assert!(stable.stable);
        let neutralized = capacitor(250.0, 125_000.0, 4.0, &[drain(4.0, 1000.0)], 2.0, &[]);
        assert!(!neutralized.stable);
        assert_eq!(neutralized.drain, 6.0);
    }

    /// Neut pressure shortens the discrete depletion sim (#706): the same
    /// module drain empties faster with neut GJ/s added on top.
    #[test]
    fn neut_drain_shortens_depletion_time() {
        let no_neut = capacitor(250.0, 125_000.0, 8.0, &[drain(8.0, 1000.0)], 0.0, &[]);
        let with_neut = capacitor(250.0, 125_000.0, 8.0, &[drain(8.0, 1000.0)], 3.0, &[]);
        let t_no_neut = no_neut.depletion_seconds.expect("unstable");
        let t_with_neut = with_neut.depletion_seconds.expect("unstable");
        assert!(
            t_with_neut < t_no_neut,
            "with-neut depletion {t_with_neut} should be < no-neut {t_no_neut}"
        );
    }

    /// Cap stability improves when reload is factored in (#871): a module
    /// whose raw 8 GJ/s drain is unstable against a 5 GJ/s peak (250 GJ
    /// capacity, 125s recharge) becomes stable once its own reload cycle
    /// (5-shot clip, 20s reload → sustained factor 5s/(5s+20s) = 0.2) derates
    /// the *average* steady drain the caller feeds in to 1.6 GJ/s.
    #[test]
    fn reload_pause_improves_cap_stability() {
        let unstable = capacitor(250.0, 125_000.0, 8.0, &[drain(8.0, 1000.0)], 0.0, &[]);
        assert!(!unstable.stable);

        let reloading = ModuleDrain {
            need: 8.0,
            cycle_ms: 1000.0,
            clip_shots: 5.0,
            reload_ms: 20_000.0,
        };
        let stable = capacitor(250.0, 125_000.0, 1.6, &[reloading], 0.0, &[]);
        assert!(
            stable.stable,
            "reload-derated drain should stabilize the cap"
        );
    }

    /// The discrete depletion sim itself pauses draw during a module's
    /// reload window (#871): the same raw per-shot drain empties the
    /// capacitor slower once reload is factored in, since no GJ is drawn
    /// while the module is reloading.
    #[test]
    fn reload_pause_extends_discrete_depletion_time() {
        let t_no_reload = time_to_empty(250.0, 125_000.0, &[drain(8.0, 1000.0)], 0.0, &[]);
        let reloading = ModuleDrain {
            need: 8.0,
            cycle_ms: 1000.0,
            clip_shots: 5.0,
            reload_ms: 20_000.0,
        };
        let t_reloading = time_to_empty(250.0, 125_000.0, &[reloading], 0.0, &[]);
        assert!(
            t_reloading > t_no_reload,
            "reload pause should extend depletion: {t_reloading} vs {t_no_reload}"
        );
    }

    /// A cap booster injection (#875) turns an otherwise-unstable fit
    /// stable: the same 8 GJ/s drain that's unstable alone (well above the
    /// 5 GJ/s peak) is offset by a booster injecting 20 GJ every 6s,
    /// forever (no clip/reload) — average injection 20/6 ≈ 3.33 GJ/s, enough
    /// to bring net drain under the boosted capacitor's ability to recover.
    #[test]
    fn cap_booster_injection_stabilizes_an_unstable_drain() {
        let unstable = capacitor(250.0, 125_000.0, 8.0, &[drain(8.0, 1000.0)], 0.0, &[]);
        assert!(!unstable.stable);

        let booster = ModuleDrain {
            need: 20.0,
            cycle_ms: 6_000.0,
            clip_shots: 0.0,
            reload_ms: 0.0,
        };
        let boosted = capacitor(
            250.0,
            125_000.0,
            8.0,
            &[drain(8.0, 1000.0)],
            0.0,
            &[booster],
        );
        assert!(
            boosted.stable,
            "cap booster injection should stabilize the cap"
        );
        assert!(boosted.stable_pct.is_some());
        assert!(boosted.depletion_seconds.is_none());
    }

    /// A cap booster whose own clip runs out (#875) — clip/reload bounded,
    /// same shape reload accounting drains already use (#871) — cannot
    /// sustain the same fit indefinitely once its own charges run dry: with
    /// only a 2-shot clip and a long reload, the *sustained* injection rate
    /// is far lower than the unbounded case above, and the fit reports
    /// unstable with a finite depletion time instead.
    #[test]
    fn cap_booster_with_short_clip_cannot_sustain_a_heavy_drain() {
        let booster = ModuleDrain {
            need: 20.0,
            cycle_ms: 6_000.0,
            clip_shots: 2.0,
            reload_ms: 600_000.0, // 10 minutes
        };
        let boosted = capacitor(
            250.0,
            125_000.0,
            8.0,
            &[drain(8.0, 1000.0)],
            0.0,
            &[booster],
        );
        assert!(
            !boosted.stable,
            "a booster that runs dry quickly shouldn't sustain a heavy drain"
        );
        let t = boosted
            .depletion_seconds
            .expect("unstable cap should report a time");
        assert!(t > 0.0, "depletion = {t}");
    }

    /// The 120-point trajectory shows the injection sawtooth (#875) — cap
    /// rises sharply when the booster fires, unlike a monotonically
    /// declining unstable trajectory.
    #[test]
    fn trajectory_shows_injection_sawtooth() {
        let booster = ModuleDrain {
            need: 20.0,
            cycle_ms: 6_000.0,
            clip_shots: 0.0,
            reload_ms: 0.0,
        };
        let boosted = capacitor(
            250.0,
            125_000.0,
            8.0,
            &[drain(8.0, 1000.0)],
            0.0,
            &[booster],
        );
        let rises = boosted
            .trajectory
            .windows(2)
            .filter(|w| w[1].1 > w[0].1 + 0.5)
            .count();
        assert!(
            rises > 0,
            "boosted trajectory should show at least one rise (the sawtooth)"
        );
    }
}
