//! Tauri command surface for EVE SSO (multi-character).

use serde::Serialize;
use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

use super::auth::{self, AuthState};
use super::character;
use crate::model::Character;
use crate::storage;

/// Log in (or re-authorize) a character via EVE SSO and add it to the roster.
/// Opens the browser and waits for the loopback redirect.
#[tauri::command]
pub async fn auth_login(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
) -> Result<Character, crate::model::AppError> {
    let pkce = auth::generate_pkce();
    let csrf = auth::random_state();

    // Bind the loopback server before opening the browser so the redirect can't
    // arrive before we're listening.
    let server = auth::bind_loopback()?;
    let url = auth::authorize_url(&pkce.challenge, &csrf);
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())?;

    // Wait for the redirect off the async runtime.
    let code = tokio::task::spawn_blocking(move || auth::capture_code(server, &csrf))
        .await
        .map_err(|e| e.to_string())??;

    let tokens = auth::exchange_code(
        auth_state.http(),
        auth_state.token_url(),
        &code,
        &pkce.verifier,
    )
    .await?;
    let token_character = auth::character_from_token(&tokens.access_token)?;

    // Persist the refresh token (keychain) and the roster (json), de-duping.
    storage::store_refresh_token(token_character.character_id, &tokens.refresh_token)?;
    let dir = crate::storage::app_data_dir(&app)?;
    let character = Character {
        character_id: token_character.character_id,
        name: token_character.name,
        scopes: token_character.scopes,
    };
    let mut roster = storage::load_roster(&dir);
    roster.retain(|c| c.character_id != character.character_id);
    roster.push(character.clone());
    storage::save_roster(&dir, &roster)?;

    auth::cache_login_token(&auth_state, &character, &tokens);
    Ok(character)
}

/// The current character roster.
#[tauri::command]
pub fn auth_characters(app: AppHandle) -> Result<Vec<Character>, String> {
    let dir = crate::storage::app_data_dir(&app)?;
    Ok(storage::load_roster(&dir))
}

/// Bookmark the "active" character used by per-character features (industry
/// jobs, route, etc.).
#[tauri::command]
pub fn auth_set_active_character(app: AppHandle, character_id: i64) -> Result<(), String> {
    let dir = crate::storage::app_data_dir(&app)?;
    storage::save_active_character(&dir, character_id)
}

/// The active character id (bookmarked if set + in roster, else the first).
#[tauri::command]
pub fn auth_active_character(app: AppHandle) -> Result<Option<i64>, String> {
    let dir = crate::storage::app_data_dir(&app)?;
    Ok(storage::active_character(&dir))
}

/// A blueprint owned by a character (or their corporation), with its real
/// ME/TE/runs.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OwnedBlueprint {
    pub character_id: i64,
    pub character_name: String,
    /// True for a corporation blueprint, false for a personal one.
    pub corporation: bool,
    pub type_id: i64,
    /// Blueprint name (resolved from the SDE), e.g. "Hobgoblin II Blueprint".
    pub name: String,
    pub material_efficiency: i64,
    pub time_efficiency: i64,
    pub runs: i64,
    pub quantity: i64,
}

/// All blueprints owned across the whole roster — personal **and** corporation
/// (where the character has the Director role + corp scope). A character whose
/// token can't be refreshed is skipped rather than failing the whole call.
#[tauri::command]
pub async fn esi_owned_blueprints(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
) -> Result<Vec<OwnedBlueprint>, String> {
    let dir = crate::storage::app_data_dir(&app)?;
    let roster = storage::load_roster(&dir);

    // Characters have independent refresh tokens, so their ESI fetches are
    // safe to run concurrently instead of one-at-a-time.
    let fetches = roster.into_iter().map(|c| {
        let auth_state = &auth_state;
        async move {
            let to_owned = |b: character::RawBlueprint, corporation: bool| OwnedBlueprint {
                character_id: c.character_id,
                character_name: c.name.clone(),
                corporation,
                type_id: b.type_id,
                name: String::new(),
                material_efficiency: b.material_efficiency,
                time_efficiency: b.time_efficiency,
                runs: b.runs,
                quantity: b.quantity,
            };

            let mut owned = Vec::new();
            if let Ok(blueprints) = character::fetch_blueprints(auth_state, c.character_id).await
            {
                owned.extend(blueprints.into_iter().map(|b| to_owned(b, false)));
            }
            // Corp blueprints (empty if the character lacks the role/scope).
            if let Ok(corp_id) = character::corporation_id(auth_state, c.character_id).await {
                if let Ok(blueprints) =
                    character::fetch_corp_blueprints(auth_state, c.character_id, corp_id).await
                {
                    owned.extend(blueprints.into_iter().map(|b| to_owned(b, true)));
                }
            }
            owned
        }
    });
    let mut out: Vec<OwnedBlueprint> = futures_util::future::join_all(fetches)
        .await
        .into_iter()
        .flatten()
        .collect();

    // Resolve blueprint names from the SDE (cached per type id).
    if let Ok(sde) = crate::sde::open_from_dir(&dir) {
        let mut names: std::collections::HashMap<i64, String> = std::collections::HashMap::new();
        for bp in &mut out {
            let name = names
                .entry(bp.type_id)
                .or_insert_with(|| sde.type_name_or_id(bp.type_id));
            bp.name = name.clone();
        }
    }
    Ok(out)
}

