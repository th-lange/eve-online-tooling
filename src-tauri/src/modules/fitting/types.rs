//! Shared domain types for the fitting module.
//!
//! [`Fit`] is the editable document (also the EFT/ESI import target and the
//! local-storage record); [`FitStats`] is the computed result the engine
//! produces. P1 populates `resources`, `validation` and `price`; the dogma
//! engine (P2) fills the combat/tank/cap fields as they land.

use serde::{Deserialize, Serialize};

/// Where a fitted item sits on the hull.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SlotKind {
    High,
    Mid,
    Low,
    Rig,
    Subsystem,
    Drone,
    Implant,
    Booster,
    Cargo,
}

/// A module's activation state (affects which effects apply and its resource use).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ModuleState {
    Offline,
    Online,
    Active,
    Overheated,
}

fn one() -> i32 {
    1
}

/// One fitted item: a module/rig/subsystem/drone slot entry, optionally with a
/// loaded charge.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FitItem {
    pub type_id: i64,
    pub slot: SlotKind,
    /// Position within its slot kind (0-based).
    pub index: i32,
    pub state: ModuleState,
    /// Loaded charge/ammo/script, if any.
    #[serde(default)]
    pub charge_type_id: Option<i64>,
    /// Drones/charges count; 1 for a single module.
    #[serde(default = "one")]
    pub quantity: i32,
}

/// The editable fit document. `id` is a stable key for local storage; `items`
/// holds every fitted module/rig/drone/charge-bearing entry.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Fit {
    pub id: String,
    pub name: String,
    pub ship_type_id: i64,
    #[serde(default)]
    pub items: Vec<FitItem>,
}

/// Severity of a [`FitProblem`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Severity {
    Error,
    /// Non-blocking advisory (e.g. a soft cap); emitted as the engine grows.
    #[allow(dead_code)]
    Warning,
}

/// A validation finding (over-CPU, too many turrets, calibration overflow, …).
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FitProblem {
    pub severity: Severity,
    pub message: String,
    /// The offending `items` index, when the problem is item-specific.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub item_index: Option<i32>,
}

/// Fitting-resource usage vs the hull's output (#165 fills this from base attrs).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResourceUsage {
    pub cpu_used: f64,
    pub cpu_output: f64,
    pub powergrid_used: f64,
    pub powergrid_output: f64,
    pub calibration_used: f64,
    pub calibration_output: f64,
}

/// Capacitor stability (#172), computed from finalized attributes.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CapStats {
    pub capacity: f64,
    pub recharge_seconds: f64,
    /// Peak recharge rate (GJ/s) — the stability threshold.
    pub peak_recharge: f64,
    /// Steady cap use (GJ/s) from active modules.
    pub drain: f64,
    pub stable: bool,
    /// Stable cap level (%) when `stable`; `None` when it runs dry.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub stable_pct: Option<f64>,
    /// Seconds until the capacitor empties when **not** stable; `None` when stable.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub depletion_seconds: Option<f64>,
}

/// Tank: HP, resists, EHP and local reps (#173). Resist arrays are
/// `[em, thermal, kinetic, explosive]` fractions (0.0–1.0).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TankStats {
    pub shield_hp: f64,
    pub armor_hp: f64,
    pub hull_hp: f64,
    /// Effective HP against the chosen damage profile (default even 25/25/25/25).
    pub ehp: f64,
    pub shield_resists: [f64; 4],
    pub armor_resists: [f64; 4],
    pub hull_resists: [f64; 4],
    pub shield_rep_s: f64,
    pub armor_rep_s: f64,
}

/// Full-application DPS by weapon kind (#174).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DpsBreakdown {
    pub turret: f64,
    pub missile: f64,
    pub drone: f64,
    pub total: f64,
}

/// Navigation: speed, agility, align and signature (#175).
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NavStats {
    pub max_velocity: f64,
    pub align_time: f64,
    pub agility: f64,
    pub signature_radius: f64,
}

/// Targeting: locks, range, scan resolution and sensor strength (#175).
/// `sensor_strength` is `[radar, ladar, magnetometric, gravimetric]`.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetStats {
    pub max_targets: i64,
    pub lock_range: f64,
    pub scan_resolution: f64,
    pub sensor_strength: [f64; 4],
}

/// Computed result of simulating a fit. Filled incrementally: P1 populates
/// `resources`, `validation` and `price`; the dogma engine (P2) adds capacitor,
/// tank, DPS, navigation and targeting.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FitStats {
    pub resources: ResourceUsage,
    pub validation: Vec<FitProblem>,
    /// Capacitor stability (#172); `None` until the dogma engine runs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub capacitor: Option<CapStats>,
    /// Tank (#173); `None` until the dogma engine runs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tank: Option<TankStats>,
    /// DPS (#174); `None` until the dogma engine runs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub dps: Option<DpsBreakdown>,
    /// Navigation (#175); `None` until the dogma engine runs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub navigation: Option<NavStats>,
    /// Targeting (#175); `None` until the dogma engine runs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub targeting: Option<TargetStats>,
    /// Whole-fit market value (#163); `None` until priced.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price: Option<f64>,
}

/// Whole-fit market valuation (#163): hull + modules + charges + drones/cargo.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FitPrice {
    /// Total cost to buy the whole fit now (Σ qty × sell-min).
    pub buy_total: f64,
    /// Total liquidation value of the whole fit now (Σ qty × buy-max).
    pub sell_total: f64,
    pub lines: Vec<FitPriceLine>,
}

/// One priced line of a [`FitPrice`].
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FitPriceLine {
    pub type_id: i64,
    pub name: String,
    pub quantity: i32,
    /// Per-unit buy price (sell-min) and liquidation price (buy-max).
    pub buy_unit: Option<f64>,
    pub sell_unit: Option<f64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The domain types round-trip through JSON with camelCase keys and the
    /// `quantity` default — the contract the frontend `api.ts` wrappers rely on.
    #[test]
    fn fit_round_trips_through_json() {
        let fit = Fit {
            id: "abc".into(),
            name: "Test Rifter".into(),
            ship_type_id: 587,
            items: vec![FitItem {
                type_id: 519,
                slot: SlotKind::Low,
                index: 0,
                state: ModuleState::Online,
                charge_type_id: None,
                quantity: 1,
            }],
        };
        let json = serde_json::to_string(&fit).unwrap();
        assert!(json.contains("\"shipTypeId\":587"));
        assert!(json.contains("\"slot\":\"low\""));
        let back: Fit = serde_json::from_str(&json).unwrap();
        assert_eq!(fit, back);

        // `quantity` defaults to 1 and `chargeTypeId` is optional on input.
        let item: FitItem =
            serde_json::from_str(r#"{"typeId":2456,"slot":"high","index":0,"state":"active"}"#)
                .unwrap();
        assert_eq!(item.quantity, 1);
        assert_eq!(item.charge_type_id, None);
    }
}
