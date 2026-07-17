//! Market Orders — the logged-in character's open buy/sell orders, with
//! undercut detection against the current best price at each order's station.
//!
//! Requires the `esi-markets.read_character_orders.v1` scope (must be enabled on
//! the EVE app + a re-login before this returns data).

use tauri::{AppHandle, State};

use crate::esi::AuthState;
use crate::market::{self, MarketService};
use crate::model::AppError;

/// Open market orders across the target characters (the whole roster when
/// "All characters" is active, else just the active one), each flagged as
/// undercut or top-of-book against the current best price **at the order's
/// own station**. A character whose orders can't be fetched is skipped
/// rather than failing the whole call.
#[tauri::command]
#[specta::specta]
pub async fn orders_list(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
    market: State<'_, MarketService>,
) -> Result<Vec<market::orders::OrderRow>, AppError> {
    let dir = crate::storage::app_data_dir(&app)?;
    market::orders::collect_orders(&dir, &auth_state, &market).await
}

/// Collects this module's specta-annotated commands for [`crate::bindings`].
/// Must live in this module: the `#[tauri::command]`/`#[specta::specta]`
/// expansion emits helper macros that are only textually in scope here (a
/// cross-module `collect_commands!` hits rustc's
/// `macro_expanded_macro_exports_accessed_by_absolute_paths` restriction).
pub fn specta_commands() -> tauri_specta::Commands<tauri::Wry> {
    tauri_specta::collect_commands![orders_list]
}
