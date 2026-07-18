//! Appraisal module — paste an inventory list and value it (buy & sell) at a
//! market, with total cargo volume.

pub mod commands;

// The pure resolve → price → value core, re-exported for other surfaces (the
// plugin/MCP `appraise` capability) so valuation rules live in one place.
pub use commands::{appraise, price_items, resolve_items, AppraisalItem};
