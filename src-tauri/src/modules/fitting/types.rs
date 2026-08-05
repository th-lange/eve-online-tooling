//! Shared domain types for the fitting module.
//!
//! [`Fit`] is the editable document (also the EFT/ESI import target and the
//! local-storage record); [`FitStats`] is the computed result the dogma
//! engine produces: resources, validation, price, capacitor, tank, DPS,
//! navigation and targeting.

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
    /// How many of this drone stack are declared active (deployed), 0..=quantity;
    /// `None` = not yet customized, defaulting to as many as the ship's drone
    /// bandwidth and the 5-active-drones limit allow. Only meaningful for
    /// `slot == Drone`.
    #[serde(default)]
    pub active_drones: Option<i32>,
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
    /// Modules projected **onto** this fit (webs/paints/damps/…) — incoming
    /// effects from a notional attacker, modelled at all-V (#178).
    #[serde(default)]
    pub projected: Vec<FitItem>,
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
    /// Sampled cap level over time as `(seconds, percent)` from full — settles at
    /// the stable level, or declines to empty when unstable. For the UI chart.
    pub trajectory: Vec<(f64, f64)>,
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
    /// Active local reps per second (shield boosters / armor repairers).
    pub shield_rep_s: f64,
    pub armor_rep_s: f64,
    /// Peak passive shield regeneration (GJ/s ≈ HP/s): 2.5 × shield HP ÷ recharge.
    pub passive_shield_s: f64,
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

/// Engagement range of one fitted weapon/mining module, after skills + ammo.
/// Keyed by `(type_id, charge_type_id)` since identical loadouts share a range.
#[derive(Debug, Clone, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeaponRange {
    pub type_id: i64,
    pub charge_type_id: Option<i64>,
    /// Optimal range (m). For missiles this is the flight range (falloff 0); for
    /// mining lasers it's their reach.
    pub optimal: f64,
    pub falloff: f64,
}

/// Target profile for applied-DPS calculation (#701). Signature radius and
/// speed feed the missile explosion-velocity comparison directly; turret
/// tracking uses `angular_velocity` (rad/s) as given, rather than deriving a
/// worst-case value from speed ÷ distance — distance is swept separately by
/// the DPS-vs-range curve, which applies this same (distance-independent)
/// angular velocity at every sampled range.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TargetProfile {
    /// Signature radius (m).
    pub sig_radius: f64,
    /// Speed (m/s) — compared against a missile's explosion velocity, and
    /// (when the toggles below are set) against drones'/missiles' own speed.
    pub speed: f64,
    /// Angular velocity (rad/s) — drives turret tracking loss directly. A
    /// drone that can't keep pace (see `drones_keep_pace` below) derives its
    /// *own* worst-case angular velocity from the target's actual `speed`
    /// instead of this field, since a drone's engagement distance is
    /// synthetic (its own optimal range) rather than a swept/user input —
    /// this is what makes an inescapably fast target crush a slow drone's
    /// application toward zero rather than being capped by whatever value
    /// happens to be set here for turrets.
    pub angular_velocity: f64,
    /// Drones at or above the target's speed assume perfect application
    /// (skip the tracking formula entirely) instead of a plain tracking-loss
    /// calc — mirrors PYFA's "auto" drone mode ("hard to simulate drone
    /// behavior, so assume chance to hit is 1 for mobile drones which catch
    /// up with target"). A drone slower than the target still runs the
    /// tracking formula (driven by `speed`, see `angular_velocity`).
    pub drones_keep_pace: bool,
    /// Missiles slower than the target's own speed (attr 37, the missile's
    /// flight velocity — not `explosionVelocity`) can never catch it: zero
    /// application, instead of the explosion-velocity-only reduction.
    /// PYFA doesn't model this; off by default to match it.
    pub missiles_need_overtake: bool,
}

/// Which Abyssal Deadspace weather a fit is sitting in (#env-selector). See
/// [`AbyssalWeatherSelection`] and `engine::abyssal` — these bonus/penalty
/// magnitudes are hardcoded from community reference data, not the SDE
/// (Abyssal weather has no dogma-attribute representation there at all,
/// unlike Pochven metaliminal storms).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum AbyssalWeather {
    Dark,
    Electrical,
    Exotic,
    Firestorm,
    Gamma,
}

