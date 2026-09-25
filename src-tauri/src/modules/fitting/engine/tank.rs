//! Tank: resists, EHP and local reps (#173) — pure.
//!
//! Resonance is the fraction of damage that gets through (1.0 = 0% resist,
//! 0.9 = 10% resist); resist% = 1 − resonance. A layer's effective resonance
//! against a damage profile is the profile-weighted average of its four
//! resonances, and EHP = HP / effective_resonance. Total EHP sums the shield,
//! armor and hull layers. The command reads *finalized* resonances/HP, so
//! hardeners, rigs and skills are already applied.

use crate::modules::fitting::types::TankStats;

/// Damage-type weighting for EHP. Order: `[em, thermal, kinetic, explosive]`.
#[derive(Debug, Clone, Copy)]
pub struct DamageProfile(pub [f64; 4]);

impl Default for DamageProfile {
    /// An even 25/25/25/25 split — the conventional default EHP basis.
    fn default() -> Self {
        DamageProfile([0.25, 0.25, 0.25, 0.25])
    }
}

/// One defensive layer: hit points and the four damage resonances.
#[derive(Debug, Clone, Copy)]
pub struct Layer {
    pub hp: f64,
    /// `[em, thermal, kinetic, explosive]` resonances (damage taken fraction).
    pub resonance: [f64; 4],
}

impl Layer {
    /// Profile-weighted effective resonance (clamped to ≥ a tiny epsilon so an
    /// all-immune layer doesn't divide by zero).
    fn effective_resonance(&self, profile: &DamageProfile) -> f64 {
        let eff: f64 = (0..4).map(|i| profile.0[i] * self.resonance[i]).sum();
        eff.max(1e-9)
    }

    fn ehp(&self, profile: &DamageProfile) -> f64 {
        self.hp / self.effective_resonance(profile)
    }

    fn resists(&self) -> [f64; 4] {
        [
            1.0 - self.resonance[0],
            1.0 - self.resonance[1],
            1.0 - self.resonance[2],
            1.0 - self.resonance[3],
        ]
    }

    /// Remote-rep multiplier (#878): how much a remote repair's raw HP is
    /// amplified by this layer's profile-weighted resonance — the same
    /// `1 / effective_resonance` denominator EHP uses. Logistics pilots read
    /// this off a target to know how much a rep cycle actually restores
    /// against the incoming damage (a heavily resisted layer turns a small
    /// GJ number into a much bigger effective-HP one).
    fn rrm(&self, profile: &DamageProfile) -> f64 {
        1.0 / self.effective_resonance(profile)
    }
}

/// Max Reactive Armor Hardener resist-shift iterations before giving up on
/// convergence — generous headroom over the handful of cycles a *static*
/// damage profile actually needs (worst case ~`1/shift_amt`, ~17 for a T2
/// RAH's 6% shift) to hit its fixed point.
const RAH_MAX_ITERATIONS: usize = 1000;

/// One resist-shift cycle: the resonance(s) that took the *least* damage
/// last cycle (always at least two — RAH never drains fewer than two types,
/// even against a single damage type) each donate up to `shift_amt` of
/// resonance (capped so none exceeds 1.0, i.e. 0% resist) to whichever
/// resonance(s) took the *most*, split evenly across recipients. Resonance
/// sum is conserved every cycle. Ties break by array order (`[em, thermal,
/// kinetic, explosive]`), mirroring the module's own fixed attribute
/// enumeration order in-game — under a perfectly even profile this makes
/// `em`/`thermal` donate first, a real (if arbitrary-looking) quirk of the
/// mechanic, not a bug in the port.
fn rah_step(r: [f64; 4], shift_amt: f64, profile: &DamageProfile) -> [f64; 4] {
    let received: [f64; 4] = std::array::from_fn(|i| profile.0[i] * r[i]);
    let donors = received.iter().filter(|&&d| d == 0.0).count().max(2);
    let recipients = 4 - donors;
    if recipients == 0 {
        return r; // degenerate all-zero profile: nothing to shift toward
    }
    let mut order = [0usize, 1, 2, 3];
    order.sort_by(|&a, &b| received[a].partial_cmp(&received[b]).unwrap());
    let mut donated = 0.0;
    let mut next = r;
    for &i in &order[..donors] {
        let give = (1.0 - r[i]).min(shift_amt);
        donated += give;
        next[i] = r[i] + give;
    }
    for &i in &order[donors..] {
        next[i] = r[i] - donated / recipients as f64;
    }
    next
}

/// Round to 9 decimal places for loop detection: accumulated float error
/// across iterations shouldn't mask a real repeated state.
fn round9(r: [f64; 4]) -> [f64; 4] {
    r.map(|v| (v * 1e9).round() / 1e9)
}

