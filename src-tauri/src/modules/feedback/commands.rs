//! Tauri commands backing the Feedback module.
//!
//! One submission is a small, fixed record: what kind of feedback it is, which
//! module it is about, an optional star rating, the user's text, and — only if
//! they leave the box ticked — their character name so the maintainer can reply
//! by in-game EVE mail. Nothing else. No ESI data, no asset lists, no logs, no
//! character *id*; the payload is built in exactly one place ([`build_payload`])
//! and [`feedback_preview`] returns that same struct, so what the UI shows the
//! user before sending is the thing that gets sent, by construction rather than
//! by two implementations agreeing.
//!
//! Because the collection is write-only (see the module docs), the history the
//! user sees is a **local** mirror kept in the app data dir. That same list is
//! the retry queue: a send that fails offline is recorded `Pending`, and
//! [`feedback_retry_pending`] flushes it on the next visit to the page.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use super::firebase;
use super::now_secs;
use crate::model::AppError;
use crate::storage;

/// Storage document name (a JSON file in `<app data>/data/`).
const STORE_KEY: &str = "feedback_history";

/// Longest accepted free-text body. Mirrors the cap in `firestore.rules` — the
/// rule is the real gate, this one just gives a good error before the round
/// trip.
const MAX_BODY_LEN: usize = 4000;

/// Longest accepted module id. Registry ids are short slugs.
const MAX_MODULE_LEN: usize = 40;

/// Minimum gap between two submissions from one install, in seconds. Stops a
/// stuck button or an impatient double-click from filing the same report twice.
const MIN_INTERVAL_SECS: i64 = 30;

/// Most submissions one install may make per rolling day.
const MAX_PER_DAY: usize = 20;

/// How many local history entries to keep. Old entries are only a convenience
/// for the user (the real copy is server-side), so the list is bounded.
const HISTORY_CAP: usize = 200;

// --- Types ------------------------------------------------------------------

/// What sort of feedback this is. Mirrored by the `kind in [...]` check in
/// `firestore.rules`; adding a variant means updating the rules too.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FeedbackKind {
    Rating,
    Bug,
    Feature,
}

impl FeedbackKind {
    /// The wire spelling stored in Firestore.
    fn as_str(self) -> &'static str {
        match self {
            FeedbackKind::Rating => "rating",
            FeedbackKind::Bug => "bug",
            FeedbackKind::Feature => "feature",
        }
    }
}

/// Exactly what leaves the machine. Serialized to the UI as-is for the preview,
/// and field-for-field into the Firestore document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackPayload {
    pub kind: FeedbackKind,
    /// Registry module id (e.g. `"production"`), or `"general"` for feedback
    /// that isn't about one module.
    pub module: String,
    /// 1–5 stars, or 0 when this submission carries no rating.
    pub rating: i64,
    pub body: String,
    /// Character name, present only when the user left the box ticked.
    pub character: Option<String>,
    pub app_version: String,
    pub os: String,
    /// Anonymous Firebase uid. `None` in a preview before the first send, when
    /// no account has been minted yet.
    pub uid: Option<String>,
}

/// Whether a locally-recorded submission actually reached Firestore.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryStatus {
    Sent,
    Pending,
}

/// One row of the local history / retry queue.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackEntry {
    /// Local key, unique within this install.
    pub id: String,
    /// Firestore document id, once accepted — the reference the user can quote.
    pub doc_id: Option<String>,
    pub payload: FeedbackPayload,
    /// Epoch seconds this install first tried to send.
    pub submitted_at: i64,
    pub status: EntryStatus,
    /// Why the last attempt failed, when still `Pending`.
    pub error: Option<String>,
}

/// What the page needs to render before the user types anything.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackStatus {
    /// False in a build with no Firebase project wired up — the UI then offers
    /// the GitHub-issue route instead of a send button that cannot work.
    pub configured: bool,
    /// This build's version — the UI needs it for the GitHub-issue fallback.
    pub app_version: String,
    pub uid: Option<String>,
    /// Submissions still waiting to be delivered.
    pub pending: usize,
    /// Submissions made in the last rolling day (against [`MAX_PER_DAY`]).
    pub submitted_today: usize,
    /// Seconds until another submission is allowed; 0 when ready.
    pub cooldown_secs: i64,
}

/// The local store document.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Store {
    #[serde(default)]
    entries: Vec<FeedbackEntry>,
}

// --- Validation -------------------------------------------------------------

