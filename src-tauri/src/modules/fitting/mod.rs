//! Fitting module — ship-fit editor + (later) PYFA-grade dogma simulation.
//!
//! P1 builds the editor, slot/resource validation and whole-fit pricing on
//! *base* attributes; the dogma engine (DPS / tank / capacitor / navigation /
//! targeting, with stacking penalties and skill/ship bonuses) lands in P2 under
//! an `engine/` submodule. Modifier data comes from `dgmEffects.modifierInfo`
//! (the Fuzzwork dump ships `dgmExpressions` empty — see #157), exposed by the
//! SDE service as [`crate::sde::EffectMeta`].
//!
//! Tracking: epic #156.

pub mod commands;
mod context;
pub mod eft;
pub mod engine;
pub mod esi_fittings;
#[cfg(test)]
mod golden_tests;
pub mod optimizer;
mod stats;
pub mod types;

/// Curated cross-module surface: the PVP fit analyzer is fitting's only other
/// consumer, and it should reach the simulation engine through here rather than
/// poking into `commands` (the Tauri command layer) or `stats`/`engine` directly.
///
/// Deferred: if a third consumer shows up, promote `engine/` (12 files),
/// `stats.rs`, `types.rs` and `simulate_fit` out of `fitting` into a shared
/// `src-tauri/src/dogma/` service. Mechanical, since `simulate_fit` already
/// takes only `&Sde` + a skill closure — no Tauri/module-local state to
/// disentangle.
pub(crate) use stats::simulate_fit;
pub use types::{Fit, FitItem, FitStats, ModuleState, SlotKind};