/// Reactive Armor Hardener resist-shift fixed point (#878). Mirrors PYFA/eos's
/// per-cycle donor/recipient rule (game math is factual, ported here as an
/// *approach*, not eos's GPL-3.0 code) applied to a single *static* damage
/// profile. Not every profile settles on one fixed resonance — a tied
/// profile (e.g. an even 25/25/25/25 split) makes the module oscillate
/// between two states forever, alternately favoring the tie-break order's
/// leading vs trailing types — so this detects the repeating cycle
/// (`rah_step` outputs, rounded, revisiting an earlier state) and returns
/// the average resonance across it, the same fallback eos's simulator uses.
/// `base_resonance` is the module's own unshifted per-type resonance
/// (`[em, thermal, kinetic, explosive]` — a base RAH starts at `[0.85; 4]`,
/// 15% resist each); `shift_amt` is the module's `resistanceShiftAmount`
/// (attribute 1849) ÷ 100.
pub fn rah_shift(base_resonance: [f64; 4], shift_amt: f64, profile: &DamageProfile) -> [f64; 4] {
    if shift_amt <= 0.0 {
        return base_resonance;
    }
    let mut r = base_resonance;
    let mut history = vec![round9(r)];
    for _ in 0..RAH_MAX_ITERATIONS {
        let next = rah_step(r, shift_amt, profile);
        let rounded = round9(next);
        if let Some(start) = history.iter().position(|&s| s == rounded) {
            let cycle = &history[start..];
            let mut avg = [0.0; 4];
            for s in cycle {
                for k in 0..4 {
                    avg[k] += s[k];
                }
            }
            let n = cycle.len() as f64;
            return avg.map(|v| v / n);
        }
        history.push(rounded);
        r = next;
    }
    r
}

