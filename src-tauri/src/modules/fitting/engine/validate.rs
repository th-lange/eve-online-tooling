//! Slot/resource validation over base attributes (#165).
//!
//! Pure: the command layer resolves each fitted item's relevant base attributes
//! from the SDE into [`ValItem`]s, then calls [`validate`]. No dogma effects are
//! applied here — fitting-reduction skills/rigs (which lower CPU/PG use) arrive
//! with the dogma engine in P2, so a fit that is *just* within tolerance via
//! skills may show as slightly over here. The hard structural checks (slot and
//! hardpoint counts, drone bay) are exact regardless.

use crate::modules::fitting::types::{FitProblem, ResourceUsage, Severity, SlotKind};
use crate::sde::ShipLayout;

/// Tiny tolerance to avoid float-rounding false positives on resource caps.
const EPS: f64 = 1e-6;

/// One fitted item reduced to the attributes validation needs.
#[derive(Debug, Clone)]
pub struct ValItem {
    pub slot: SlotKind,
    /// CPU usage (attr 50), powergrid usage (attr 30), calibration cost (attr 1153).
    pub cpu: f64,
    pub powergrid: f64,
    pub calibration: f64,
    /// Whether the module occupies a turret/launcher hardpoint (effects 42/40).
    pub is_turret: bool,
    pub is_launcher: bool,
    /// Packaged volume of a single drone (m³); only meaningful for drone items.
    pub drone_volume: f64,
    /// Count (drones/charges); 1 for a single module.
    pub quantity: i32,
}

fn error(message: String) -> FitProblem {
    FitProblem {
        severity: Severity::Error,
        message,
        item_index: None,
    }
}

