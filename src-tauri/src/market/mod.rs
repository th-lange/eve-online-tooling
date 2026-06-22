//! Market price service.
//!
//! Planned: fetch + aggregate ESI market orders (Jita/The Forge) and history
//! into a multi-vector price model (spot sell/buy, daily average, N-day moving
//! average, volume), cached with ESI-aware TTLs.
//!
//! Tracking: issue #5.
