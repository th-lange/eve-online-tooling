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
            f,
            &layout,
            &all5,
            &DamageProfile::default(),
            0.0,
            None,
            &[],
            None,
            None,
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
