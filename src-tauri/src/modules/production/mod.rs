//! Production module — ranks manufacturable items by build-vs-buy profit.
//!
//! [`engine`] is the pure, unit-tested calculation; [`commands`] is the thin
//! orchestration that pulls SDE blueprint rows + market prices and ranks the
//! results. Modelled activity-aware and recursive so invention/T2 (#9) and
//! reactions/T3 (#10) are additive.
//!
//! Tracking: issues #6 (engine), #7 (UI), #9 (T2), #10 (T3/reactions).

pub mod commands;
mod engine;

/// Curated cross-module surface, mirroring fitting's `simulate_fit` pattern:
/// the MCP dev-tier `production_profit` capability needs the pure engine
/// directly (one blueprint, not the whole-catalogue ranking `commands`
/// exposes), without poking into `engine` from outside the module.
/// `required_quantity` is also the ME-rounding formula the Mass Production
/// module (#883) sums per owned blueprint copy.
pub(crate) use engine::{evaluate, manufacturing_step, required_quantity, ProfitConfig};
