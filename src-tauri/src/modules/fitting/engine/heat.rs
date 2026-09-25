//! Overheat burnout time — per-rack heat pool model (#874).
//!
//! EVE splits each rack (high/mid/low) into its own isolated heat pool.
//! Overheating a module raises its rack's heat level continuously while it
//! runs, and every cycle rolls a chance to deal that module's `heatDamage` to
//! itself or a nearby rack-mate; a module burns out (stops working until
//! repaired) once its structure hitpoints are exhausted. The approach and
//! formulas below are exactly the community-reverse-engineered model — EVE
//! University's "Overheating" wiki page and the pyfa/eos maintainers' writeup
//! (<https://github.com/pyfa-org/eos/issues/12>) — ported as *math*, not code
//! (Pyfa/eos are GPL-3.0; this repo is MIT; game math is factual and not
//! copyrightable).
//!
//! Rack heat build-up is a closed form:
//! `H(t) = (heatCapacity/100) · (1 − e^(−t·G·S))`, where `G` is the ship's
//! `heatGenerationMultiplier` and `S` sums the `heatAbsorbtionRateModifier` of
//! every currently-overheated module in that rack. Each cycle's damage chance
//! is `P = Fh·Fs·Fa`: the rack's current heat level (`Fh`), a whole-ship "how
//! full is the fit" slot factor (`Fs`, shrunk by offline modules *and* empty
//! slots alike — the source of the "empty slots absorb heat" folklore), and a
//! per-target attenuation falloff by rack position (`Fa = attenuation^distance`,
//! 1.0 for a module damaging itself).
//!
//! EVE's actual damage rolls are Bernoulli trials over a heat level that keeps
//! rising, which only has a proper closed-form solution via simulation or
//! fairly heavy probability machinery (negative-binomial mixtures — see the
//! eos thread). We instead report the **expected-value** burnout time:
//! integrate the expected damage rate `Fs·H(t)·(heatDamage/cycleTime)` from
//! `t = 0` until the cumulative expected damage reaches the module's
//! structure hitpoints, and solve for that `t`. This is a sensible estimate,
//! not a lie of precision, matching how this codebase already treats other
//! stochastic EVE mechanics (see the wormhole mass-budget model) — actual
//! burnout times scatter around it.
use super::attr::attr;

/// One overheated module's heat-relevant inputs, within its rack.
#[derive(Debug, Clone, Copy)]
pub struct HeatSource {
    /// Position within its slot kind (`FitItem::index`) — adjacency distance
    /// for [`RackHeat::attenuation`] is `|position_a − position_b|`, matching
    /// eos's "rack isn't looped" rule. The fit model compacts fitted items
    /// per slot kind rather than preserving genuinely empty in-between slots,
    /// so this is the same kind of representative approximation as the
    /// wormhole mass-budget bands, not a pixel-exact in-game layout.
    pub position: i32,
    /// `heatDamage` (1211), already skill/ship-bonus resolved — HP dealt at
    /// distance 0 on a successful roll.
    pub heat_damage: f64,
    /// `heatAbsorbtionRateModifier` (1180) — this module's own contribution
    /// to its rack's heat build-up while overheated (fraction of rack
    /// capacity/second).
    pub heat_generation: f64,
    /// Cycle time (`duration`, 73), milliseconds — damage rolls happen once
    /// per cycle.
    pub cycle_ms: f64,
    /// Structure hitpoints (9) — expected cumulative damage at burnout.
    pub hp: f64,
}

/// One rack's (high/mid/low) ship-side heat attributes.
#[derive(Debug, Clone, Copy)]
pub struct RackHeat {
    /// `heatCapacityHi`/`Med`/`Low` — rack heat pool size, as a percentage
    /// (100 on every hull observed against the bundled SDE; carried as a
    /// ship attribute rather than hardcoded in case CCP ever varies it).
    pub capacity: f64,
    /// `heatGenerationMultiplier` — hull-size rack heat build-up rate.
    pub generation_multiplier: f64,
    /// `heatAttenuationHi`/`Med`/`Low` — per-slot-distance damage falloff.
    pub attenuation: f64,
}

