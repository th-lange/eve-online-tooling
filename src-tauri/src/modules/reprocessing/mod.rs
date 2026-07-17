//! Reprocessing module — ranks ores by reprocess-vs-sell (refine value vs the
//! ore's own market price), with EVE's stacked efficiency model.

pub mod commands;
mod engine;

/// Curated cross-module surface: the MCP dev-tier `reprocessing_yield`
/// capability needs the pure per-item engine directly, without the
/// whole-catalogue ranking `commands::reprocessing_scan` does.
pub(crate) use engine::{evaluate, ore_efficiency, EfficiencyConfig};
