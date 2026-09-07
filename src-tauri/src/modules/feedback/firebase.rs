//! Minimal Firebase client for the feedback drop-box: anonymous sign-in plus a
//! single Firestore "create document" call, spoken over plain HTTPS.
//!
//! We deliberately do *not* depend on a Firebase SDK. The whole surface we need
//! is three REST endpoints:
//!
//! - `accounts:signUp`        — mint an anonymous account (identity toolkit)
//! - `token`                  — exchange a refresh token for a fresh ID token
//! - `documents/{collection}` — create one document (Firestore)
//!
//! The anonymous account's **refresh token is kept in the OS keychain**, so the
//! same install keeps the same `uid` across restarts. That is what lets the
//! maintainer see "these five reports are the same person" without ever
//! learning who that person is, and it is what a future per-uid rate-limit rule
//! would key on.

use std::sync::{LazyLock, Mutex};

use serde::Deserialize;
use serde_json::{json, Map, Value};

use super::commands::FeedbackPayload;
use super::now_secs;
use crate::storage;

/// Firebase project id. Baked in at build time from `EVE_TOOLING_FIREBASE_PROJECT_ID`
/// so release builds can inject it without a source edit; a build without it
/// simply reports "not configured" and the UI falls back to filing on GitHub.
const PROJECT_ID: &str = match option_env!("EVE_TOOLING_FIREBASE_PROJECT_ID") {
    Some(v) => v,
    None => "",
};

/// Firebase **web** API key. Not a secret — it identifies the project, and the
/// security rules decide what may be done with it. See the module docs.
const API_KEY: &str = match option_env!("EVE_TOOLING_FIREBASE_API_KEY") {
    Some(v) => v,
    None => "",
};

/// Firestore collection every submission lands in.
const COLLECTION: &str = "feedback";

/// Keychain entry holding the anonymous account's refresh token.
const REFRESH_TOKEN_SECRET: &str = "firebase_feedback_refresh_token";

/// Refresh an ID token this many seconds before it actually expires, so a
/// submission never races the expiry.
const TOKEN_SKEW_SECS: i64 = 60;

/// True when this build has a Firebase project wired up. When false every
/// submit path short-circuits and the UI offers the GitHub-issue fallback
/// instead of failing on a network call that could never work.
pub fn is_configured() -> bool {
    !PROJECT_ID.is_empty() && !API_KEY.is_empty()
}

/// A signed-in anonymous session: the bearer token plus the stable account id.
#[derive(Debug, Clone)]
pub struct Session {
    pub id_token: String,
    pub uid: String,
}

/// In-process cache of the current session, so a burst of submits performs one
/// sign-in rather than one per document. Guarded by a plain `Mutex`: it is only
/// ever held to read or replace the value, never across an `await`.
static SESSION: LazyLock<Mutex<Option<CachedSession>>> = LazyLock::new(|| Mutex::new(None));

#[derive(Debug, Clone)]
struct CachedSession {
    session: Session,
    /// Epoch seconds at which `id_token` stops being accepted.
    expires_at: i64,
}

/// The shared HTTP client (carries our contact User-Agent and the standard
/// connect/request timeouts, so a hung host can't stall a command).
static CLIENT: LazyLock<reqwest::Client> = LazyLock::new(|| {
    crate::esi::http_client_builder()
        .build()
        .expect("failed to build Firebase HTTP client")
});

// --- Auth -------------------------------------------------------------------

/// Shape of `accounts:signUp` — minting a brand-new anonymous account.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SignUpResponse {
    id_token: String,
    refresh_token: String,
    local_id: String,
    /// Lifetime in seconds, as a string (Google returns it that way).
    expires_in: String,
}

/// Shape of the secure-token exchange — trading a refresh token for a new ID
/// token. Note the snake_case field names: this endpoint is the one Google
/// serves in OAuth style, unlike the camelCase identity-toolkit ones.
#[derive(Debug, Deserialize)]
struct RefreshResponse {
    id_token: String,
    refresh_token: String,
    user_id: String,
    expires_in: String,
}

/// Google's error envelope, so a failure surfaces its actual reason rather
/// than a bare status code.
#[derive(Debug, Deserialize)]
struct GoogleError {
    error: GoogleErrorBody,
}

#[derive(Debug, Deserialize)]
struct GoogleErrorBody {
    message: String,
}

/// Turn a non-2xx response into a readable error, preferring Google's own
/// `error.message` when the body carries one.
async fn error_from(response: reqwest::Response) -> String {
    let status = response.status();
    let body = response.text().await.unwrap_or_default();
    match serde_json::from_str::<GoogleError>(&body) {
        Ok(parsed) => format!("{status}: {}", parsed.error.message),
        Err(_) if body.is_empty() => status.to_string(),
        Err(_) => format!("{status}: {body}"),
    }
}

