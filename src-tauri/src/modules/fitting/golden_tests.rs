//! SDE-gated golden PYFA test suite: the live dogma engine vs PYFA-recorded
//! reference numbers. Split out of commands.rs (#565) since it exercises the
//! dogma stats layer (`stats::run_dogma`), not commands.rs or the optimizer.

use super::engine::tank::DamageProfile;
use super::stats::run_dogma;
use super::types::{Fit, FitItem, ModuleState, SlotKind};
use crate::sde::Sde;

/// Golden gate (#176): the live dogma engine vs PYFA-recorded numbers
/// (`tools/pyfa-oracle/golden.json`, all-V, PYFA v2.67.0). Needs the
/// installed Fuzzwork SDE — point `EVE_SDE_PATH` at its `sde.sqlite`. Skips
/// (passes) when the SDE isn't available, e.g. in CI.
#[test]
fn golden_pyfa_fits() {
    let Some(path) = std::env::var_os("EVE_SDE_PATH") else {
        eprintln!("golden_pyfa_fits: EVE_SDE_PATH unset — skipping");
        return;
    };
    let path = std::path::PathBuf::from(&path);
    if !path.exists() {
        eprintln!("golden_pyfa_fits: {path:?} missing — skipping");
        return;
    }
    let sde = Sde::open(&path).expect("open sde");
    let dir = path.parent().unwrap();
    let tid = |name: &str| {
        sde.type_by_name(name)
            .unwrap()
            .unwrap_or_else(|| panic!("unknown type: {name}"))
            .0
    };
    let module = |name: &str, slot: SlotKind, charge: Option<&str>, idx: i32| FitItem {
        type_id: tid(name),
        slot,
        index: idx,
        state: ModuleState::Active,
        charge_type_id: charge.map(tid),
        quantity: 1,
        active_drones: None,
    };
    let drone = |name: &str, qty: i32| FitItem {
        type_id: tid(name),
        slot: SlotKind::Drone,
        index: 0,
        state: ModuleState::Active,
        charge_type_id: None,
        quantity: qty,
        active_drones: None,
    };
    let fit = |name: &str, items: Vec<FitItem>| Fit {
        id: "t".into(),
        name: name.into(),
        ship_type_id: tid(name),
        items,
        projected: Vec::new(),
    };
    // A fit with a projected module on it (#178).
    let fit_proj = |name: &str, proj: &str| Fit {
        id: "t".into(),
        name: name.into(),
        ship_type_id: tid(name),
        items: Vec::new(),
        projected: vec![module(proj, SlotKind::Mid, None, 0)],
    };

    struct Golden {
        dps: f64,
        ehp: f64,
        cap_stable: bool,
        /// Stable capacitor level (%) when stable.
        cap_pct: f64,
        /// Seconds to depletion when not stable (0 when stable).
        cap_depletion: f64,
        vel: f64,
        align: f64,
        /// Targeting lock range, metres (0 = not checked).
        lock_range: f64,
    }
    let cases: Vec<(&str, Fit, Golden)> = vec![
        (
            "Rifter",
            fit(
                "Rifter",
                vec![
                    module("200mm AutoCannon II", SlotKind::High, Some("Barrage S"), 0),
                    module("200mm AutoCannon II", SlotKind::High, Some("Barrage S"), 1),
                    module("200mm AutoCannon II", SlotKind::High, Some("Barrage S"), 2),
                    drone("Warrior II", 2),
                ],
            ),
            Golden {
                dps: 139.32,
                ehp: 2262.2,
                cap_stable: true,
                cap_pct: 100.0,
                cap_depletion: 0.0,
                vel: 456.25,
                align: 3.195,
                lock_range: 0.0,
            },
        ),
        (
            "Caracal",
            fit(
                "Caracal",
                (0..5)
                    .map(|i| {
                        module(
                            "Heavy Missile Launcher II",
                            SlotKind::High,
                            Some("Scourge Heavy Missile"),
                            i,
                        )
                    })
                    .collect(),
            ),
            Golden {
                dps: 165.32,
                ehp: 7765.2,
                cap_stable: true,
                cap_pct: 100.0,
                cap_depletion: 0.0,
                vel: 287.5,
                align: 5.238,
                lock_range: 0.0,
            },
        ),
        (
            "Vexor",
            fit("Vexor", vec![drone("Hammerhead II", 5)]),
            Golden {
                dps: 237.6,
                ehp: 9331.6,
                cap_stable: true,
                cap_pct: 100.0,
                cap_depletion: 0.0,
                vel: 243.75,
                align: 5.817,
                lock_range: 0.0,
            },
        ),
        (
            // Armor plate: exercises module armor HP (EHP) and the plate's
            // mass penalty on align time.
            "Rifter+plate",
            fit(
                "Rifter",
                vec![
                    module("200mm AutoCannon II", SlotKind::High, Some("Barrage S"), 0),
                    module("200mm AutoCannon II", SlotKind::High, Some("Barrage S"), 1),
                    module("200mm AutoCannon II", SlotKind::High, Some("Barrage S"), 2),
                    module("200mm Steel Plates II", SlotKind::Low, None, 0),
                    drone("Warrior II", 2),
                ],
            ),
            Golden {
                dps: 139.32,
                ehp: 3373.3,
                cap_stable: true,
                cap_pct: 100.0,
                cap_depletion: 0.0,
                vel: 456.25,
                align: 3.498,
                lock_range: 0.0,
            },
        ),
        (
            // Two omni armor resist amps: exercises the stacking penalty on
            // resonance attributes (the second module is penalized) → EHP.
            "Rifter+2xEANM",
            fit(
                "Rifter",
                vec![
                    module(
                        "Multispectrum Energized Membrane II",
                        SlotKind::Low,
                        None,
                        0,
                    ),
                    module(
                        "Multispectrum Energized Membrane II",
                        SlotKind::Low,
                        None,
                        1,
                    ),
                ],
            ),
            Golden {
                dps: 0.0,
                ehp: 2848.4,
                cap_stable: true,
                cap_pct: 100.0,
                cap_depletion: 0.0,
                vel: 456.25,
                align: 3.195,
                lock_range: 0.0,
            },
        ),
        (
            // Active armor repairer: drains more cap than the Rifter recharges,
            // so it's cap-*unstable* — exercises the depletion-time path.
            "Rifter+rep",
            fit(
                "Rifter",
                vec![module("Small Armor Repairer II", SlotKind::Low, None, 0)],
            ),
            Golden {
                dps: 0.0,
                ehp: 2262.2,
                cap_stable: false,
                cap_pct: 0.0,
                cap_depletion: 175.5,
                vel: 456.25,
                align: 3.195,
                lock_range: 0.0,
            },
        ),
        (
            // Afterburner: prop-mod velocity boost, the AB's cap drain
            // (stable below 100%), and its mass on align.
            "Rifter+AB",
            fit(
                "Rifter",
                vec![
                    module("200mm AutoCannon II", SlotKind::High, Some("Barrage S"), 0),
                    module("200mm AutoCannon II", SlotKind::High, Some("Barrage S"), 1),
                    module("200mm AutoCannon II", SlotKind::High, Some("Barrage S"), 2),
                    module("1MN Afterburner II", SlotKind::Mid, None, 0),
                    drone("Warrior II", 2),
                ],
            ),
            Golden {
                dps: 139.32,
                ehp: 2262.2,
                cap_stable: true,
                cap_pct: 95.51,
                cap_depletion: 0.0,
                vel: 1193.25,
                align: 4.692,
                lock_range: 0.0,
            },
        ),
        (
            // Laser turrets + a T1 frequency crystal: basic crystal damage path.
            "Punisher+MF",
            fit(
                "Punisher",
                (0..3)
                    .map(|i| {
                        module(
                            "Small Focused Pulse Laser II",
                            SlotKind::High,
                            Some("Multifrequency S"),
                            i,
                        )
                    })
                    .collect(),
            ),
            Golden {
                dps: 81.32,
                ehp: 2600.4,
                cap_stable: true,
                cap_pct: 90.29,
                cap_depletion: 0.0,
                vel: 443.75,
                align: 3.229,
                lock_range: 0.0,
            },
        ),
        (
            // Laser turrets + a T2 crystal (Conflagration): the crystal boosts
            // its host turret's damage — the charge→host (bidirectional) case.
            "Punisher+Conflag",
            fit(
                "Punisher",
                (0..3)
                    .map(|i| {
                        module(
                            "Small Focused Pulse Laser II",
                            SlotKind::High,
                            Some("Conflagration S"),
                            i,
                        )
                    })
                    .collect(),
            ),
            Golden {
                dps: 120.63,
                ehp: 2600.4,
                cap_stable: true,
                cap_pct: 87.76,
                cap_depletion: 0.0,
                vel: 443.75,
                align: 3.229,
                lock_range: 0.0,
            },
        ),
        (
            // Projected stasis web onto the Rifter: -60% velocity (#178).
            "Rifter<web",
            fit_proj("Rifter", "Stasis Webifier II"),
            Golden {
                dps: 0.0,
                ehp: 2262.2,
                cap_stable: true,
                cap_pct: 100.0,
                cap_depletion: 0.0,
                vel: 182.5,
                align: 3.195,
                lock_range: 0.0,
            },
        ),
        (
            // Projected sensor dampener: -15.3% lock range (#178).
            "Rifter<damp",
            fit_proj("Rifter", "Remote Sensor Dampener II"),
            Golden {
                dps: 0.0,
                ehp: 2262.2,
                cap_stable: true,
                cap_pct: 100.0,
                cap_depletion: 0.0,
                vel: 456.25,
                align: 3.195,
                lock_range: 23821.9,
            },
        ),
        (
            // Navigation implant: +3% velocity via a shipID effect (#178).
            "Rifter+implant",
            fit(
                "Rifter",
                vec![module(
                    "Eifyr and Co. 'Rogue' Navigation NN-603",
                    SlotKind::Implant,
                    None,
                    0,
                )],
            ),
            Golden {
                dps: 0.0,
                ehp: 2262.2,
                cap_stable: true,
                cap_pct: 100.0,
                cap_depletion: 0.0,
                vel: 469.938,
                align: 3.195,
                lock_range: 0.0,
            },
        ),
    ];

    let all5 = |_: i64| 5.0;
    let close = |a: f64, b: f64, pct: f64| (a - b).abs() <= b.abs() * pct + 1e-6;
    // Total DPS, EHP, velocity, align time and cap-stability are all at PYFA
    // parity on these fits and hard-asserted (#176).
    let mut failures = Vec::new();
    for (label, f, g) in &cases {
        let layout = sde.ship_layout(f.ship_type_id).unwrap().expect("layout");
        let d = run_dogma(
            &sde,
            dir,
            f,
            &layout,
            &all5,
            &DamageProfile::default(),
            0.0,
            None,
            &[],
            None,
            None,
            1.0,
            false, // factor_reload (#871)
        )
        .expect("dogma");
        let (dps, ehp, vel, align, stable) = (
            d.dps.total,
            d.tank.ehp,
            d.navigation.max_velocity,
            d.navigation.align_time,
            d.capacitor.stable,
        );
        let cap_pct = d.capacitor.stable_pct.unwrap_or(0.0);
        let depletion = d.capacitor.depletion_seconds.unwrap_or(0.0);
        let mut p = Vec::new();
        if !close(dps, g.dps, 0.005) {
            p.push(format!("dps {dps:.2}≠{:.2}", g.dps));
        }
        if !close(ehp, g.ehp, 0.01) {
            p.push(format!("ehp {ehp:.1}≠{:.1}", g.ehp));
        }
        if stable != g.cap_stable {
            p.push(format!("cap {stable}≠{}", g.cap_stable));
        }
        if stable && !close(cap_pct, g.cap_pct, 0.01) {
            p.push(format!("cap% {cap_pct:.2}≠{:.2}", g.cap_pct));
        }
        if !stable && !close(depletion, g.cap_depletion, 0.02) {
            p.push(format!(
                "cap-depletion {depletion:.1}≠{:.1}",
                g.cap_depletion
            ));
        }
        if !close(vel, g.vel, 0.005) {
            p.push(format!("vel {vel:.2}≠{:.2}", g.vel));
        }
        if !close(align, g.align, 0.005) {
            p.push(format!("align {align:.3}≠{:.3}", g.align));
        }
        if g.lock_range > 0.0 {
            let lr = d.targeting.lock_range;
            if !close(lr, g.lock_range, 0.005) {
                p.push(format!("lock {lr:.1}≠{:.1}", g.lock_range));
            }
        }
        if !p.is_empty() {
            failures.push(format!("{label}: {}", p.join(", ")));
        }
    }
    assert!(
        failures.is_empty(),
        "golden mismatches vs PYFA:\n{}",
        failures.join("\n"),
    );
}