/// Total owned quantity per type across the **whole roster** (personal assets),
/// for stock-aware production. Durably cached for 10 minutes so repeated builds
/// don't re-hit ESI. Characters whose fetch fails (e.g. an expired token) are
/// skipped from the totals, but such a *partial* result is never cached — the
/// next call retries instead of serving wrong stock counts for the full TTL.
#[tauri::command]
pub async fn esi_roster_stock(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
) -> Result<std::collections::HashMap<i64, i64>, String> {
    let dir = crate::storage::app_data_dir(&app)?;
    if let Some(cached) =
        storage::cache_get::<std::collections::HashMap<i64, i64>>(&dir, "roster_stock")
    {
        return Ok(cached);
    }
    let mut stock: std::collections::HashMap<i64, i64> = std::collections::HashMap::new();
    // Track whether every character contributed. One failed fetch means the
    // totals are incomplete, and incomplete totals must not be cached below.
    let mut complete = true;
    // Characters have independent refresh tokens, so their ESI fetches are
    // safe to run concurrently instead of one-at-a-time.
    let fetches = storage::load_roster(&dir)
        .into_iter()
        .map(|c| character::fetch_assets(&auth_state, c.character_id));
    for result in futures_util::future::join_all(fetches).await {
        match result {
            Ok(assets) => {
                for a in assets {
                    *stock.entry(a.type_id).or_default() += a.quantity;
                }
            }
            // Best-effort: still return what we could count, but remember
            // that this snapshot is partial.
            Err(_) => complete = false,
        }
    }
    cache_stock_if_complete(&dir, &stock, complete);
    Ok(stock)
}

/// Cache the roster stock totals — but **only when every character's fetch
/// succeeded**. The old code cached unconditionally, so a single failed
/// character (one alt's token expired, a network blip) froze silently-wrong
/// stock counts for the full 10-minute TTL, corrupting stock-aware production
/// math with no signal to the user. Skipping the write on a partial snapshot
/// means the next `roster_stock` call misses the cache and retries the failed
/// characters. Split out of `roster_stock` so the rule is unit-testable
/// without a network or a Tauri `AppHandle`.
fn cache_stock_if_complete(
    dir: &std::path::Path,
    stock: &std::collections::HashMap<i64, i64>,
    complete: bool,
) {
    if complete {
        let _ = storage::cache_put(dir, "roster_stock", stock, 600);
    }
}

/// Open the in-game market window for a type, using the active character (the
/// one whose orders are shown). Requires the `esi-ui.open_window.v1` scope
/// (re-login if added).
#[tauri::command]
pub async fn esi_open_market_window(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
    type_id: i64,
) -> Result<(), crate::model::AppError> {
    let (_, character_id) = storage::dir_and_primary_character(&app)?;
    character::open_market_window(&auth_state, character_id, type_id).await?;
    Ok(())
}

/// Open the in-game "Show Info" window for a character/corporation/alliance
/// id, using the active character. Requires the `esi-ui.open_window.v1` scope
/// (re-login if added). Used e.g. by the "Support my corp" link.
#[tauri::command]
pub async fn esi_open_info_window(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
    target_id: i64,
) -> Result<(), crate::model::AppError> {
    let (_, character_id) = storage::dir_and_primary_character(&app)?;
    character::open_info_window(&auth_state, character_id, target_id).await?;
    Ok(())
}

/// Best-effort startup warm-up: pull the active character's assets so the
/// ESI conditional cache is primed and Production/Assets open without waiting on
/// a cold network fetch. Silent on any failure (offline, no character, etc.).
pub async fn warm_active_character(app: &AppHandle) {
    let Ok(dir) = crate::storage::app_data_dir(app) else {
        return;
    };
    let Some(character_id) = storage::primary_character(&dir) else {
        return;
    };
    let auth = app.state::<AuthState>();
    let _ = character::fetch_assets(&auth, character_id).await;
}

/// Remove a character: drop it from the roster, delete its keychain entry, and
/// forget any cached token. Returns the updated roster.
#[tauri::command]
pub fn auth_logout(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
    character_id: i64,
) -> Result<Vec<Character>, String> {
    let dir = crate::storage::app_data_dir(&app)?;
    let mut roster = storage::load_roster(&dir);
    roster.retain(|c| c.character_id != character_id);
    storage::save_roster(&dir, &roster)?;
    storage::delete_refresh_token(character_id)?;
    auth_state.forget(character_id);
    Ok(roster)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    #[test]
    fn partial_roster_stock_is_not_cached() {
        // Pin the #612 fix: totals missing a character (a failed fetch) must
        // not be cached, or stock-aware production math would be silently
        // wrong for the full 10-minute TTL.
        let dir = std::env::temp_dir().join(format!("roster-stock-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let stock = HashMap::from([(34_i64, 1_000_i64)]);
        // Partial snapshot (complete = false): nothing is written, so the
        // next roster_stock call misses the cache and retries.
        cache_stock_if_complete(&dir, &stock, false);
        assert_eq!(
            storage::cache_get::<HashMap<i64, i64>>(&dir, "roster_stock"),
            None
        );
        // Complete snapshot: cached as before.
        cache_stock_if_complete(&dir, &stock, true);
        assert_eq!(
            storage::cache_get::<HashMap<i64, i64>>(&dir, "roster_stock"),
            Some(stock)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
