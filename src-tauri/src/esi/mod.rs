//! EVE SSO authentication + ESI HTTP client and endpoint wrappers.
//!
//! Today this provides the unauthenticated [`EsiClient`] used by the market
//! service. Planned: OAuth2 PKCE login (loopback redirect), token refresh via
//! the OS keychain, and full error-budget-aware backoff.
//!
//! Tracking: issues #3 (SSO), #4 (assets/blueprints), #5 (market).

mod client;
mod error;

pub use client::EsiClient;
pub use error::EsiError;

/// ESI base URL. Endpoint paths include the version segment (e.g. `/latest`).
pub const ESI_BASE: &str = "https://esi.evetech.net";
