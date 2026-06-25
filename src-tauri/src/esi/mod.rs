//! EVE SSO authentication + ESI HTTP client and endpoint wrappers.
//!
//! Today this provides the unauthenticated [`EsiClient`] used by the market
//! service. Planned: OAuth2 PKCE login (loopback redirect), token refresh via
//! the OS keychain, and full error-budget-aware backoff.
//!
//! Tracking: issues #3 (SSO), #4 (assets/blueprints), #5 (market).

mod auth;
mod character;
mod client;
pub mod commands;
mod error;

pub use auth::{AuthError, AuthState};
pub use character::{
    authed_get, authed_get_paged_pub, corporation_id, fetch_assets, resolve_names,
};
pub use client::EsiClient;
pub use error::EsiError;

/// ESI base URL. Endpoint paths include the version segment (e.g. `/latest`).
pub const ESI_BASE: &str = "https://esi.evetech.net";

/// Descriptive User-Agent sent with all outbound HTTP. ESI asks third-party
/// apps to send one, and some hosts (e.g. Fuzzwork) reject requests without it.
pub const USER_AGENT: &str = concat!(
    "eve-online-tooling/",
    env!("CARGO_PKG_VERSION"),
    " (+https://github.com/th-lange/eve-online-tooling)"
);