/// Parse Google's string-typed `expiresIn` into an absolute epoch second,
/// applying [`TOKEN_SKEW_SECS`]. Falls back to a conservative 5 minutes when
/// the field is not a number, so a surprising value can't produce a token we
/// treat as valid forever.
fn expiry_from(expires_in: &str) -> i64 {
    let lifetime = expires_in.parse::<i64>().unwrap_or(300);
    now_secs() + (lifetime - TOKEN_SKEW_SECS).max(0)
}

/// Return a usable session, reusing the cached ID token when it is still fresh.
///
/// The ladder is: cached token → refresh token from the keychain → brand-new
/// anonymous account. A refresh token that Google has revoked (project deleted,
/// account purged) falls through to a fresh sign-up rather than failing.
async fn session() -> Result<Session, String> {
    if let Some(cached) = SESSION.lock().ok().and_then(|guard| guard.clone()) {
        if cached.expires_at > now_secs() {
            return Ok(cached.session);
        }
    }

    // A stored refresh token means this install already has an identity; keep
    // it so the uid stays stable.
    // A refresh token Google has revoked (project deleted, account purged)
    // falls through to a fresh sign-up rather than failing the submission.
    let stored = storage::load_secret(REFRESH_TOKEN_SECRET).ok().flatten();
    let fresh = match stored {
        Some(token) => refresh_session(&token).await.ok(),
        None => None,
    };

    let (session, expires_at, refresh_token) = match fresh {
        Some(v) => v,
        None => sign_up().await?,
    };

    // Best-effort: a keychain we can't write to (headless Linux CI, a locked
    // keyring) costs us a stable uid, not the submission itself.
    let _ = storage::store_secret(REFRESH_TOKEN_SECRET, &refresh_token);
    if let Ok(mut guard) = SESSION.lock() {
        *guard = Some(CachedSession {
            session: session.clone(),
            expires_at,
        });
    }
    Ok(session)
}

/// Mint a new anonymous account. Returns the session, its expiry and the
/// refresh token to persist.
async fn sign_up() -> Result<(Session, i64, String), String> {
    let url = format!("https://identitytoolkit.googleapis.com/v1/accounts:signUp?key={API_KEY}");
    let response = CLIENT
        .post(url)
        .json(&json!({ "returnSecureToken": true }))
        .send()
        .await
        .map_err(|e| format!("anonymous sign-in failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "anonymous sign-in failed — {}",
            error_from(response).await
        ));
    }
    let parsed: SignUpResponse = response
        .json()
        .await
        .map_err(|e| format!("unreadable sign-in response: {e}"))?;
    Ok((
        Session {
            id_token: parsed.id_token,
            uid: parsed.local_id,
        },
        expiry_from(&parsed.expires_in),
        parsed.refresh_token,
    ))
}

/// Exchange a stored refresh token for a fresh ID token.
async fn refresh_session(refresh_token: &str) -> Result<(Session, i64, String), String> {
    let url = format!("https://securetoken.googleapis.com/v1/token?key={API_KEY}");
    let response = CLIENT
        .post(url)
        .form(&[
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
        ])
        .send()
        .await
        .map_err(|e| format!("token refresh failed: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "token refresh failed — {}",
            error_from(response).await
        ));
    }
    let parsed: RefreshResponse = response
        .json()
        .await
        .map_err(|e| format!("unreadable refresh response: {e}"))?;
    Ok((
        Session {
            id_token: parsed.id_token,
            uid: parsed.user_id,
        },
        expiry_from(&parsed.expires_in),
        parsed.refresh_token,
    ))
}

/// The anonymous uid for this install, *without* performing a sign-in — `None`
/// until the first successful submit. Used to show the id in the payload
/// preview so the user sees exactly what a send would carry.
pub fn cached_uid() -> Option<String> {
    SESSION
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|c| c.session.uid.clone()))
}

// --- Firestore --------------------------------------------------------------

/// Firestore's REST body wraps every field in a one-key "typed value" object;
/// these three helpers are the only shapes we need.
fn string_value(v: &str) -> Value {
    json!({ "stringValue": v })
}

/// Integers cross the wire as *strings* in Firestore's JSON mapping.
fn integer_value(v: i64) -> Value {
    json!({ "integerValue": v.to_string() })
}

fn null_value() -> Value {
    json!({ "nullValue": null })
}

/// Build the Firestore document body for a submission.
///
/// Note what is *not* here: no timestamp. Firestore stamps every document with
/// a server-side `createTime`, which a client cannot forge or backdate — so
/// taking the client's word for the time would be strictly worse.
/// `uid` is passed separately because it is the *session's* account id, known
/// only once signed in — the payload's own `uid` is whatever the UI last saw.
pub fn document_fields(payload: &FeedbackPayload, uid: &str) -> Value {
    let mut fields = Map::new();
    fields.insert("kind".into(), string_value(payload.kind.as_str()));
    fields.insert("module".into(), string_value(&payload.module));
    fields.insert("rating".into(), integer_value(payload.rating));
    fields.insert("body".into(), string_value(&payload.body));
    fields.insert(
        "character".into(),
        match payload.character.as_deref() {
            Some(name) => string_value(name),
            None => null_value(),
        },
    );
    fields.insert("appVersion".into(), string_value(&payload.app_version));
    fields.insert("os".into(), string_value(&payload.os));
    fields.insert("uid".into(), string_value(uid));
    json!({ "fields": Value::Object(fields) })
}