/// Reject a submission the security rules would reject anyway, with a message
/// worth showing. Pure, so the rules below are unit-tested rather than trusted.
fn validate(kind: FeedbackKind, module: &str, rating: i64, body: &str) -> Result<(), String> {
    if module.is_empty() || module.len() > MAX_MODULE_LEN {
        return Err("Pick a category.".into());
    }
    // Registry ids are lowercase slugs; anything else means the caller made it
    // up, and a free-form module would fragment the analysis.
    if !module
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
    {
        return Err("That category isn't a known module.".into());
    }
    if !(0..=5).contains(&rating) {
        return Err("A rating is between 1 and 5 stars.".into());
    }
    if kind == FeedbackKind::Rating && rating == 0 {
        return Err("Pick a star rating.".into());
    }
    if body.chars().count() > MAX_BODY_LEN {
        return Err(format!("Please keep it under {MAX_BODY_LEN} characters."));
    }
    // A rating can stand on its own; a bug or feature request with no text is
    // nothing anyone can act on.
    if kind != FeedbackKind::Rating && body.trim().is_empty() {
        return Err("Tell us a little about it first.".into());
    }
    Ok(())
}

/// Seconds the caller must still wait before submitting again, and whether the
/// daily cap is already spent. Split out from the command so both the status
/// query and the submit path use one implementation.
fn rate_limit(entries: &[FeedbackEntry], now: i64) -> (i64, usize) {
    let last = entries.iter().map(|e| e.submitted_at).max().unwrap_or(0);
    let cooldown = (last + MIN_INTERVAL_SECS - now).max(0);
    let day_ago = now - 86_400;
    let today = entries.iter().filter(|e| e.submitted_at > day_ago).count();
    (cooldown, today)
}

// --- Store helpers ----------------------------------------------------------

fn load_store(app: &AppHandle) -> Result<(std::path::PathBuf, Store), AppError> {
    let dir = storage::app_data_dir(app)?;
    let store = storage::load_data::<Store>(&dir, STORE_KEY).unwrap_or_default();
    Ok((dir, store))
}

fn save_store(dir: &std::path::Path, store: &mut Store) -> Result<(), AppError> {
    // Newest first, bounded — the authoritative copy lives server-side.
    store
        .entries
        .sort_by(|a, b| b.submitted_at.cmp(&a.submitted_at));
    store.entries.truncate(HISTORY_CAP);
    storage::save_data(dir, STORE_KEY, store)?;
    Ok(())
}

/// A local key for a history row. Random rather than sequential so it stays
/// unique even if the store is restored from a backup mid-session.
fn local_id() -> String {
    format!("{:016x}", rand::random::<u64>())
}

/// The active character's name, or `None` when nobody is logged in. Only the
/// *name* is ever read — never the id, which would be a stable public
/// identifier we have no use for.
fn character_name(dir: &std::path::Path) -> Option<String> {
    let id = storage::primary_character(dir)?;
    storage::character_names(dir).get(&id).cloned()
}

/// Assemble the record that will be sent. The single source of truth for the
/// payload — [`feedback_preview`] and [`feedback_submit`] both go through here,
/// so the preview cannot drift from reality.
fn build_payload(
    app: &AppHandle,
    dir: &std::path::Path,
    kind: FeedbackKind,
    module: &str,
    rating: i64,
    body: &str,
    attach_character: bool,
) -> FeedbackPayload {
    FeedbackPayload {
        kind,
        module: module.to_string(),
        rating,
        body: body.trim().to_string(),
        character: if attach_character {
            character_name(dir)
        } else {
            None
        },
        app_version: app.package_info().version.to_string(),
        os: std::env::consts::OS.to_string(),
        uid: firebase::cached_uid(),
    }
}

/// Try to deliver one payload, folding the outcome into `entry`.
async fn deliver(entry: &mut FeedbackEntry) {
    let payload = &entry.payload;
    match firebase::create(
        payload.kind.as_str(),
        &payload.module,
        payload.rating,
        &payload.body,
        payload.character.as_deref(),
        &payload.app_version,
        &payload.os,
    )
    .await
    {
        Ok((doc_id, uid)) => {
            entry.doc_id = Some(doc_id);
            entry.payload.uid = Some(uid);
            entry.status = EntryStatus::Sent;
            entry.error = None;
        }
        Err(message) => {
            entry.status = EntryStatus::Pending;
            entry.error = Some(message);
        }
    }
}

// --- Commands ---------------------------------------------------------------

