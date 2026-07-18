//! The Info Panel feed — a shared, rolling log of alarms and text messages that
//! **plugins and scripts** post to, surfaced on the Info Panel page under
//! Support.
//!
//! Entries persist to one durable JSON document (`info_entries`), newest kept,
//! capped so a chatty producer can't grow it without bound. Producers reach it
//! through [`push`]: scripts (which have an `AppHandle`) also emit an
//! `info://entry` event so the panel updates live; plugins (sandboxed, no app
//! handle) only persist, and the panel's poll picks those up.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::storage;

/// Storage document name.
const STORE_KEY: &str = "info_entries";
/// Most entries retained (oldest dropped past this).
const MAX_ENTRIES: usize = 200;
/// Longest message text kept.
const MAX_TEXT_LEN: usize = 2000;

/// Severity of an Info Panel entry.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Kind {
    /// A high-severity alert (highlighted in the panel).
    Alarm,
    /// A plain text message.
    Message,
}

/// One posted entry.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    /// Opaque unique id (stable list key).
    pub id: String,
    pub kind: Kind,
    pub text: String,
    /// Optional longer body — the "output" behind the headline (e.g. a computed
    /// value or list, often JSON). `None` for a plain one-line entry.
    #[serde(default)]
    pub detail: Option<String>,
    /// Who posted it, e.g. `script:my-script` or `plugin:pricing-model`.
    pub source: String,
    /// Epoch seconds when posted.
    pub at: u64,
}

/// Longest detail body kept.
const MAX_DETAIL_LEN: usize = 8000;

/// Append an entry to the feed (text/detail-capped, feed length-capped) and
/// return it. Persists only — callers with an `AppHandle` emit `info://entry`
/// separately.
pub fn push(
    app_data_dir: &Path,
    kind: Kind,
    text: &str,
    detail: Option<&str>,
    source: &str,
) -> Entry {
    let mut entries: Vec<Entry> = storage::load_data(app_data_dir, STORE_KEY).unwrap_or_default();
    let mut text = text.to_string();
    // Char-boundary-safe: producer text is untrusted and may be non-ASCII;
    // a plain `String::truncate` panics mid-character.
    crate::util::text::truncate_to_char_boundary(&mut text, MAX_TEXT_LEN);
    let detail = detail.map(|d| {
        let mut d = d.to_string();
        crate::util::text::truncate_to_char_boundary(&mut d, MAX_DETAIL_LEN);
        d
    });
    let entry = Entry {
        id: format!("{:016x}", rand::random::<u64>()),
        kind,
        text,
        detail,
        source: source.to_string(),
        at: crate::util::time::now_secs(),
    };
    entries.push(entry.clone());
    if entries.len() > MAX_ENTRIES {
        let excess = entries.len() - MAX_ENTRIES;
        entries.drain(0..excess);
    }
    let _ = storage::save_data(app_data_dir, STORE_KEY, &entries);
    entry
}

/// The feed, newest first.
#[tauri::command]
pub fn info_list(app: AppHandle) -> Result<Vec<Entry>, String> {
    let dir = crate::storage::app_data_dir(&app)?;
    let mut entries: Vec<Entry> = storage::load_data(&dir, STORE_KEY).unwrap_or_default();
    entries.reverse();
    Ok(entries)
}

/// Empty the feed.
#[tauri::command]
pub fn info_clear(app: AppHandle) -> Result<(), String> {
    let dir = crate::storage::app_data_dir(&app)?;
    storage::save_data(&dir, STORE_KEY, &Vec::<Entry>::new())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp() -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("info-test-{}", rand::random::<u64>()));
        let _ = std::fs::remove_dir_all(&d);
        d
    }

    #[test]
    fn push_appends_and_reads_back() {
        let dir = tmp();
        push(&dir, Kind::Message, "hello", None, "script:a");
        push(&dir, Kind::Alarm, "danger", Some("stack trace"), "plugin:b");
        let mut all: Vec<Entry> = storage::load_data(&dir, STORE_KEY).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].text, "hello");
        assert_eq!(all[0].detail, None);
        assert_eq!(all[1].detail.as_deref(), Some("stack trace"));
        all.clear();
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn feed_is_capped_to_the_maximum() {
        let dir = tmp();
        for i in 0..(MAX_ENTRIES + 25) {
            push(&dir, Kind::Message, &format!("m{i}"), None, "script:a");
        }
        let all: Vec<Entry> = storage::load_data(&dir, STORE_KEY).unwrap();
        assert_eq!(all.len(), MAX_ENTRIES);
        // Oldest dropped: the first surviving entry is m25.
        assert_eq!(all[0].text, "m25");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
