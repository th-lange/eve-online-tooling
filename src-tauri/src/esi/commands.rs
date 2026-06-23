//! Tauri command surface for EVE SSO (multi-character).

use tauri::{AppHandle, Manager, State};
use tauri_plugin_opener::OpenerExt;

use super::auth::{self, AuthState};
use crate::model::Character;
use crate::storage;

/// Log in (or re-authorize) a character via EVE SSO and add it to the roster.
/// Opens the browser and waits for the loopback redirect.
#[tauri::command]
pub async fn auth_login(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
) -> Result<Character, String> {
    let pkce = auth::generate_pkce();
    let csrf = auth::random_state();

    // Bind the loopback server before opening the browser so the redirect can't
    // arrive before we're listening.
    let server = auth::bind_loopback().map_err(|e| e.to_string())?;
    let url = auth::authorize_url(&pkce.challenge, &csrf);
    app.opener()
        .open_url(url, None::<&str>)
        .map_err(|e| e.to_string())?;

    // Wait for the redirect off the async runtime.
    let code = tokio::task::spawn_blocking(move || auth::capture_code(server, &csrf))
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?;

    let tokens = auth::exchange_code(auth_state.http(), &code, &pkce.verifier)
        .await
        .map_err(|e| e.to_string())?;
    let token_character =
        auth::character_from_token(&tokens.access_token).map_err(|e| e.to_string())?;

    // Persist the refresh token (keychain) and the roster (json), de-duping.
    storage::store_refresh_token(token_character.character_id, &tokens.refresh_token)?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
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
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(storage::load_roster(&dir))
}

/// Remove a character: drop it from the roster, delete its keychain entry, and
/// forget any cached token. Returns the updated roster.
#[tauri::command]
pub fn auth_logout(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
    character_id: i64,
) -> Result<Vec<Character>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut roster = storage::load_roster(&dir);
    roster.retain(|c| c.character_id != character_id);
    storage::save_roster(&dir, &roster)?;
    storage::delete_refresh_token(character_id)?;
    auth_state.forget(character_id);
    Ok(roster)
}