/// Whether feedback can be sent from this build, plus the local queue state.
#[tauri::command]
pub fn feedback_status(app: AppHandle) -> Result<FeedbackStatus, AppError> {
    let (_, store) = load_store(&app)?;
    let (cooldown_secs, submitted_today) = rate_limit(&store.entries, now_secs());
    Ok(FeedbackStatus {
        configured: firebase::is_configured(),
        app_version: app.package_info().version.to_string(),
        uid: firebase::cached_uid(),
        pending: store
            .entries
            .iter()
            .filter(|e| e.status == EntryStatus::Pending)
            .count(),
        submitted_today,
        cooldown_secs,
    })
}

/// The exact record a submit with these arguments would upload. Backs the
/// "here's what gets sent" panel — nothing leaves the machine for this call.
#[tauri::command]
pub fn feedback_preview(
    app: AppHandle,
    kind: FeedbackKind,
    module: String,
    rating: i64,
    body: String,
    attach_character: bool,
) -> Result<FeedbackPayload, AppError> {
    let dir = storage::app_data_dir(&app)?;
    Ok(build_payload(
        &app,
        &dir,
        kind,
        &module,
        rating,
        &body,
        attach_character,
    ))
}

/// Validate, record locally, and try to upload. A network failure is *not* an
/// error: the entry is kept `Pending` and returned, so the user's words are
/// never lost to a dropped connection.
#[tauri::command]
pub async fn feedback_submit(
    app: AppHandle,
    kind: FeedbackKind,
    module: String,
    rating: i64,
    body: String,
    attach_character: bool,
) -> Result<FeedbackEntry, AppError> {
    validate(kind, &module, rating, &body)?;

    let (dir, mut store) = load_store(&app)?;
    let now = now_secs();
    let (cooldown, today) = rate_limit(&store.entries, now);
    if cooldown > 0 {
        return Err(format!("Just a moment — you can send again in {cooldown}s.").into());
    }
    if today >= MAX_PER_DAY {
        return Err("That's a lot of feedback for one day. Try again tomorrow.".into());
    }

    let mut entry = FeedbackEntry {
        id: local_id(),
        doc_id: None,
        payload: build_payload(&app, &dir, kind, &module, rating, &body, attach_character),
        submitted_at: now,
        status: EntryStatus::Pending,
        error: None,
    };
    deliver(&mut entry).await;

    store.entries.push(entry.clone());
    save_store(&dir, &mut store)?;
    Ok(entry)
}

/// This install's own submissions, newest first. Read from the local mirror —
/// the collection itself is not readable by anyone.
#[tauri::command]
pub fn feedback_history(app: AppHandle) -> Result<Vec<FeedbackEntry>, AppError> {
    let (_, store) = load_store(&app)?;
    Ok(store.entries)
}

/// Re-attempt every queued submission (called when the page opens). Returns the
/// updated history.
#[tauri::command]
pub async fn feedback_retry_pending(app: AppHandle) -> Result<Vec<FeedbackEntry>, AppError> {
    let (dir, mut store) = load_store(&app)?;
    if !firebase::is_configured() {
        return Ok(store.entries);
    }
    for entry in store.entries.iter_mut() {
        if entry.status == EntryStatus::Pending {
            deliver(entry).await;
        }
    }
    save_store(&dir, &mut store)?;
    Ok(store.entries)
}