/// Read a rack's [`RackHeat`] off a ship's finalized attribute getter.
pub fn rack_heat(get: impl Fn(i64) -> f64, capacity_attr: i64, attenuation_attr: i64) -> RackHeat {
    RackHeat {
        capacity: get(capacity_attr),
        generation_multiplier: get(attr::HEAT_GENERATION_MULTIPLIER),
        attenuation: get(attenuation_attr),
    }
}

/// The widest burnout horizon this model will report before giving up and
/// calling it indefinite (~30 days) — matches [`capacitor::lcm_period_ms`]'s
/// practical ceiling on runaway numeric search for a degenerate input.
const MAX_HORIZON_S: f64 = 30.0 * 24.0 * 3600.0;

/// Expected-value burnout time (seconds) for each overheated module in one
/// rack, parallel to `sources`. `slot_factor` is `Fs` — online+ modules
/// across the *whole ship* over every slot the hull has (every rack plus
/// rigs) — shared by every rack, so callers compute it once per fit.
/// `None` when the module can never build meaningful heat (a dead rack: no
/// generation, no capacity, no slot factor, no self-damage) rather than a
/// wildly large number.
pub fn burnout_seconds(
    rack: &RackHeat,
    slot_factor: f64,
    sources: &[HeatSource],
) -> Vec<Option<f64>> {
    let cap_frac = rack.capacity / 100.0;
    let s: f64 = sources.iter().map(|m| m.heat_generation.max(0.0)).sum();
    let k = rack.generation_multiplier * s;
    if k <= 0.0 || cap_frac <= 0.0 || slot_factor <= 0.0 {
        return vec![None; sources.len()];
    }
    sources
        .iter()
        .map(|target| {
            let coeff = slot_factor
                * cap_frac
                * sources
                    .iter()
                    .filter(|src| src.cycle_ms > 0.0 && src.heat_damage > 0.0)
                    .map(|src| {
                        let distance = (target.position - src.position).unsigned_abs() as f64;
                        let fa = rack.attenuation.powf(distance);
                        fa * src.heat_damage / (src.cycle_ms / 1000.0)
                    })
                    .sum::<f64>();
            if coeff <= 0.0 || target.hp <= 0.0 {
                None
            } else {
                solve_burnout(k, coeff, target.hp)
            }
        })
        .collect()
}