/// Vedmak spool-up (#872): a Vedmak with a Heavy Entropic Disintegrator II
/// loaded with Occult M, run at 0% vs 100% spool. No Triglavian hull is in
/// `tools/pyfa-oracle/golden.json` yet (it predates #872), so per the
/// issue's documented fallback this is a hand-computed check instead of an
/// oracle-matched one: the weapon's own finalized
/// `damageMultiplierBonusMax`/`…PerCycle` (2.125 / 0.07 — real numbers from
/// PYFA v2.67.0's bundled SDE, cross-checked against `engine::spool`'s unit
/// tests) fully caps at 100% spool (`ceil(2.125 / 0.07) = 31` cycles ≥ max),
/// so the 100%-spooled turret DPS must be *exactly* `1 + 2.125 = 3.125×` the
/// 0%-spool (cold) turret DPS — a ratio that's independent of the hull's own
/// damage bonuses (skills, role bonus, …), which cancel out of it. Also
/// checks `is_spoolable` gates strictly on whether a spoolable weapon/rep is
/// actually fitted.
#[test]
fn vedmak_spool_up_matches_hand_computed_ratio() {
    let Some(path) = std::env::var_os("EVE_SDE_PATH") else {
        eprintln!("vedmak_spool_up_matches_hand_computed_ratio: EVE_SDE_PATH unset — skipping");
        return;
    };
    let path = std::path::PathBuf::from(&path);
    if !path.exists() {
        eprintln!("vedmak_spool_up_matches_hand_computed_ratio: {path:?} missing — skipping");
        return;
    }
    let sde = Sde::open(&path).expect("open sde");
    let dir = path.parent().unwrap();
    let tid = |name: &str| {
        sde.type_by_name(name)
            .unwrap()
            .unwrap_or_else(|| panic!("unknown type: {name}"))
            .0
    };
    let all5 = |_: i64| 5.0;
    let fit = Fit {
        id: "t".into(),
        name: "Vedmak".into(),
        ship_type_id: tid("Vedmak"),
        items: vec![FitItem {
            type_id: tid("Heavy Entropic Disintegrator II"),
            slot: SlotKind::High,
            index: 0,
            state: ModuleState::Active,
            charge_type_id: Some(tid("Occult M")),
            quantity: 1,
            active_drones: None,
        }],
        projected: Vec::new(),
    };
    let layout = sde.ship_layout(fit.ship_type_id).unwrap().expect("layout");
    let run = |spool_pct: f64| {
        run_dogma(
            &sde,
            dir,
            &fit,
            &layout,
            &all5,
            &DamageProfile::default(),
            0.0,
            None,
            &[],
            None,
            None,
            spool_pct,
            false, // factor_reload (#871)
        )
        .expect("dogma")
    };
    let cold = run(0.0);
    let spooled = run(1.0);
    assert!(
        cold.is_spoolable,
        "Vedmak + Entropic Disintegrator should be flagged spoolable"
    );
    assert!(
        cold.dps.turret > 0.0,
        "cold DPS should be nonzero: {}",
        cold.dps.turret
    );
    let ratio = spooled.dps.turret / cold.dps.turret;
    assert!(
        (ratio - 3.125).abs() < 1e-6,
        "100%-spooled/cold DPS ratio should be exactly 3.125, got {ratio}"
    );

    let unarmed = Fit {
        id: "t".into(),
        name: "Vedmak".into(),
        ship_type_id: tid("Vedmak"),
        items: Vec::new(),
        projected: Vec::new(),
    };
    let d = run_dogma(
        &sde,
        dir,
        &unarmed,
        &layout,
        &all5,
        &DamageProfile::default(),
        0.0,
        None,
        &[],
        None,
        None,
        1.0,
        false, // factor_reload (#871)
    )
    .expect("dogma");
    assert!(
        !d.is_spoolable,
        "an unarmed hull should not be flagged spoolable"
    );
}

