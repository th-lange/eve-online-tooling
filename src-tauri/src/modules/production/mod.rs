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
