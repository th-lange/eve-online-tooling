//! Tauri command surface for EVE SSO (multi-character).

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_opener::OpenerExt;

use super::auth::{self, AuthState};
use super::character;
use crate::model::Character;
use crate::storage;

/// Event carrying the SSO authorize URL of the login now waiting for its
/// browser redirect, so the UI can offer a "copy login link" fallback when the
/// browser doesn't open. The URL holds only the PKCE *challenge* and `state`;
/// the verifier never leaves the backend.
const LOGIN_URL_EVENT: &str = "auth://login-url";

/// Log in (or re-authorize) a character via EVE SSO and add it to the roster.
/// Opens the browser and waits for the loopback redirect. A login already
/// waiting is cancelled (superseded); [`auth_login_cancel`] aborts this one.
#[tauri::command]
#[specta::specta]
pub async fn auth_login(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
) -> Result<Character, crate::model::AppError> {
    let cancel = auth_state.begin_login();
    let result = run_login(&app, &auth_state, &cancel).await;
    auth_state.end_login(&cancel);
    result
}

/// Abort the login currently waiting for its browser redirect (no-op if none).
/// The pending `auth_login` call resolves with a "login cancelled" error and
/// the loopback port is freed.
#[tauri::command]
#[specta::specta]
pub fn auth_login_cancel(auth_state: State<'_, AuthState>) {
    auth_state.cancel_login();
}

async fn run_login(
    app: &AppHandle,
    auth_state: &AuthState,
    cancel: &std::sync::Arc<std::sync::atomic::AtomicBool>,
) -> Result<Character, crate::model::AppError> {
    let pkce = auth::generate_pkce();
    let csrf = auth::random_state();

    // Bind the loopback server before opening the browser so the redirect can't
    // arrive before we're listening. The bind may briefly wait out a login that
    // was just cancelled/superseded, so it runs off the async runtime.
    let server = tokio::task::spawn_blocking(auth::bind_loopback)
        .await
        .map_err(|e| e.to_string())??;
    let url = auth::authorize_url(&pkce.challenge, &csrf);
    // Hand the link to the UI first, then try the browser. A launcher that
    // fails (or "succeeds" without opening anything) must not abort the login:
    // the user can still finish it from the copied link.
    let _ = app.emit(LOGIN_URL_EVENT, &url);
    if let Err(e) = app.opener().open_url(&url, None::<&str>) {
        eprintln!("esi::auth: could not open the system browser: {e}");
    }

    // Wait for the redirect off the async runtime.
    let waiter = cancel.clone();
    let code = tokio::task::spawn_blocking(move || auth::capture_code(server, &csrf, &waiter))
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

    // Persist the refresh token (keychain — blocking OS I/O, so off the async
    // runtime like the refresh path) and the roster (json), de-duping.
    let character_id = token_character.character_id;
    let refresh_token = tokens.refresh_token.clone();
    tokio::task::spawn_blocking(move || storage::store_refresh_token(character_id, &refresh_token))
        .await
        .map_err(|e| e.to_string())??;
    let dir = crate::storage::app_data_dir(app)?;
    let character = Character {
        character_id: token_character.character_id,
        name: token_character.name,
        scopes: token_character.scopes,
    };
    let mut roster = storage::load_roster(&dir);
    roster.retain(|c| c.character_id != character.character_id);
    roster.push(character.clone());
    storage::save_roster(&dir, &roster)?;
    // A fresh login stored a new refresh token: any earlier "couldn't save
    // your login" warning for this character no longer applies.
    auth_state.clear_persist_failure(character.character_id);

    auth::cache_login_token(auth_state, &character, &tokens);
    Ok(character)
}

/// The current character roster.
#[tauri::command]
#[specta::specta]
pub fn auth_characters(app: AppHandle) -> Result<Vec<Character>, crate::model::AppError> {
    let dir = crate::storage::app_data_dir(&app)?;
    Ok(storage::load_roster(&dir))
}

/// Characters whose most recent rotated refresh token could not be saved to
/// the OS keychain. Their current session still works, but the next token
/// refresh will fail and force a re-login — the UI warns about it. Re-read on
/// the `auth://persist-failed` event, which fires whenever this set changes.
#[tauri::command]
#[specta::specta]
pub fn auth_persist_failures(auth_state: State<'_, AuthState>) -> Vec<i64> {
    auth_state.persist_failures()
}

