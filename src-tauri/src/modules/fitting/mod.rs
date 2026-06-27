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
pub mod eft;
pub mod engine;
pub mod esi_fittings;
pub mod types;
