//! Market price service.
//!
//! Fetches ESI market orders (Jita / The Forge), daily history, and global
//! adjusted prices, and aggregates them into a multi-vector price model
//! (spot sell/buy, daily average, N-day moving average, volume, order count),
//! cached with ESI-aware TTLs.
//!
//! Tracking: issue #5. Consumed by the production engine (issue #6).

pub mod commands;
pub mod orders;

mod aggregate;
mod cache;
mod flight;
mod fuzzwork;
mod markets;
mod service;
mod types;

pub use markets::{default_region_id, jita_location, location_label, regions, resolve_location};
pub use service::{MarketService, PriceMap, TradedStats};
// `BestSell` is returned by a MarketService method and reached through its
// return type; it doesn't need a named re-export.
pub use types::PriceModel;