/// Solve `coeff·cap_frac_already_folded_into_coeff·(T − (1 − e^(−k·T))/k) = hp`
/// for `T` by bisection — the cumulative-damage integral is strictly
/// increasing in `T` (its derivative, the instantaneous expected damage
/// rate, is `coeff·(1 − e^(−k·T)) ≥ 0`), so a single bracket-then-bisect
/// pass converges to double precision.
fn solve_burnout(k: f64, coeff: f64, hp: f64) -> Option<f64> {
    let cumulative = |t: f64| coeff * (t - (1.0 - (-k * t).exp()) / k);
    let mut hi = 1.0_f64;
    while cumulative(hi) < hp {
        if hi >= MAX_HORIZON_S {
            return None;
        }
        hi *= 2.0;
    }
    let mut lo = 0.0_f64;
    for _ in 0..100 {
        let mid = (lo + hi) / 2.0;
        if cumulative(mid) < hp {
            lo = mid;
        } else {
            hi = mid;
        }
    }
    Some((lo + hi) / 2.0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Rifter (frigate) + 5MN MWD I values straight off the bundled SDE:
    /// heatCapacityHi/Med/Low = 100, heatGenerationMultiplier = 1.0,
    /// heatAttenuationMed = 0.5; MWD heatDamage = 19.0, duration = 10000 ms
    /// (heatAbsorbtionRateModifier isn't in the Fuzzwork dump for this
    /// module's dogma row — EVE University's published table gives 4%/s for
    /// prop mods on a frigate hull, used here). Module `hp` (structure
    /// hitpoints) = 40, the value EVE University's Overheating page cites as
    /// typical.
    fn mwd_source() -> HeatSource {
        HeatSource {
            position: 0,
            heat_damage: 19.0,
            heat_generation: 0.04,
            cycle_ms: 10_000.0,
            hp: 40.0,
        }
    }

    fn rifter_mid_rack() -> RackHeat {
        RackHeat {
            capacity: 100.0,
            generation_multiplier: 1.0,
            attenuation: 0.5,
        }
    }

    /// A lone overheated MWD (no other overloaded mid-slot modules, `Fs` for
    /// a bare-mid-rack frigate ballpark ~0.3) should burn out on the order of
    /// tens of seconds to a couple of minutes — EVE University's Propulsion
    /// equipment page: "A 5MN MWD ... can completely burn itself out in as
    /// few as *three* overheated cycles" (worst-case RNG at a 10s cycle,
    /// i.e. as low as ~20-30s); our expected-value estimate should land
    /// comfortably above that worst case and below several minutes.
    #[test]
    fn lone_mwd_burnout_is_plausible() {
        let rack = rifter_mid_rack();
        let source = mwd_source();
        let times = burnout_seconds(&rack, 0.3, &[source]);
        let t = times[0].expect("MWD generates heat, should burn out eventually");
        assert!(
            t > 20.0,
            "expected-value estimate should exceed the RNG worst case ({t}s)"
        );
        assert!(
            t < 600.0,
            "expected-value estimate should be well under 10 minutes ({t}s)"
        );
    }

    /// Thermodynamics reduces `heatDamage` 5%/level (25% at level V); the
    /// resolved `heat_damage` a caller feeds in already reflects that (the
    /// dogma engine applies it generically via the skill's own effects, see
    /// `stats::heat_of`). Because rack heat keeps building while a module
    /// overheats, cumulative expected damage isn't linear in time (it's
    /// `t²`-ish early on, only asymptotically linear later), so a straight
    /// 25%-less-damage input does *not* buy an exactly 1/0.75×-longer
    /// burnout — the acceptance criterion's "right ratio" is checked here as
    /// monotonic per-level improvement landing in a plausible band around
    /// naive linear scaling, not an exact multiplier.
    #[test]
    fn thermodynamics_scales_burnout_time_5pct_per_level() {
        let rack = rifter_mid_rack();
        let base = mwd_source();
        let times: Vec<f64> = (0..=5)
            .map(|level| {
                let reduced = HeatSource {
                    heat_damage: base.heat_damage * (1.0 - 0.05 * level as f64),
                    ..base
                };
                burnout_seconds(&rack, 0.3, &[reduced])[0].unwrap()
            })
            .collect();
        for pair in times.windows(2) {
            assert!(
                pair[1] > pair[0],
                "each Thermodynamics level should strictly lengthen burnout time: {times:?}"
            );
        }
        let ratio = times[5] / times[0];
        assert!(
            (1.15..1.35).contains(&ratio),
            "level V (-25% heat damage) should land near the naive 1/0.75x ratio, got {ratio}x ({times:?})"
        );
    }

    /// Two overheated modules in the same rack, four slots apart, each also
    /// damage the other via the attenuation falloff — bringing both
    /// modules' burnout time down relative to either one alone (more total
    /// heat, plus cross-damage), even though their own generation only sums
    /// once into the shared rack pool.
    #[test]
    fn neighbor_in_same_rack_speeds_up_burnout() {
        let rack = rifter_mid_rack();
        let solo = mwd_source();
        let solo_t = burnout_seconds(&rack, 0.5, &[solo])[0].unwrap();

        let a = HeatSource {
            position: 0,
            ..solo
        };
        let b = HeatSource {
            position: 3,
            ..solo
        };
        let paired_t = burnout_seconds(&rack, 0.5, &[a, b])[0].unwrap();

        assert!(
            paired_t < solo_t,
            "an overloaded rack-mate should shorten burnout time ({paired_t}s vs {solo_t}s solo)"
        );
    }

    /// A module that isn't actually generating any heat (offline/inert
    /// input) never builds up a rack heat pool at all — no division by zero,
    /// no runaway search, just "doesn't burn out" under this model.
    #[test]
    fn dead_rack_never_burns_out() {
        let rack = RackHeat {
            capacity: 100.0,
            generation_multiplier: 0.0,
            attenuation: 0.5,
        };
        let times = burnout_seconds(&rack, 0.3, &[mwd_source()]);
        assert_eq!(times, vec![None]);
    }

    /// Zero slot factor (nothing else fitted+online anywhere on the hull) —
    /// still a degenerate no-damage-chance case, not a divide-by-zero.
    #[test]
    fn zero_slot_factor_never_burns_out() {
        let rack = rifter_mid_rack();
        let times = burnout_seconds(&rack, 0.0, &[mwd_source()]);
        assert_eq!(times, vec![None]);
    }
}