/// An Abyssal Deadspace weather + its penalty severity. Each weather's
/// bonus is a fixed 50% regardless of tier; only the penalty scales:
///
/// | Weather | Penalty | Bonus |
/// |---|---|---|
/// | Dark | −tier% turret optimal + falloff range | +50% max velocity |
/// | Electrical | −tier% EM resist (shield/armor/hull) | −50% cap recharge time |
/// | Exotic | −tier% kinetic resist (shield/armor/hull) | +50% scan resolution |
/// | Firestorm | −tier% thermal resist (shield/armor/hull) | +50% armor HP |
/// | Gamma | −tier% explosive resist (shield/armor/hull) | +50% shield HP |
#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AbyssalWeatherSelection {
    pub weather: AbyssalWeather,
    /// Penalty magnitude (%) — commonly 30/50/70 per filament tier, but any
    /// value is accepted (the frontend offers those three as presets).
    pub tier_pct: f64,
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

/// Computed result of simulating a fit: resources, validation and price come
/// from the command layer; the dogma engine fills capacitor, tank, DPS,
/// navigation and targeting (`None` until it runs — see `fitting_simulate`).
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
    /// Resolved slot layout — T3 subsystems grant slots (#178); `None` until the
    /// dogma engine runs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub layout: Option<crate::sde::ShipLayout>,
    /// Targeting (#175); `None` until the dogma engine runs.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub targeting: Option<TargetStats>,
    /// Whole-fit market value (#163); `None` until priced.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub price: Option<f64>,
    /// Per-weapon engagement ranges (turrets/missiles/mining), after skills/ammo.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub weapon_ranges: Vec<WeaponRange>,
    /// Type ids of fitted modules that can be activated (everything else is
    /// passive, so the UI shows it no active/inactive state).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub activatable_types: Vec<i64>,
    /// Electronic-warfare projected **onto** this fit, by category (#265). A
    /// presence indicator only — no magnitude — for EW types we don't model
    /// numerically (and a label for the ones we do).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub projected_ew: Vec<EwTag>,
    /// Authoritative active (deployed) count per fitted item, parallel to the
    /// fit's `items` by index — `None` for non-drone items. Clamped to what the
    /// ship's drone bandwidth and the 5-active-drones limit actually allow, in
    /// fit order; this is what `dps` reflects. Empty when the fit carries no
    /// drones (or the dogma engine hasn't run).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub drone_active: Vec<Option<i32>>,
    /// How many of each fitted drone stack *could ever* be active on this
    /// hull, parallel to `items` — `None` for non-drone items. The star-count
    /// display cap: some hulls only support a couple of a bandwidth-hungry
    /// drone type even though the 5-in-space limit would allow more.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub drone_max_active: Vec<Option<i32>>,
    /// Applied DPS against the supplied target profile (#701); `None` when no
    /// target profile was given.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub applied_dps: Option<DpsBreakdown>,
    /// DPS-over-range curve: `(distance_m, total_applied_dps)` sampled at 30
    /// points from 0 to the fit's maximum effective range. Empty when no
    /// target profile was given.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub dps_range_curve: Vec<(f64, f64)>,
}

/// One category of electronic warfare projected onto the fit (presence only).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EwTag {
    /// Stable category key: `web`, `paint`, `damp`, `weaponDisruption`, `ecm`,
    /// `neut`, `nos`.
    pub category: String,
    /// Human label for the badge.
    pub label: String,
    /// How many projected modules of this category are present.
    pub count: i64,
    /// True for the categories whose magnitude the engine actually models
    /// (web/paint/damp) — their numeric effect is already in the stats.
    pub modeled: bool,
    /// True for ECM — shown as an opt-in "jammed" scenario, never as a passive
    /// continuous effect.
    pub jam: bool,
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
                active_drones: None,
            }],
            projected: Vec::new(),
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
