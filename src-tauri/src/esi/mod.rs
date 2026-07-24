//! EVE SSO authentication + ESI HTTP client and endpoint wrappers.
//!
//! Today this provides the unauthenticated [`EsiClient`] used by the market
//! service. Planned: OAuth2 PKCE login (loopback redirect), token refresh via
//! the OS keychain, and full error-budget-aware backoff.
//!
//! Tracking: issues #3 (SSO), #4 (assets/blueprints), #5 (market).

mod auth;
mod cache;
mod character;
mod client;
pub mod commands;
mod error;
mod net;
mod universe;

pub use auth::AuthState;
#[cfg(test)]
pub(crate) use cache::ConditionalCache;
pub use character::{
    authed_get, authed_get_paged_or_empty_on_403, authed_get_paged_pub, character_affiliation,
    character_skill_levels, corporation_id, create_character_fitting, fetch_assets,
    fetch_character_fittings, fetch_corp_assets, fetch_corp_fittings, fetch_killmail,
    resolve_character_ids, resolve_names, set_autopilot_waypoint, CharacterAffiliation, EsiFitting,
    SkillLevels,
};
pub use client::EsiClient;
pub use error::EsiError;
pub use net::fetch_json_url;
pub use universe::{system_kills, SystemKills};

/// ESI base URL. Endpoint paths include the version segment (e.g. `/latest`).
pub const ESI_BASE: &str = "https://esi.evetech.net";

/// Descriptive User-Agent sent with all outbound HTTP. ESI asks third-party
/// apps to send one, and some hosts (e.g. Fuzzwork) reject requests without it.
pub const USER_AGENT: &str = concat!(
    "eve-online-tooling/",
    env!("CARGO_PKG_VERSION"),
    " (+https://github.com/th-lange/eve-online-tooling)"
);

/// Time allowed to establish a TCP/TLS connection.
pub const HTTP_CONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(10);
/// Total time allowed for a request, response body included.
pub const HTTP_REQUEST_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(30);

/// The reqwest builder every outbound client starts from: our User-Agent plus
/// connect/total timeouts. reqwest applies *no* timeout by default, so a
/// client built without these hangs a Tauri command forever when a host
/// black-holes — build on this instead of `reqwest::Client::builder()`.
pub fn http_client_builder() -> reqwest::ClientBuilder {
    reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .connect_timeout(HTTP_CONNECT_TIMEOUT)
        .timeout(HTTP_REQUEST_TIMEOUT)
}
