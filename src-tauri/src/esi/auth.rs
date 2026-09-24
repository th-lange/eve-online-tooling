//! EVE SSO authentication surface: OAuth2 PKCE login (loopback redirect) plus
//! OS-keychain-backed token refresh.
//!
//! The actual work lives in two submodules along the natural seam in the
//! login flow — get tokens, then keep them warm:
//!
//! - [`oauth_exchange`]: PKCE challenge generation, the authorize URL, the
//!   loopback SSO redirect server, and the token-endpoint exchanges
//!   (authorization code and refresh token).
//! - [`token_cache`]: [`AuthState`], the in-memory access-token cache and
//!   per-character single-flighted refresh, backed by the OS keychain.

pub use super::oauth_exchange::{
    authorize_url, bind_loopback, capture_code, character_from_token, exchange_code, generate_pkce,
    random_state,
};
pub use super::token_cache::{cache_login_token, AuthState};

use crate::model::AppError;

#[derive(Debug, thiserror::Error)]
pub enum AuthError {
    #[error(transparent)]
    Http(#[from] reqwest::Error),
    #[error("login timed out")]
    Timeout,
    #[error("state mismatch (possible CSRF) — login aborted")]
    StateMismatch,
    #[error("could not parse the SSO token: {0}")]
    Jwt(String),
    #[error("loopback server error: {0}")]
    Server(String),
    #[error("character is not logged in")]
    NotLoggedIn,
    #[error("credential storage error: {0}")]
    Storage(String),
    #[error(transparent)]
    Esi(#[from] super::error::EsiError),
}

impl From<AuthError> for AppError {
    fn from(e: AuthError) -> Self {
        match &e {
            // No refresh token on file: the character isn't logged in.
            AuthError::NotLoggedIn => AppError::auth_required(),
            // A revoked/expired refresh token surfaces from the SSO token
            // endpoint as an HTTP 400 (`invalid_grant`) — same remedy as
            // `NotLoggedIn`: the user has to log in again.
            AuthError::Http(err) if err.status() == Some(reqwest::StatusCode::BAD_REQUEST) => {
                AppError::auth_required()
            }
            _ => AppError::Message {
                message: e.to_string(),
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn not_logged_in_converts_to_the_auth_required_kind() {
        // Commands returning AppError must propagate auth failures with `?`
        // (not stringify them), or the frontend's login prompt never fires.
        let converted: AppError = AuthError::NotLoggedIn.into();
        assert!(matches!(converted, AppError::AuthRequired { .. }));

        // A non-auth failure still degrades to a plain message.
        let other: AppError = AuthError::Jwt("bad token".into()).into();
        assert!(matches!(other, AppError::Message { .. }));
    }
}