/// Drop one local history row. Only the local mirror is affected — the
/// submitted document itself can't be recalled, which the UI says plainly.
#[tauri::command]
pub fn feedback_forget(app: AppHandle, id: String) -> Result<Vec<FeedbackEntry>, AppError> {
    let (dir, mut store) = load_store(&app)?;
    store.entries.retain(|e| e.id != id);
    save_store(&dir, &mut store)?;
    Ok(store.entries)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry_at(submitted_at: i64) -> FeedbackEntry {
        FeedbackEntry {
            id: local_id(),
            doc_id: None,
            payload: FeedbackPayload {
                kind: FeedbackKind::Bug,
                module: "general".into(),
                rating: 0,
                body: "x".into(),
                character: None,
                app_version: "0.0.0".into(),
                os: "linux".into(),
                uid: None,
            },
            submitted_at,
            status: EntryStatus::Sent,
            error: None,
        }
    }

    #[test]
    fn a_rating_needs_stars_but_no_words() {
        assert!(validate(FeedbackKind::Rating, "production", 4, "").is_ok());
        assert!(validate(FeedbackKind::Rating, "production", 0, "great").is_err());
    }

    #[test]
    fn a_bug_needs_words_but_no_stars() {
        assert!(validate(FeedbackKind::Bug, "production", 0, "it crashed").is_ok());
        assert!(validate(FeedbackKind::Bug, "production", 0, "   ").is_err());
    }

    #[test]
    fn general_is_a_valid_category() {
        assert!(validate(FeedbackKind::Feature, "general", 0, "dark mode").is_ok());
    }

    #[test]
    fn hyphenated_module_ids_are_accepted() {
        // Real registry ids look like this; rejecting them would silently make
        // whole modules un-reportable.
        assert!(validate(FeedbackKind::Bug, "faction-warfare", 0, "broken").is_ok());
    }

    #[test]
    fn made_up_categories_are_rejected() {
        assert!(validate(FeedbackKind::Bug, "", 0, "x").is_err());
        assert!(validate(FeedbackKind::Bug, "Production", 0, "x").is_err());
        assert!(validate(FeedbackKind::Bug, "prod uction", 0, "x").is_err());
        assert!(validate(FeedbackKind::Bug, &"a".repeat(41), 0, "x").is_err());
    }

    #[test]
    fn rating_stays_in_range() {
        assert!(validate(FeedbackKind::Rating, "general", 6, "").is_err());
        assert!(validate(FeedbackKind::Rating, "general", -1, "").is_err());
    }

    #[test]
    fn overlong_bodies_are_rejected_before_the_round_trip() {
        let long = "a".repeat(MAX_BODY_LEN + 1);
        assert!(validate(FeedbackKind::Bug, "general", 0, &long).is_err());
        let ok = "a".repeat(MAX_BODY_LEN);
        assert!(validate(FeedbackKind::Bug, "general", 0, &ok).is_ok());
    }

    #[test]
    fn body_length_is_counted_in_characters_not_bytes() {
        // A multi-byte body under the character cap must not be rejected for
        // being over the *byte* cap.
        let text = "\u{00e9}".repeat(MAX_BODY_LEN);
        assert!(text.len() > MAX_BODY_LEN);
        assert!(validate(FeedbackKind::Bug, "general", 0, &text).is_ok());
    }

    #[test]
    fn cooldown_counts_down_from_the_last_submission() {
        let now = 1_000_000;
        let (cooldown, today) = rate_limit(&[entry_at(now - 10)], now);
        assert_eq!(cooldown, MIN_INTERVAL_SECS - 10);
        assert_eq!(today, 1);
    }

    #[test]
    fn cooldown_is_clear_once_the_gap_has_passed() {
        let now = 1_000_000;
        let (cooldown, _) = rate_limit(&[entry_at(now - MIN_INTERVAL_SECS - 1)], now);
        assert_eq!(cooldown, 0);
    }

    #[test]
    fn an_empty_history_is_never_rate_limited() {
        let (cooldown, today) = rate_limit(&[], 1_000_000);
        assert_eq!(cooldown, 0);
        assert_eq!(today, 0);
    }

    #[test]
    fn the_daily_count_only_spans_a_rolling_day() {
        let now = 1_000_000;
        let entries = vec![entry_at(now - 100), entry_at(now - 86_500)];
        let (_, today) = rate_limit(&entries, now);
        assert_eq!(today, 1);
    }

    #[test]
    fn payload_serializes_with_the_field_names_the_rules_expect() {
        let payload = FeedbackPayload {
            kind: FeedbackKind::Feature,
            module: "trading".into(),
            rating: 0,
            body: "add a thing".into(),
            character: Some("Some Capsuleer".into()),
            app_version: "0.57.1".into(),
            os: "windows".into(),
            uid: Some("u1".into()),
        };
        let json = serde_json::to_value(&payload).expect("serializes");
        assert_eq!(json["kind"], "feature");
        assert_eq!(json["appVersion"], "0.57.1");
        assert_eq!(json["character"], "Some Capsuleer");
    }

    #[test]
    fn history_is_capped_and_newest_first() {
        let mut store = Store {
            entries: (0..HISTORY_CAP as i64 + 10).map(entry_at).collect(),
        };
        let dir = std::env::temp_dir().join(format!("eve-feedback-test-{}", local_id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        save_store(&dir, &mut store).expect("saves");
        assert_eq!(store.entries.len(), HISTORY_CAP);
        assert!(store.entries[0].submitted_at > store.entries[1].submitted_at);
        std::fs::remove_dir_all(&dir).ok();
    }
}