/// Bookmark the "active" character used by per-character features (industry
/// jobs, route, etc.).
#[tauri::command]
#[specta::specta]
pub fn auth_set_active_character(
    app: AppHandle,
    character_id: i64,
) -> Result<(), crate::model::AppError> {
    let dir = crate::storage::app_data_dir(&app)?;
    storage::save_active_character(&dir, character_id).map_err(Into::into)
}

/// The active character id (bookmarked if set + in roster, else the first).
#[tauri::command]
#[specta::specta]
pub fn auth_active_character(app: AppHandle) -> Result<Option<i64>, crate::model::AppError> {
    let dir = crate::storage::app_data_dir(&app)?;
    Ok(storage::active_character(&dir))
}

/// The active character's currently-boarded ship: hull type id, its SDE name,
/// and the player-given ship name. `None` when there's no active character or
/// the fetch fails — most often the `esi-location.read_ship_type.v1` scope
/// isn't granted yet (re-login after enabling it on the EVE dev app). The
/// combat overlay uses this to auto-load your hull's fit (optimals) and drone
/// reminders.
#[derive(Debug, Clone, Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct CharacterShip {
    pub type_id: i64,
    pub type_name: String,
    pub ship_name: String,
}

#[tauri::command]
#[specta::specta]
pub async fn esi_character_ship(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
) -> Result<Option<CharacterShip>, crate::model::AppError> {
    let dir = crate::storage::app_data_dir(&app)?;
    let Some(character_id) = storage::active_character(&dir) else {
        return Ok(None);
    };
    let Ok(ship) = character::fetch_character_ship(&auth_state, character_id).await else {
        return Ok(None);
    };
    let type_name = crate::sde::open_from_dir(&dir)
        .map(|sde| sde.type_name_or_id(ship.ship_type_id))
        .unwrap_or_else(|_| ship.ship_type_id.to_string());
    Ok(Some(CharacterShip {
        type_id: ship.ship_type_id,
        type_name,
        ship_name: ship.ship_name,
    }))
}

