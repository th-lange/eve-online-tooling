//! Local persistence: per-character refresh tokens in the OS keychain, and the
//! character roster as a JSON file in the app data dir.

use std::path::Path;

use keyring::Entry;

use crate::model::Character;

/// Keychain service name (one keyed entry per character id).
const KEYCHAIN_SERVICE: &str = "com.thlange.eve-online-tooling";

fn entry(character_id: i64) -> Result<Entry, String> {
    Entry::new(KEYCHAIN_SERVICE, &character_id.to_string()).map_err(|e| e.to_string())
}

/// Store a character's refresh token in the OS keychain.
pub fn store_refresh_token(character_id: i64, token: &str) -> Result<(), String> {
    entry(character_id)?
        .set_password(token)
        .map_err(|e| e.to_string())
}

/// Load a character's refresh token, if present.
pub fn load_refresh_token(character_id: i64) -> Result<Option<String>, String> {
    match entry(character_id)?.get_password() {
        Ok(token) => Ok(Some(token)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Delete a character's refresh token (no-op if absent).
pub fn delete_refresh_token(character_id: i64) -> Result<(), String> {
    match entry(character_id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

fn roster_path(app_data_dir: &Path) -> std::path::PathBuf {
    app_data_dir.join("characters.json")
}

/// Load the character roster (empty if none/unreadable).
pub fn load_roster(app_data_dir: &Path) -> Vec<Character> {
    std::fs::read(roster_path(app_data_dir))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Persist the character roster.
pub fn save_roster(app_data_dir: &Path, roster: &[Character]) -> Result<(), String> {
    std::fs::create_dir_all(app_data_dir).map_err(|e| e.to_string())?;
    let data = serde_json::to_vec_pretty(roster).map_err(|e| e.to_string())?;
    std::fs::write(roster_path(app_data_dir), data).map_err(|e| e.to_string())
}

/// Load a persisted list of type ids (e.g. `blacklist`, `favorites`).
pub fn load_id_list(app_data_dir: &Path, name: &str) -> Vec<i64> {
    std::fs::read(app_data_dir.join(format!("{name}.json")))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

/// Persist a list of type ids.
pub fn save_id_list(app_data_dir: &Path, name: &str, ids: &[i64]) -> Result<(), String> {
    std::fs::create_dir_all(app_data_dir).map_err(|e| e.to_string())?;
    let data = serde_json::to_vec_pretty(ids).map_err(|e| e.to_string())?;
    std::fs::write(app_data_dir.join(format!("{name}.json")), data).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn id_list_round_trips() {
        let dir = std::env::temp_dir().join(format!("eve-list-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(load_id_list(&dir, "blacklist").is_empty());
        save_id_list(&dir, "blacklist", &[34, 35, 36]).unwrap();
        assert_eq!(load_id_list(&dir, "blacklist"), vec![34, 35, 36]);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn roster_round_trips() {
        let dir = std::env::temp_dir().join(format!("eve-roster-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        assert!(load_roster(&dir).is_empty());

        let roster = vec![
            Character {
                character_id: 1,
                name: "A".into(),
                scopes: vec!["publicData".into()],
            },
            Character {
                character_id: 2,
                name: "B".into(),
                scopes: vec![],
            },
        ];
        save_roster(&dir, &roster).unwrap();
        assert_eq!(load_roster(&dir), roster);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
