//! Shared domain types reused across services and feature modules.

use serde::{Deserialize, Serialize};

/// A logged-in EVE character in the roster. The refresh token lives in the OS
/// keychain (keyed by `character_id`), never here.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Character {
    pub character_id: i64,
    pub name: String,
    pub scopes: Vec<String>,
}

/// An (id, name) pair used across the SDE and market command surfaces
/// (camelCase for the UI).
#[derive(Debug, Clone, Serialize, specta::Type)]
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

/// Server-derived cache-freshness envelope (#885). Wraps command data with
/// the same `fetchedAt`/`expiresAt` deadline the backend's conditional
/// cache (`net::conditional_cache::ConditionalCache`, wrapped per-provider
/// by e.g. `esi::cache::ConditionalCache`) already computed from the
/// upstream `Cache-Control`/`Expires` headers, instead of the frontend
/// re-guessing a per-endpoint `staleTime` constant that drifts as those
/// headers change server-side.
///
/// Both timestamps are Unix epoch **milliseconds** (matching JS
/// `Date.now()`), so `DataAge` and `queryKeys.ts` can compare directly with
/// no unit conversion. `expires_at` is `None` when the underlying cache has
/// no persisted entry for this call (cache disabled, or nothing cached
/// yet) — callers fall back to their existing hand-set `staleTime`.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct Fresh<T> {
    pub data: T,
    pub fetched_at: i64,
    pub expires_at: Option<i64>,
}

impl<T> Fresh<T> {
    /// Wraps `data` with the current time as `fetchedAt` and `expires_at_secs`
    /// (a Unix-epoch-seconds deadline, as stored by `ConditionalCache`)
    /// converted to `expiresAt` milliseconds.
    pub fn new(data: T, expires_at_secs: Option<u64>) -> Self {
        Fresh {
            data,
            fetched_at: crate::util::time::now_secs() as i64 * 1000,
            expires_at: expires_at_secs.map(|secs| secs as i64 * 1000),
        }
    }
}

/// Records `name` in `failed` once, so a character that fails several calls in
/// one aggregation is still listed a single time.
pub fn note_failed_character(failed: &mut Vec<String>, name: &str) {
    if !failed.iter().any(|n| n == name) {
        failed.push(name.to_owned());
    }
}

/// Settle one character's fetch inside a per-character fan-out (#1169).
/// A success yields `Some(value)`. A failure while `aggregating` several
/// characters is recorded in `failed` and yields `None`, so the rest still show
/// and the UI can say who is missing; with a single target the failure is the
/// answer and is returned instead of an empty result masquerading as "no data".
pub fn settle_character_fetch<T, E>(
    result: Result<T, E>,
    aggregating: bool,
    character_name: &str,
    failed: &mut Vec<String>,
) -> Result<Option<T>, E> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(_) if aggregating => {
            note_failed_character(failed, character_name);
            Ok(None)
        }
        Err(e) => Err(e),
    }
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
mod fan_out_tests {
    use super::{note_failed_character, settle_character_fetch};

    #[test]
    fn aggregating_failure_is_recorded_and_skipped() {
        let mut failed = Vec::new();
        let ok = settle_character_fetch::<_, String>(Ok(1), true, "Alice", &mut failed);
        let bad = settle_character_fetch::<i32, _>(Err("403"), true, "Bob", &mut failed);
        assert_eq!(ok, Ok(Some(1)));
        assert_eq!(bad, Ok(None));
        assert_eq!(failed, vec!["Bob".to_string()]);
    }

    #[test]
    fn single_target_failure_propagates_and_is_not_listed() {
        let mut failed = Vec::new();
        let r = settle_character_fetch::<i32, _>(Err("403"), false, "Bob", &mut failed);
        assert_eq!(r, Err("403"));
        assert!(failed.is_empty());
    }

    #[test]
    fn a_character_is_listed_once() {
        let mut failed = Vec::new();
        note_failed_character(&mut failed, "Bob");
        note_failed_character(&mut failed, "Bob");
        note_failed_character(&mut failed, "Cy");
        assert_eq!(failed, vec!["Bob".to_string(), "Cy".to_string()]);
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
