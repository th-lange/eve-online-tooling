//! Shared domain types reused across services and feature modules.

use serde::{Deserialize, Serialize};

/// A logged-in EVE character in the roster. The refresh token lives in the OS
/// keychain (keyed by `character_id`), never here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Character {
    pub character_id: i64,
    pub name: String,
    pub scopes: Vec<String>,
}

/// An (id, name) pair used across the SDE and market command surfaces
/// (camelCase for the UI).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdName {
    pub id: i64,
    pub name: String,
}

/// Converts raw `(id, name)` tuples into the serializable [`IdName`] pairs.
pub fn id_names(pairs: Vec<(i64, String)>) -> Vec<IdName> {
    pairs
        .into_iter()
        .map(|(id, name)| IdName { id, name })
        .collect()
}

/// A structured, serializable command error (#337). Serializes to
/// `{ "kind": …, "message": … }` so the frontend can tell an auth-required
/// state apart from a generic failure and show a clearer message, rather than
/// pattern-matching on a raw error string.
///
/// Commands return `Result<T, AppError>`; because `AppError: From<String>`, an
/// existing `.map_err(|e| e.to_string())?` inside such a command still works —
/// `?` wraps the string as [`AppError::Message`].
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum AppError {
    /// No character is logged in, or a required ESI scope isn't granted.
    AuthRequired { message: String },
    /// Any other failure, carrying a human-readable message.
    Message { message: String },
}

impl AppError {
    /// The standard "no character logged in" error. Generic failures use the
    /// `From<String>`/`From<&str>` conversions (so `?` wraps them automatically).
    pub fn auth_required() -> Self {
        AppError::AuthRequired {
            message: "Log in a character first".into(),
        }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AppError::AuthRequired { message } | AppError::Message { message } => {
                f.write_str(message)
            }
        }
    }
}

impl std::error::Error for AppError {}

impl From<String> for AppError {
    fn from(s: String) -> Self {
        AppError::Message { message: s }
    }
}

impl From<&str> for AppError {
    fn from(s: &str) -> Self {
        AppError::Message {
            message: s.to_string(),
        }
    }
}

#[cfg(test)]
mod error_tests {
    use super::AppError;

    #[test]
    fn auth_required_serializes_with_a_kind_tag() {
        let json = serde_json::to_string(&AppError::auth_required()).unwrap();
        assert!(json.contains("\"kind\":\"authRequired\""));
        assert!(json.contains("Log in a character first"));
    }

    #[test]
    fn a_string_error_becomes_a_message_variant() {
        let e: AppError = "boom".to_string().into();
        let json = serde_json::to_string(&e).unwrap();
        assert!(json.contains("\"kind\":\"message\""));
        assert!(json.contains("boom"));
    }
}