/// A blueprint owned by a character (or their corporation), with its real
/// ME/TE/runs.
#[derive(Debug, Clone, Serialize, specta::Type)]
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
/// Factored out of the Tauri command (mirrors `pi::commands::pi_overview_core`)
/// so `massprod_plan` can call it directly with a plain dir/auth pair instead
/// of round-tripping through the Tauri command layer (#883).
pub async fn owned_blueprints_core(
    dir: &std::path::Path,
    auth_state: &AuthState,
) -> Result<Vec<OwnedBlueprint>, crate::model::AppError> {
    let roster = storage::load_roster(dir);

    // Characters have independent refresh tokens, so their ESI fetches are
    // safe to run concurrently instead of one-at-a-time.
    let fetches = roster.into_iter().map(|c| async move {
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
        if let Ok(blueprints) = character::fetch_blueprints(auth_state, c.character_id).await {
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
    });
    let mut out: Vec<OwnedBlueprint> = futures_util::future::join_all(fetches)
        .await
        .into_iter()
        .flatten()
        .collect();

    // Resolve blueprint names from the SDE (cached per type id).
    if let Ok(sde) = crate::sde::open_from_dir(dir) {
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

/// Tauri wrapper: all blueprints owned across the whole roster.
#[tauri::command]
#[specta::specta]
pub async fn esi_owned_blueprints(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
) -> Result<Vec<OwnedBlueprint>, crate::model::AppError> {
    let dir = crate::storage::app_data_dir(&app)?;
    owned_blueprints_core(&dir, &auth_state).await
}

/// Total owned quantity per type across the **whole roster** (personal assets),
/// for stock-aware production. Durably cached for 10 minutes so repeated builds
/// don't re-hit ESI. Characters whose fetch fails (e.g. an expired token) are
/// skipped from the totals, but such a *partial* result is never cached — the
/// next call retries instead of serving wrong stock counts for the full TTL.
#[tauri::command]
#[specta::specta]
pub async fn esi_roster_stock(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
) -> Result<std::collections::HashMap<String, i64>, crate::model::AppError> {
    let dir = crate::storage::app_data_dir(&app)?;
    if let Some(cached) =
        storage::cache_get::<std::collections::HashMap<String, i64>>(&dir, "roster_stock")
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
    // JSON object keys (and tauri-specta's generated TS) are strings, not
    // numbers — keying by `i64` forced the frontend binding into an
    // untypeable `Partial<{ [key in number]: number }>`, hence the cast at
    // the call site (#1045). Stringify here so specta emits a clean
    // `Record<string, number>` instead.
    let stock: std::collections::HashMap<String, i64> = stock
        .into_iter()
        .map(|(type_id, qty)| (type_id.to_string(), qty))
        .collect();
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
    stock: &std::collections::HashMap<String, i64>,
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
#[specta::specta]
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
#[specta::specta]
pub async fn esi_open_info_window(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
    target_id: i64,
) -> Result<(), crate::model::AppError> {
    let (_, character_id) = storage::dir_and_primary_character(&app)?;
    character::open_info_window(&auth_state, character_id, target_id).await?;
    Ok(())
}

/// Set the active character's autopilot destination to a solar system.
/// Requires `esi-ui.write_waypoint.v1`. This is the in-game equivalent of
/// "Set destination" — ESI's show-info endpoint does not support solar systems
/// (esi-issues#358), so setting a waypoint is the closest working hook.
/// Clears other waypoints so the route is direct.
#[tauri::command]
#[specta::specta]
pub async fn esi_set_waypoint(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
    system_id: i64,
) -> Result<(), crate::model::AppError> {
    let (_, character_id) = storage::dir_and_primary_character(&app)?;
    character::set_autopilot_waypoint(&auth_state, character_id, system_id).await?;
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

/// Remove a character: revoke its refresh token at the SSO (best effort), delete
/// it from the keychain, forget cached tokens/data, and drop the character from
/// the roster. Returns the updated roster.
///
/// Keychain access is blocking OS I/O (it can sit on an unlock prompt), so it
/// runs on the blocking pool. If the keychain delete fails the character is
/// *kept* in the roster so the user can retry — dropping it would orphan the
/// token with no UI to remove it — and the error is returned; in-memory state
/// and cached ESI data are purged regardless, and a failed roster save does
/// not stop that either.
#[tauri::command]
#[specta::specta]
pub async fn auth_logout(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
    character_id: i64,
) -> Result<Vec<Character>, crate::model::AppError> {
    let dir = crate::storage::app_data_dir(&app)?;
    remove_character(&auth_state, &dir, character_id).await
}

/// The body of [`auth_logout`], split out so it is testable without an app.
async fn remove_character(
    auth_state: &AuthState,
    dir: &std::path::Path,
    character_id: i64,
) -> Result<Vec<Character>, crate::model::AppError> {
    // Read the token before deleting it so it can be revoked at the SSO.
    let stored = tokio::task::spawn_blocking(move || storage::load_refresh_token(character_id))
        .await
        .ok()
        .and_then(Result::ok)
        .flatten();
    if let Some(token) = stored {
        if let Err(e) =
            auth::revoke_refresh_token(auth_state.http(), auth_state.revoke_url(), &token).await
        {
            // Best effort: offline logout must still work.
            eprintln!("esi::auth: SSO revoke for character {character_id} failed: {e}");
        }
    }

    let deleted = tokio::task::spawn_blocking(move || storage::delete_refresh_token(character_id))
        .await
        .map_err(|e| format!("keychain task panicked: {e}"))
        .and_then(|r| r);

    // Whatever else happens, this character's session state and private
    // cached responses go.
    auth_state.forget(character_id);
    auth_state.purge_character_cache(character_id).await;

    if let Err(e) = deleted {
        return Err(format!(
            "couldn't delete the saved login from the OS keychain ({e}); \
             the character was kept so you can try again"
        )
        .into());
    }

    let mut roster = storage::load_roster(dir);
    roster.retain(|c| c.character_id != character_id);
    storage::save_roster(dir, &roster)?;
    Ok(roster)
}

/// Collects this module's specta-annotated commands for [`crate::bindings`].
pub fn specta_commands() -> tauri_specta::Commands<tauri::Wry> {
    tauri_specta::collect_commands![
        auth_login,
        auth_login_cancel,
        auth_characters,
        auth_set_active_character,
        auth_active_character,
        esi_character_ship,
        esi_owned_blueprints,
        esi_roster_stock,
        esi_open_market_window,
        esi_open_info_window,
        esi_set_waypoint,
        auth_logout,
        auth_persist_failures,
    ]
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
        let stock = HashMap::from([("34".to_string(), 1_000_i64)]);
        // Partial snapshot (complete = false): nothing is written, so the
        // next roster_stock call misses the cache and retries.
        cache_stock_if_complete(&dir, &stock, false);
        assert_eq!(
            storage::cache_get::<HashMap<String, i64>>(&dir, "roster_stock"),
            None
        );
        // Complete snapshot: cached as before.
        cache_stock_if_complete(&dir, &stock, true);
        assert_eq!(
            storage::cache_get::<HashMap<String, i64>>(&dir, "roster_stock"),
            Some(stock)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A one-shot SSO stub recording the form body of the revoke request.
    fn revoke_stub() -> (String, std::sync::mpsc::Receiver<String>) {
        let server = tiny_http::Server::http("127.0.0.1:0").expect("bind stub");
        let addr = server.server_addr().to_ip().expect("addr");
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            if let Ok(mut req) = server.recv() {
                let mut body = String::new();
                let _ = std::io::Read::read_to_string(req.as_reader(), &mut body);
                let _ = tx.send(body);
                let _ = req.respond(tiny_http::Response::from_string(""));
            }
        });
        (format!("http://{addr}/"), rx)
    }

    fn logout_fixture(
        id: i64,
    ) -> (
        std::path::PathBuf,
        AuthState,
        std::sync::mpsc::Receiver<String>,
    ) {
        use crate::esi::token_cache::tests::counting_credential;
        counting_credential::install();
        let dir = std::env::temp_dir().join(format!("logout-test-{id}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let roster: Vec<Character> = [id, id + 1]
            .iter()
            .map(|&character_id| Character {
                character_id,
                name: format!("Pilot {character_id}"),
                scopes: vec![],
            })
            .collect();
        storage::save_roster(&dir, &roster).unwrap();
        storage::store_refresh_token(id, "secret-refresh").unwrap();
        // This character's cached private responses, plus a neighbour whose id
        // merely shares the digits as a prefix.
        let cache = dir.join("esi-cache");
        std::fs::create_dir_all(&cache).unwrap();
        std::fs::write(cache.join(format!("c{id}_latest_x.json")), "{}").unwrap();
        std::fs::write(cache.join(format!("c{id}9_latest_x.json")), "{}").unwrap();
        let (revoke_url, rx) = revoke_stub();
        let auth = AuthState::with_cache(dir.clone()).with_revoke_url(revoke_url);
        (dir, auth, rx)
    }

    fn block_on<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap()
            .block_on(f)
    }

    #[test]
    fn logout_revokes_deletes_the_token_and_purges_only_that_characters_cache() {
        let id = 910_301;
        let (dir, auth, revoked) = logout_fixture(id);

        let roster = block_on(remove_character(&auth, &dir, id)).expect("logout");

        assert_eq!(
            roster.iter().map(|c| c.character_id).collect::<Vec<_>>(),
            vec![id + 1]
        );
        assert_eq!(storage::load_roster(&dir).len(), 1);
        assert_eq!(storage::load_refresh_token(id).unwrap(), None);
        let form = revoked.try_recv().expect("revoke request was sent");
        assert!(form.contains("token=secret-refresh"), "{form}");
        assert!(!dir
            .join("esi-cache")
            .join(format!("c{id}_latest_x.json"))
            .exists());
        assert!(dir
            .join("esi-cache")
            .join(format!("c{id}9_latest_x.json"))
            .exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_failed_keychain_delete_surfaces_keeps_the_roster_entry_but_still_forgets() {
        use crate::esi::token_cache::tests::counting_credential;
        let id = 910_303;
        let (dir, auth, _revoked) = logout_fixture(id);
        let credential = counting_credential::credential_for(id);
        credential.fail_deletes(true);

        let err = block_on(remove_character(&auth, &dir, id)).expect_err("must surface");
        assert!(format!("{err:?}").contains("keychain"), "{err:?}");
        // Retryable: still listed, token still there; but cached data is gone.
        assert_eq!(storage::load_roster(&dir).len(), 2);
        assert!(storage::load_refresh_token(id).unwrap().is_some());
        assert!(!dir
            .join("esi-cache")
            .join(format!("c{id}_latest_x.json"))
            .exists());

        credential.fail_deletes(false);
        block_on(remove_character(&auth, &dir, id)).expect("retry succeeds");
        assert_eq!(storage::load_roster(&dir).len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
