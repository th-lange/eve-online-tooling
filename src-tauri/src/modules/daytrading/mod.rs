//! Daytrading module — inter-station arbitrage: buy at a source hub, haul, and
//! sell at a destination hub, ranked by ISK/m³. Persisted blacklist + favorites.

pub mod commands;
mod engine;
