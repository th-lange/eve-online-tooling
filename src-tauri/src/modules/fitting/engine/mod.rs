//! Fitting calculation engine.
//!
//! P1 ships [`validate`] — pure slot/resource validation over *base* attributes
//! (no dogma effects yet), correct enough to flag over-CPU/PG, slot/hardpoint
//! overflow and an over-full drone bay. The dogma simulation (DPS, tank,
//! capacitor, …, with stacking penalties and skill/ship bonuses) lands here in
//! P2 alongside this module.

pub mod attr;
pub mod capacitor;
pub mod damage;
pub mod effects;
pub mod modifier;
pub mod resolve;
pub mod stacking;
pub mod tank;
pub mod validate;
