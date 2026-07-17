//! Notifications commands: read the character's notification feed, and dismiss
//! individual notifications locally.
//!
//! ESI has no "mark read" write, so dismissal is a local, durable per-character
//! set of hidden notification ids — the feed's "remove from the panel" action.

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::esi::{authed_get, resolve_names, AuthState};
use crate::model::AppError;
use crate::storage;

/// Split a PascalCase ESI notification type into words:
/// `StructureUnderAttack` → `Structure Under Attack`. Pure, so it's unit-tested.
pub fn humanize(kind: &str) -> String {
    let mut out = String::with_capacity(kind.len() + 4);
    let mut prev_lower = false;
    for ch in kind.chars() {
        if ch.is_uppercase() && prev_lower {
            out.push(' ');
        }
        out.push(ch);
        prev_lower = ch.is_lowercase() || ch.is_ascii_digit();
    }
    out
}

/// Bucket a notification type into a coarse category for filtering. Keyword
/// match on the type name (ESI has ~200 types); anything unmatched is "Other".
/// Pure, so it's unit-tested.
pub fn category(kind: &str) -> &'static str {
    let k = kind.to_ascii_lowercase();
    if k.contains("war") {
        "War"
    } else if k.contains("sov") || k.contains("entosis") || k.contains("tcu") {
        // Checked before "structure": sov notifications contain "structure" too.
        "Sovereignty"
    } else if k.contains("structure")
        || k.contains("tower")
        || k.contains("orbital")
        || k.contains("citadel")
    {
        "Structure"
    } else if k.contains("moon") || k.contains("extraction") || k.contains("industry") {
        "Industry"
    } else if k.contains("bounty") || k.contains("wallet") || k.contains("insurance") {
        "Wallet"
    } else if k.contains("corp") || k.contains("alliance") || k.contains("member") {
        "Corp"
    } else {
        "Other"
    }
}

/// Raw `/characters/{id}/notifications/` entry.
#[derive(Deserialize)]
struct EsiNotification {
    notification_id: i64,
    #[serde(default)]
    sender_id: i64,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    timestamp: String,
    #[serde(default)]
    is_read: bool,
    #[serde(default)]
    text: String,
}

/// One notification for display.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotifRow {
    pub id: i64,
    pub character_id: i64,
    pub character_name: String,
    /// Humanised type, e.g. "Structure Under Attack".
    pub title: String,
    pub category: String,
    pub sender: String,
    pub timestamp: String,
    pub is_read: bool,
    /// Raw notification body (YAML-ish key/values) for an expandable detail view.
    pub body: String,
}

/// The active character's notifications (every roster character's when "all
/// characters" is active, each row tagged with its owner), newest first, with
/// each character's own dismissed ids filtered out. Sender ids are resolved to
/// names in one batch. A character whose fetch fails is skipped rather than
/// failing the whole call.
#[tauri::command]
pub async fn notifications_list(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
) -> Result<Vec<NotifRow>, AppError> {
    let dir = crate::storage::app_data_dir(&app)?;
    let targets = storage::target_characters(&dir);
    if targets.is_empty() {
        return Err(AppError::auth_required());
    }
    let names_by_char = storage::character_names(&dir);

    let mut fetched: Vec<(i64, EsiNotification)> = Vec::new();
    for character_id in targets {
        let raw: Vec<EsiNotification> = match authed_get(
            &auth_state,
            character_id,
            &format!("/latest/characters/{character_id}/notifications/"),
        )
        .await
        {
            Ok(raw) => raw,
            Err(_) => continue,
        };

        let dismissed: Vec<i64> =
            storage::load_data(&dir, &format!("notifications_dismissed_{character_id}"))
                .unwrap_or_default();

        fetched.extend(
            raw.into_iter()
                .filter(|n| !dismissed.contains(&n.notification_id))
                .map(|n| (character_id, n)),
        );
    }

    let sender_ids: Vec<i64> = fetched.iter().map(|(_, n)| n.sender_id).collect();
    let names = resolve_names(&auth_state, &sender_ids).await;

    let mut rows: Vec<NotifRow> = fetched
        .into_iter()
        .map(|(character_id, n)| NotifRow {
            id: n.notification_id,
            character_id,
            character_name: names_by_char
                .get(&character_id)
                .cloned()
                .unwrap_or_default(),
            title: humanize(&n.kind),
            category: category(&n.kind).to_string(),
            sender: names
                .get(&n.sender_id)
                .cloned()
                .unwrap_or_else(|| "EVE System".to_string()),
            timestamp: n.timestamp,
            is_read: n.is_read,
            body: n.text,
        })
        .collect();
    // Newest first (ISO-8601 timestamps sort lexically).
    rows.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    Ok(rows)
}

/// Hide a notification from the feed (durable, per character). Under "all
/// characters" this applies to the primary (first) character.
#[tauri::command]
pub fn notifications_dismiss(app: AppHandle, notification_id: i64) -> Result<(), AppError> {
    let (dir, character_id) = storage::dir_and_primary_character(&app)?;
    let key = format!("notifications_dismissed_{character_id}");
    let mut dismissed: Vec<i64> = storage::load_data(&dir, &key).unwrap_or_default();
    if !dismissed.contains(&notification_id) {
        dismissed.push(notification_id);
        storage::save_data(&dir, &key, &dismissed)?;
    }
    Ok(())
}

/// Un-dismiss everything (clear the hidden set), so the full feed shows again.
/// Under "all characters" this applies to the primary (first) character.
#[tauri::command]
pub fn notifications_reset(app: AppHandle) -> Result<(), AppError> {
    let (dir, character_id) = storage::dir_and_primary_character(&app)?;
    let key = format!("notifications_dismissed_{character_id}");
    storage::save_data(&dir, &key, &Vec::<i64>::new())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{category, humanize};

    #[test]
    fn humanize_splits_pascal_case() {
        assert_eq!(humanize("StructureUnderAttack"), "Structure Under Attack");
        assert_eq!(humanize("WarDeclared"), "War Declared");
        assert_eq!(humanize("Simple"), "Simple");
    }

    #[test]
    fn category_buckets_by_keyword() {
        assert_eq!(category("WarDeclared"), "War");
        assert_eq!(category("StructureUnderAttack"), "Structure");
        assert_eq!(category("SovStructureDestroyed"), "Sovereignty");
        assert_eq!(category("MoonminingExtractionStarted"), "Industry");
        assert_eq!(category("InsurancePayoutMsg"), "Wallet");
        assert_eq!(category("CorpAppNewMsg"), "Corp");
        assert_eq!(category("SomethingElse"), "Other");
    }
}
