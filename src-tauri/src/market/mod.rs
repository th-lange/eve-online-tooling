//! Market price service.
//!
//! Fetches ESI market orders (Jita / The Forge), daily history, and global
//! adjusted prices, and aggregates them into a multi-vector price model
//! (spot sell/buy, daily average, N-day moving average, volume, order count),
//! cached with ESI-aware TTLs.
//!
//! Tracking: issue #5. Consumed by the production engine (issue #6).

pub mod commands;

mod aggregate;
mod cache;
mod markets;
mod service;
mod types;

pub use markets::{default_market, market_by_id, Market};
pub use service::MarketService;
pub use types::PriceModel;
