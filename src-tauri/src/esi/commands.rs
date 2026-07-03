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
) -> Result<Character, String> {
    let pkce = auth::generate_pkce();
    let csrf = auth::random_state();

    // Bind the loopback server before opening the browser so the redirect can't
    // arrive before we're listening; use whichever port it bound for the URL.
    let (server, port) = auth::bind_loopback().map_err(|e| e.to_string())?;
    let url = auth::authorize_url(&pkce.challenge, &csrf, port);
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

/// Bookmark the "active" character used by per-character features (industry
/// jobs, route, etc.).
#[tauri::command]
pub fn set_active_character(app: AppHandle, character_id: i64) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    storage::save_active_character(&dir, character_id)
}

/// The active character id (bookmarked if set + in roster, else the first).
#[tauri::command]
pub fn active_character(app: AppHandle) -> Result<Option<i64>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
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
pub async fn owned_blueprints(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
) -> Result<Vec<OwnedBlueprint>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let roster = storage::load_roster(&dir);
    let mut out = Vec::new();
    for c in roster {
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

        if let Ok(blueprints) = character::fetch_blueprints(&auth_state, c.character_id).await {
            out.extend(blueprints.into_iter().map(|b| to_owned(b, false)));
        }
        // Corp blueprints (empty if the character lacks the role/scope).
        if let Ok(corp_id) = character::corporation_id(&auth_state, c.character_id).await {
            if let Ok(blueprints) =
                character::fetch_corp_blueprints(&auth_state, c.character_id, corp_id).await
            {
                out.extend(blueprints.into_iter().map(|b| to_owned(b, true)));
            }
        }
    }

    // Resolve blueprint names from the SDE (cached per type id).
    if let Ok(sde) = crate::sde::Sde::open(&crate::sde::SdePaths::new(dir).db) {
        let mut names: std::collections::HashMap<i64, String> = std::collections::HashMap::new();
        for bp in &mut out {
            let name = names.entry(bp.type_id).or_insert_with(|| {
                sde.type_info(bp.type_id)
                    .ok()
                    .flatten()
                    .map(|t| t.name)
                    .unwrap_or_else(|| format!("Type {}", bp.type_id))
            });
            bp.name = name.clone();
        }
    }
    Ok(out)
}

/// A character's assets (type id, quantity, location).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub type_id: i64,
    pub quantity: i64,
    pub location_id: i64,
}

/// Assets for one character.
#[tauri::command]
pub async fn character_assets(
    auth_state: State<'_, AuthState>,
    character_id: i64,
) -> Result<Vec<Asset>, String> {
    let assets = character::fetch_assets(&auth_state, character_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(assets
        .into_iter()
        .map(|a| Asset {
            type_id: a.type_id,
            quantity: a.quantity,
            location_id: a.location_id,
        })
        .collect())
}

/// Total owned quantity per type across the **whole roster** (personal assets),
/// for stock-aware production. Durably cached for 10 minutes so repeated builds
/// don't re-hit ESI; characters whose token can't refresh are skipped.
#[tauri::command]
pub async fn roster_stock(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
) -> Result<std::collections::HashMap<i64, i64>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if let Some(cached) =
        storage::cache_get::<std::collections::HashMap<i64, i64>>(&dir, "roster_stock")
    {
        return Ok(cached);
    }
    let mut stock: std::collections::HashMap<i64, i64> = std::collections::HashMap::new();
    for c in storage::load_roster(&dir) {
        if let Ok(assets) = character::fetch_assets(&auth_state, c.character_id).await {
            for a in assets {
                *stock.entry(a.type_id).or_default() += a.quantity;
            }
        }
    }
    let _ = storage::cache_put(&dir, "roster_stock", &stock, 600);
    Ok(stock)
}

/// Open the in-game market window for a type, using the first logged-in
/// character. Requires the `esi-ui.open_window.v1` scope (re-login if added).
#[tauri::command]
pub async fn open_market_window(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
    type_id: i64,
) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let character = storage::load_roster(&dir)
        .into_iter()
        .next()
        .ok_or("Log in a character first")?;
    character::open_market_window(&auth_state, character.character_id, type_id)
        .await
        .map_err(|e| e.to_string())
}

/// Best-effort startup warm-up: pull the active character's assets so the
/// ESI conditional cache is primed and Production/Assets open without waiting on
/// a cold network fetch. Silent on any failure (offline, no character, etc.).
pub async fn warm_active_character(app: &AppHandle) {
    let Ok(dir) = app.path().app_data_dir() else {
        return;
    };
    let Some(character_id) = storage::active_character(&dir) else {
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
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut roster = storage::load_roster(&dir);
    roster.retain(|c| c.character_id != character_id);
    storage::save_roster(&dir, &roster)?;
    storage::delete_refresh_token(character_id)?;
    auth_state.forget(character_id);
    Ok(roster)
}