/// Validate a fit against its hull, returning resource usage and any problems.
pub fn validate(ship: &ShipLayout, items: &[ValItem]) -> (ResourceUsage, Vec<FitProblem>) {
    let mut problems = Vec::new();

    // Slot-count overflow (exact — base attributes give the true slot counts).
    for (slot, max, label) in [
        (SlotKind::High, ship.high_slots, "high"),
        (SlotKind::Mid, ship.mid_slots, "mid"),
        (SlotKind::Low, ship.low_slots, "low"),
        (SlotKind::Rig, ship.rig_slots, "rig"),
        (SlotKind::Subsystem, ship.subsystem_slots, "subsystem"),
        (SlotKind::Mode, ship.mode_slots, "mode"),
    ] {
        let used = items.iter().filter(|i| i.slot == slot).count() as i64;
        if used > max {
            problems.push(error(format!(
                "{used} {label} modules fitted but the hull has only {max} {label} slots"
            )));
        }
    }

    // Turret / launcher hardpoint overflow.
    let turrets = items.iter().filter(|i| i.is_turret).count() as i64;
    if turrets > ship.turret_hardpoints {
        problems.push(error(format!(
            "{turrets} turrets fitted but only {} turret hardpoints",
            ship.turret_hardpoints
        )));
    }
    let launchers = items.iter().filter(|i| i.is_launcher).count() as i64;
    if launchers > ship.launcher_hardpoints {
        problems.push(error(format!(
            "{launchers} launchers fitted but only {} launcher hardpoints",
            ship.launcher_hardpoints
        )));
    }

    // Resource usage (modules; drones/cargo contribute 0 to these).
    let cpu_used: f64 = items.iter().map(|i| i.cpu).sum();
    let powergrid_used: f64 = items.iter().map(|i| i.powergrid).sum();
    let calibration_used: f64 = items.iter().map(|i| i.calibration).sum();
    if cpu_used > ship.cpu_output + EPS {
        problems.push(error(format!(
            "CPU over by {:.1} tf",
            cpu_used - ship.cpu_output
        )));
    }
    if powergrid_used > ship.powergrid_output + EPS {
        problems.push(error(format!(
            "Powergrid over by {:.1} MW",
            powergrid_used - ship.powergrid_output
        )));
    }
    if calibration_used > ship.calibration + EPS {
        problems.push(error(format!(
            "Calibration over by {:.0}",
            calibration_used - ship.calibration
        )));
    }

    // Drone bay capacity (volume × count of drone items).
    let drone_volume: f64 = items
        .iter()
        .filter(|i| i.slot == SlotKind::Drone)
        .map(|i| i.drone_volume * i.quantity as f64)
        .sum();
    if drone_volume > ship.drone_bay + EPS {
        problems.push(error(format!(
            "Drone bay over by {:.0} m³",
            drone_volume - ship.drone_bay
        )));
    }

    let usage = ResourceUsage {
        cpu_used,
        cpu_output: ship.cpu_output,
        powergrid_used,
        powergrid_output: ship.powergrid_output,
        calibration_used,
        calibration_output: ship.calibration,
    };
    (usage, problems)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rifter() -> ShipLayout {
        ShipLayout {
            type_id: 587,
            name: "Rifter".into(),
            group_name: "Frigate".into(),
            high_slots: 3,
            mid_slots: 3,
            low_slots: 4,
            rig_slots: 3,
            subsystem_slots: 0,
            mode_slots: 0,
            turret_hardpoints: 3,
            launcher_hardpoints: 2,
            cpu_output: 130.0,
            powergrid_output: 41.0,
            calibration: 400.0,
            drone_bay: 10.0,
            drone_bandwidth: 0.0,
        }
    }

    fn turret(cpu: f64, pg: f64) -> ValItem {
        ValItem {
            slot: SlotKind::High,
            cpu,
            powergrid: pg,
            calibration: 0.0,
            is_turret: true,
            is_launcher: false,
            drone_volume: 0.0,
            quantity: 1,
        }
    }

    #[test]
    fn clean_fit_has_no_problems_and_sums_resources() {
        let items = vec![turret(10.0, 5.0), turret(10.0, 5.0)];
        let (usage, problems) = validate(&rifter(), &items);
        assert!(problems.is_empty());
        assert_eq!(usage.cpu_used, 20.0);
        assert_eq!(usage.powergrid_used, 10.0);
        assert_eq!(usage.cpu_output, 130.0);
    }

    #[test]
    fn flags_too_many_turrets_and_high_slots() {
        // 4 turrets in high slots: over both 3 high slots and 3 turret hardpoints.
        let items = vec![
            turret(1.0, 1.0),
            turret(1.0, 1.0),
            turret(1.0, 1.0),
            turret(1.0, 1.0),
        ];
        let (_usage, problems) = validate(&rifter(), &items);
        assert!(problems.iter().any(|p| p.message.contains("high slots")));
        assert!(problems
            .iter()
            .any(|p| p.message.contains("turret hardpoints")));
    }

    #[test]
    fn flags_cpu_and_calibration_overflow() {
        let mut items = vec![turret(200.0, 1.0)]; // 200 > 130 CPU
        items.push(ValItem {
            slot: SlotKind::Rig,
            cpu: 0.0,
            powergrid: 0.0,
            calibration: 500.0, // > 400 calibration
            is_turret: false,
            is_launcher: false,
            drone_volume: 0.0,
            quantity: 1,
        });
        let (_usage, problems) = validate(&rifter(), &items);
        assert!(problems.iter().any(|p| p.message.starts_with("CPU over")));
        assert!(problems
            .iter()
            .any(|p| p.message.starts_with("Calibration over")));
    }

    #[test]
    fn flags_overfull_drone_bay() {
        let items = vec![ValItem {
            slot: SlotKind::Drone,
            cpu: 0.0,
            powergrid: 0.0,
            calibration: 0.0,
            is_turret: false,
            is_launcher: false,
            drone_volume: 5.0,
            quantity: 5, // 25 m³ > 10 m³ bay
        }];
        let (_usage, problems) = validate(&rifter(), &items);
        assert!(problems
            .iter()
            .any(|p| p.message.contains("Drone bay over")));
    }
}