/// Firestore returns the created document's resource path; we only want the
/// trailing id so the user has something short to quote.
fn document_id(resource_name: &str) -> String {
    resource_name
        .rsplit('/')
        .next()
        .unwrap_or(resource_name)
        .to_string()
}

#[derive(Debug, Deserialize)]
struct CreatedDocument {
    name: String,
}

/// Sign in (or reuse a session) and create one document. Returns the new
/// document's id and the uid it was attributed to.
pub async fn create(payload: &FeedbackPayload) -> Result<(String, String), String> {
    if !is_configured() {
        return Err("This build has no feedback endpoint configured.".into());
    }
    let session = session().await?;
    let document = document_fields(payload, &session.uid);
    let url = format!(
        "https://firestore.googleapis.com/v1/projects/{PROJECT_ID}/databases/(default)/documents/{COLLECTION}"
    );
    let response = CLIENT
        .post(url)
        .bearer_auth(&session.id_token)
        .json(&document)
        .send()
        .await
        .map_err(|e| format!("could not reach the feedback service: {e}"))?;
    if !response.status().is_success() {
        return Err(format!(
            "feedback was rejected — {}",
            error_from(response).await
        ));
    }
    let created: CreatedDocument = response
        .json()
        .await
        .map_err(|e| format!("unreadable response: {e}"))?;
    Ok((document_id(&created.name), session.uid))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::feedback::commands::FeedbackKind;

    /// A submission with everything filled in; tests tweak what they care about.
    fn payload(kind: FeedbackKind, character: Option<&str>, rating: i64) -> FeedbackPayload {
        FeedbackPayload {
            kind,
            module: "production".into(),
            rating,
            body: "boom".into(),
            character: character.map(str::to_string),
            app_version: "0.57.1".into(),
            os: "linux".into(),
            uid: None,
        }
    }

    #[test]
    fn integers_are_serialized_as_strings() {
        // Firestore's JSON mapping requires this; sending a bare number is
        // rejected with an unhelpful 400.
        assert_eq!(integer_value(5), json!({ "integerValue": "5" }));
    }

    #[test]
    fn document_wraps_every_field_in_a_typed_value() {
        let doc = document_fields(&payload(FeedbackKind::Bug, None, 0), "u1");
        let fields = doc["fields"].as_object().expect("fields object");
        assert_eq!(fields["kind"], json!({ "stringValue": "bug" }));
        assert_eq!(fields["module"], json!({ "stringValue": "production" }));
        assert_eq!(fields["rating"], json!({ "integerValue": "0" }));
        assert_eq!(fields["body"], json!({ "stringValue": "boom" }));
        assert_eq!(fields["appVersion"], json!({ "stringValue": "0.57.1" }));
        assert_eq!(fields["os"], json!({ "stringValue": "linux" }));
        // The session's uid wins over whatever the payload was carrying.
        assert_eq!(fields["uid"], json!({ "stringValue": "u1" }));
        // Exactly the key set `firestore.rules` pins with `hasOnly`.
        assert_eq!(fields.len(), 8);
        // An omitted character must be an explicit null, not a missing key —
        // the security rules pin the exact key set with `hasOnly`.
        assert_eq!(fields["character"], json!({ "nullValue": null }));
    }

    #[test]
    fn document_carries_the_character_when_attached() {
        let doc = document_fields(
            &payload(FeedbackKind::Rating, Some("Some Capsuleer"), 5),
            "u1",
        );
        assert_eq!(
            doc["fields"]["character"],
            json!({ "stringValue": "Some Capsuleer" })
        );
    }

    #[test]
    fn document_never_carries_a_client_timestamp() {
        // Firestore's server-side `createTime` is the record of when a
        // submission happened; a client-supplied time would be forgeable.
        let doc = document_fields(&payload(FeedbackKind::Bug, None, 0), "u1");
        let fields = doc["fields"].as_object().expect("fields object");
        assert!(!fields.contains_key("createdAt"));
        assert!(!fields.contains_key("created_at"));
    }

    #[test]
    fn document_id_is_the_last_path_segment() {
        assert_eq!(
            document_id("projects/p/databases/(default)/documents/feedback/AbC123"),
            "AbC123"
        );
        // Defensive: an unexpected shape yields the input rather than panicking.
        assert_eq!(document_id("AbC123"), "AbC123");
    }

    #[test]
    fn expiry_applies_the_skew_and_survives_garbage() {
        let now = now_secs();
        let expiry = expiry_from("3600");
        assert!(expiry >= now + 3600 - TOKEN_SKEW_SECS - 2);
        assert!(expiry <= now + 3600 - TOKEN_SKEW_SECS + 2);
        // A non-numeric lifetime must not become "never expires".
        assert!(expiry_from("soon") <= now_secs() + 300);
    }
}