/// Rapid Light Missile Launcher sustained DPS (#871) — the acceptance-
/// critical reload case, per the issue: no PYFA-oracle fixture exists for a
/// rapid-launcher fit yet (`tools/pyfa-oracle/golden.json` predates #871),
/// so per the issue's documented fallback (same one #872's spool-up test
/// used) this is a hand-computed check instead of an oracle-matched one.
///
/// Real Rapid Light Missile Launcher II / Scourge Light Missile attribute
/// values (PYFA v2.67.0's bundled SDE, cross-checked against everef.net):
/// launcher `capacity` (38) 0.3 m³, `reloadTime` (1795) 35s, base rate of
/// fire (51) 6.24s; missile `volume` (161) 0.015 m³ → a 20-shot clip
/// (`floor(0.3 / 0.015)`). Skills are held at zero (untrained skills are
/// skipped by the dogma engine entirely) so the finalized rate of fire stays
/// at the module's own base 6.24s, unaffected by the Rapid Launch skill's
/// RoF bonus — keeping the hand math exact. The sustained/burst DPS ratio
/// must then be exactly `(20×6.24) / (20×6.24 + 35) = 124.8 / 159.8`,
/// independent of any damage multiplier (which scales burst and sustained
/// identically and cancels out of the ratio). Burst DPS itself must be
/// bit-identical whether or not reload is factored in — the toggle only
/// gates the capacitor sim, never the DPS panel.
#[test]
fn rapid_light_missile_launcher_sustained_dps_matches_hand_computed_ratio() {
    let Some(path) = std::env::var_os("EVE_SDE_PATH") else {
        eprintln!(
            "rapid_light_missile_launcher_sustained_dps_matches_hand_computed_ratio: EVE_SDE_PATH unset — skipping"
        );
        return;
    };
    let path = std::path::PathBuf::from(&path);
    if !path.exists() {
        eprintln!(
            "rapid_light_missile_launcher_sustained_dps_matches_hand_computed_ratio: {path:?} missing — skipping"
        );
        return;
    }
    let sde = Sde::open(&path).expect("open sde");
    let dir = path.parent().unwrap();
    let tid = |name: &str| {
        sde.type_by_name(name)
            .unwrap()
            .unwrap_or_else(|| panic!("unknown type: {name}"))
            .0
    };
    // Untrained (level 0) skills are skipped entirely by the dogma engine —
    // avoids the Rapid Launch RoF bonus and any Caldari-cruiser missile
    // bonus confounding the hand-computed ratio below.
    let zero_skills = |_: i64| 0.0;
    let fit = Fit {
        id: "t".into(),
        name: "Caracal".into(),
        ship_type_id: tid("Caracal"),
        items: vec![FitItem {
            type_id: tid("Rapid Light Missile Launcher II"),
            slot: SlotKind::High,
            index: 0,
            state: ModuleState::Active,
            charge_type_id: Some(tid("Scourge Light Missile")),
            quantity: 1,
            active_drones: None,
        }],
        projected: Vec::new(),
    };
    let layout = sde.ship_layout(fit.ship_type_id).unwrap().expect("layout");
    let run = |factor_reload: bool| {
        run_dogma(
            &sde,
            dir,
            &fit,
            &layout,
            &zero_skills,
            &DamageProfile::default(),
            0.0,
            None,
            &[],
            None,
            None,
            1.0,
            factor_reload,
        )
        .expect("dogma")
    };
    let factored = run(true);
    let unfactored = run(false);

    assert!(
        factored.dps.missile > 0.0,
        "burst missile dps should be nonzero"
    );
    assert_eq!(
        factored.dps.missile, unfactored.dps.missile,
        "burst dps must be identical regardless of the factor_reload toggle"
    );
    let ratio = factored.dps_sustained.missile / factored.dps.missile;
    let expected = (20.0 * 6.24) / (20.0 * 6.24 + 35.0);
    assert!(
        (ratio - expected).abs() < 1e-6,
        "sustained/burst ratio should be {expected}, got {ratio}"
    );
}