/// Compute tank stats from the three layers, a damage profile, and local
/// rep/s — burst (while an ancillary module's charge/capacitor keeps it at
/// full rate) and sustained (cycle-averaged including any reload pause,
/// #878). `rah_active`/`passive_shield_s` are filled in by the caller.
#[allow(clippy::too_many_arguments)] // one arg per independent input; a struct would just rename them
pub fn tank(
    shield: Layer,
    armor: Layer,
    hull: Layer,
    profile: &DamageProfile,
    shield_rep_s: f64,
    armor_rep_s: f64,
    shield_rep_s_sustained: f64,
    armor_rep_s_sustained: f64,
) -> TankStats {
    TankStats {
        shield_hp: shield.hp,
        armor_hp: armor.hp,
        hull_hp: hull.hp,
        ehp: shield.ehp(profile) + armor.ehp(profile) + hull.ehp(profile),
        shield_resists: shield.resists(),
        armor_resists: armor.resists(),
        hull_resists: hull.resists(),
        shield_rep_s,
        armor_rep_s,
        shield_rep_s_sustained,
        armor_rep_s_sustained,
        shield_rrm: shield.rrm(profile),
        armor_rrm: armor.rrm(profile),
        hull_rrm: hull.rrm(profile),
        // Filled by the caller (`tank_of`), which knows about fitted modules.
        rah_active: false,
        // Filled by the caller from the resolved hull (needs recharge time).
        passive_shield_s: 0.0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ehp_with_no_resists_equals_raw_hp() {
        let layer = Layer {
            hp: 1000.0,
            resonance: [1.0; 4],
        };
        let t = tank(
            layer,
            Layer {
                hp: 0.0,
                resonance: [1.0; 4],
            },
            Layer {
                hp: 0.0,
                resonance: [1.0; 4],
            },
            &DamageProfile::default(),
            0.0,
            0.0,
            0.0,
            0.0,
        );
        assert!((t.ehp - 1000.0).abs() < 1e-9);
    }

    #[test]
    fn uniform_resist_scales_ehp_inversely() {
        // 50% resist across the board ⇒ resonance 0.5 ⇒ EHP = 2x raw.
        let layer = Layer {
            hp: 1000.0,
            resonance: [0.5; 4],
        };
        let t = tank(
            layer,
            Layer {
                hp: 0.0,
                resonance: [1.0; 4],
            },
            Layer {
                hp: 0.0,
                resonance: [1.0; 4],
            },
            &DamageProfile::default(),
            0.0,
            0.0,
            0.0,
            0.0,
        );
        assert!((t.ehp - 2000.0).abs() < 1e-6);
        assert!((t.shield_resists[0] - 0.5).abs() < 1e-9);
    }

    #[test]
    fn profile_weights_pick_the_weak_resonance() {
        // 0% em resist (res 1.0), 90% on the rest; an all-em profile sees raw HP.
        let layer = Layer {
            hp: 1000.0,
            resonance: [1.0, 0.1, 0.1, 0.1],
        };
        let em_only = DamageProfile([1.0, 0.0, 0.0, 0.0]);
        let t = tank(
            layer,
            Layer {
                hp: 0.0,
                resonance: [1.0; 4],
            },
            Layer {
                hp: 0.0,
                resonance: [1.0; 4],
            },
            &em_only,
            0.0,
            0.0,
            0.0,
            0.0,
        );
        assert!((t.ehp - 1000.0).abs() < 1e-6);
    }

    #[test]
    fn layers_and_reps_sum() {
        let t = tank(
            Layer {
                hp: 500.0,
                resonance: [1.0; 4],
            },
            Layer {
                hp: 450.0,
                resonance: [1.0; 4],
            },
            Layer {
                hp: 350.0,
                resonance: [1.0; 4],
            },
            &DamageProfile::default(),
            12.0,
            0.0,
            6.0,
            0.0,
        );
        assert!((t.ehp - 1300.0).abs() < 1e-9);
        assert_eq!(t.shield_rep_s, 12.0);
        assert_eq!(t.shield_rep_s_sustained, 6.0);
    }

    #[test]
    fn rrm_is_inverse_effective_resonance() {
        // 50% resist across the board ⇒ resonance 0.5 ⇒ RRM = 2x (a remote
        // rep's raw GJ restores twice as much effective HP).
        let layer = Layer {
            hp: 1000.0,
            resonance: [0.5; 4],
        };
        assert!((layer.rrm(&DamageProfile::default()) - 2.0).abs() < 1e-9);
    }

    #[test]
    fn rah_shift_no_shift_amount_is_a_no_op() {
        let base = [0.85; 4];
        let r = rah_shift(base, 0.0, &DamageProfile::default());
        assert_eq!(r, base);
    }

    #[test]
    fn rah_shift_single_damage_type_concentrates_all_resist_on_it() {
        // A base RAH (0.85/0.85/0.85/0.85, 15% each, 6% shift/cycle) against
        // a pure-EM profile: the three undamaged types donate every point of
        // their own resist to EM cycle by cycle until they hit 0% resist
        // (resonance 1.0) and EM absorbs the module's whole 60% pool —
        // resonance 3.4 - 3*1.0 = 0.4 exactly. Hand-verified: cycle 1 donors
        // 0.85->0.91 (x3, capped at the 6% shift), EM 0.85->0.67; cycle 2
        // donors ->0.97, EM ->0.49; cycle 3 donors ->1.0 (only 3% left to
        // give), EM ->0.40; cycle 4 donors exhausted, no further donation.
        let base = [0.85; 4];
        let em_only = DamageProfile([1.0, 0.0, 0.0, 0.0]);
        let shifted = rah_shift(base, 0.06, &em_only);
        assert!((shifted[0] - 0.4).abs() < 1e-9, "em resonance: {shifted:?}");
        assert!(
            (shifted[1] - 1.0).abs() < 1e-9,
            "thermal resonance: {shifted:?}"
        );
        assert!(
            (shifted[2] - 1.0).abs() < 1e-9,
            "kinetic resonance: {shifted:?}"
        );
        assert!(
            (shifted[3] - 1.0).abs() < 1e-9,
            "explosive resonance: {shifted:?}"
        );
        let sum: f64 = shifted.iter().sum();
        assert!((sum - 3.4).abs() < 1e-9, "resonance sum conserved: {sum}");
    }

    #[test]
    fn rah_shift_even_profile_oscillates_and_averages_by_tie_break_order() {
        // Under an even 25/25/25/25 split every type receives identical
        // damage, so the tie-break (array order `[em, thermal, kinetic,
        // explosive]`) always picks the same two donors/recipients: cycle 1
        // donates em/thermal 0.85->0.91 and drains kinetic/explosive
        // 0.85->0.79; cycle 2 (now kinetic/explosive are "least damaged")
        // donates them 0.79->0.85 and drains em/thermal 0.91->0.85, landing
        // exactly back on baseline — a period-2 loop {A, baseline} forever.
        // The fixed point is the average of that loop, not the baseline
        // itself: em/thermal settle 3pp better resisted than kinetic/
        // explosive, a real (if tie-break-order-driven) quirk of the
        // mechanic against a perfectly flat damage profile.
        let base = [0.85; 4];
        let shifted = rah_shift(base, 0.06, &DamageProfile::default());
        assert!((shifted[0] - 0.88).abs() < 1e-9, "em: {shifted:?}");
        assert!((shifted[1] - 0.88).abs() < 1e-9, "thermal: {shifted:?}");
        assert!((shifted[2] - 0.82).abs() < 1e-9, "kinetic: {shifted:?}");
        assert!((shifted[3] - 0.82).abs() < 1e-9, "explosive: {shifted:?}");
        let sum: f64 = shifted.iter().sum();
        assert!((sum - 3.4).abs() < 1e-9, "resonance sum conserved: {sum}");
    }
}
