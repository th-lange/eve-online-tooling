//! EVE Online tooling — Tauri application core.
//!
//! The app is organised as feature **modules** that reuse a set of shared
//! **services**. Adding a feature later (daytrading, station-trading, …) means
//! adding one submodule under [`modules`] plus a frontend entry in
//! `src/modules/registry.ts`; the services below are reused as-is.
//!
//! Shared services:
//! - [`esi`]     — EVE SSO auth + ESI HTTP client and endpoint wrappers
//! - [`sde`]     — Static Data Export (blueprint / material data)
//! - [`market`]  — market price service (multiple price vectors + cache)
//! - [`model`]   — shared domain types
//! - [`storage`] — local persistence (OS keychain, on-disk cache)
//!
//! Feature modules live under [`modules`] (production first).

mod capabilities;
mod chatlog;
mod commands;
mod esi;
mod evescout;
mod info;
mod lists;
mod market;
mod mcp;
mod model;
mod modules;
mod plugins;
mod sde;
mod storage;
mod util;

/// A snap-packaged terminal (e.g. Alacritty) exports GStreamer paths into the
/// shell pointing at its own sandbox, which lacks `appsink`/`autoaudiosink`.
/// The WebView (WebKitGTK) then can't play audio (`play_sound`). When those
/// vars point into `/snap/`, drop them so GStreamer falls back to the system
/// plugins; the spawned `WebKitWebProcess` inherits this cleaned environment.
#[cfg(target_os = "linux")]
fn sanitize_snap_gstreamer_env() {
    for var in [
        "GST_PLUGIN_SYSTEM_PATH",
        "GST_PLUGIN_SYSTEM_PATH_1_0",
        "GST_PLUGIN_PATH",
        "GST_PLUGIN_PATH_1_0",
        "GST_PLUGIN_SCANNER",
        "GST_PLUGIN_SCANNER_1_0",
    ] {
        if std::env::var_os(var).is_some_and(|v| v.to_string_lossy().contains("/snap/")) {
            std::env::remove_var(var);
        }
    }
    // Keep only non-snap entries on the library path (the snap sets it to its
    // own dirs, unrelated to us).
    if let Some(val) = std::env::var_os("LD_LIBRARY_PATH") {
        match clean_library_path(&val.to_string_lossy()) {
            Some(cleaned) => std::env::set_var("LD_LIBRARY_PATH", cleaned),
            None => std::env::remove_var("LD_LIBRARY_PATH"),
        }
    }
}

/// Drop `/snap/` entries from a `PATH`-style value. `None` means the whole
/// value was snap entries (unset it); otherwise the kept `:`-joined entries.
#[cfg(target_os = "linux")]
fn clean_library_path(value: &str) -> Option<String> {
    let kept: Vec<&str> = value
        .split(':')
        .filter(|p| !p.is_empty() && !p.contains("/snap/"))
        .collect();
    if kept.is_empty() {
        None
    } else {
        Some(kept.join(":"))
    }
}

#[cfg(all(test, target_os = "linux"))]
mod env_tests {
    use super::clean_library_path;

    #[test]
    fn strips_only_snap_entries() {
        assert_eq!(
            clean_library_path("/usr/lib:/snap/alacritty/160/x/dri:/opt/lib"),
            Some("/usr/lib:/opt/lib".to_string()),
        );
        assert_eq!(clean_library_path("/snap/alacritty/160/x/dri"), None);
        assert_eq!(clean_library_path("/usr/lib"), Some("/usr/lib".to_string()),);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    sanitize_snap_gstreamer_env();

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        // Serve plugin UIs from a distinct, sandboxed `plugin://` origin so their
        // code can never reach the app document or `invoke` (issue #500). Assets
        // resolve under `app_data_dir/plugins/<id>/`, traversal-guarded, and are
        // served with a no-network CSP.
        .register_uri_scheme_protocol("plugin", |ctx, request| {
            let deny = |status: u16| {
                tauri::http::Response::builder()
                    .status(status)
                    .body(Vec::new())
                    .unwrap()
            };
            let Ok(dir) = crate::storage::app_data_dir(ctx.app_handle()) else {
                return deny(500);
            };
            let root = dir.join("plugins");
            match plugins::protocol::resolve_asset(&root, request.uri().path()) {
                Ok(file) => match std::fs::read(&file) {
                    Ok(bytes) => tauri::http::Response::builder()
                        .status(200)
                        .header("Content-Type", plugins::protocol::content_type(&file))
                        .header(
                            "Content-Security-Policy",
                            plugins::protocol::PLUGIN_FRAME_CSP,
                        )
                        // Let a sandboxed (opaque-origin) plugin UI ES-module
                        // import its own assets over plugin://; the CSP already
                        // pins the frame to this scheme and forbids network.
                        .header("Access-Control-Allow-Origin", "*")
                        .body(bytes)
                        .unwrap(),
                    Err(_) => deny(404),
                },
                Err(_) => deny(403),
            }
        })
        .setup(|app| {
            // Resolve the app data dir once and give the shared services a
            // disk-backed conditional cache rooted there, so ESI reads survive
            // restarts and revalidate with ETags (see esi::cache).
            use tauri::Manager;
            let dir = app
                .path()
                .app_data_dir()
                .expect("could not resolve the app data directory");
            // First run: seed the bundled example plugin so there's something to
            // activate out of the box (no-op once `plugins/` exists).
            plugins::seed_example_plugin(&dir);
            app.manage(market::MarketService::with_cache(dir.clone()));
            app.manage(esi::EsiClient::with_cache(dir.clone()));
            app.manage(std::sync::Arc::new(plugins::PluginRegistry::load(&dir)));
            app.manage(std::sync::Arc::new(plugins::PluginManager::new()));
            app.manage(esi::AuthState::with_cache(dir));
            app.manage(modules::dpsmeter::commands::DpsState::default());
            app.manage(mcp::McpState::default());

            // Fetch key data early, in the background — never block launch. Keeps
            // the SDE current (daily, md5-gated) and primes the active
            // character's assets into the conditional cache.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                sde::commands::auto_refresh(&handle).await;
                esi::commands::warm_active_character(&handle).await;
            });

            // The script loop: one background timeline that re-runs every
            // Run-state script on its minute interval (see scripts::scheduler).
            modules::scripts::scheduler::spawn(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            plugins::plugins_list,
            plugins::plugins_dir,
            plugins::manager::plugins_rescan,
            plugins::manager::plugin_invoke,
            plugins::manager::plugin_set_active,
            mcp::mcp_start,
            mcp::mcp_stop,
            mcp::mcp_status,
            mcp::mcp_config,
            mcp::mcp_set_port,
            commands::eve_default_log_dir,
            esi::commands::auth_login,
            esi::commands::auth_characters,
            esi::commands::auth_logout,
            esi::commands::set_active_character,
            esi::commands::active_character,
            esi::commands::owned_blueprints,
            esi::commands::character_assets,
            esi::commands::roster_stock,
            esi::commands::open_market_window,
            sde::commands::sde_status,
            sde::commands::sde_update,
            sde::commands::sde_blueprint_materials,
            sde::commands::sde_blueprint_product,
            sde::commands::sde_type_info,
            sde::commands::sde_manufacturable_blueprints,
            sde::commands::sde_categories,
            sde::commands::sde_market_categories,
            sde::commands::sde_groups,
            sde::commands::sde_types,
            sde::commands::sde_type_detail,
            sde::commands::sde_type_attributes,
            sde::commands::sde_search,
            sde::commands::sde_search_ships,
            sde::commands::sde_market_group_children,
            sde::commands::sde_type_names,
            sde::commands::sde_type_infos,
            market::commands::market_regions,
            market::commands::market_price,
            market::commands::market_history,
            market::commands::market_all_regions,
            market::commands::market_search_stations,
            market::commands::market_current_location,
            market::commands::market_sell_orders,
            modules::production::commands::production_profit,
            modules::production::commands::production_decryptors,
            modules::production::commands::production_get_list,
            modules::production::commands::production_set_list,
            modules::production::commands::production_system_cost_index,
            modules::trading::commands::station_trading,
            modules::trading::commands::trading_get_list,
            modules::trading::commands::trading_set_list,
            modules::daytrading::commands::daytrading_scan,
            modules::daytrading::commands::daytrading_get_list,
            modules::daytrading::commands::daytrading_set_list,
            modules::shopping::commands::shopping_lists,
            modules::shopping::commands::shopping_create_list,
            modules::shopping::commands::shopping_rename_list,
            modules::shopping::commands::shopping_delete_list,
            modules::shopping::commands::shopping_add_item,
            modules::shopping::commands::shopping_add_text,
            modules::shopping::commands::shopping_set_quantity,
            modules::shopping::commands::shopping_remove_item,
            modules::shopping::commands::shopping_clear_list,
            modules::shopping::commands::shopping_move_item,
            modules::shopping::commands::shopping_chat_sync,
            modules::fitting::commands::fitting_ship_layout,
            modules::fitting::commands::fitting_import_eft,
            modules::fitting::commands::fitting_add_item,
            modules::fitting::commands::fitting_classify_slots,
            modules::fitting::commands::fitting_module_info,
            modules::fitting::commands::fitting_compatible_charges,
            modules::fitting::commands::fitting_export_eft,
            modules::fitting::commands::fitting_esi_list,
            modules::fitting::commands::fitting_esi_push,
            modules::fitting::commands::fitting_simulate,
            modules::fitting::optimizer::fitting_optimize,
            modules::fitting::commands::fitting_price,
            modules::fitting::commands::fitting_save_local,
            modules::fitting::commands::fitting_list_local,
            modules::fitting::commands::fitting_load_local,
            modules::fitting::commands::fitting_delete_local,
            modules::appraisal::commands::appraisal,
            modules::appraisal::commands::appraisal_reprocess,
            modules::assets::commands::assets_value,
            modules::assets::commands::assets_tree,
            modules::accounting::commands::wallet_sync,
            modules::accounting::commands::profit_fifo,
            modules::accounting::commands::transaction_ledger,
            modules::contracts::commands::contracts_scan,
            modules::route::commands::system_activity,
            modules::route::commands::system_search,
            modules::route::commands::system_neighbourhood,
            modules::route::commands::route_location,
            modules::route::commands::route_breadcrumb,
            modules::route::commands::route_clear_breadcrumb,
            modules::route::commands::route_nearest_wormhole,
            modules::orders::commands::market_orders,
            modules::industry::commands::industry_jobs,
            modules::intel::commands::intel_incursions,
            modules::intel::commands::intel_fw_stats,
            modules::intel::commands::fw_systems,
            modules::notifications::commands::notifications,
            modules::notifications::commands::notification_dismiss,
            modules::notifications::commands::notifications_reset,
            modules::pochven::commands::pochven_routes,
            modules::pochven::commands::pochven_search,
            modules::pochven::commands::pochven_map,
            modules::pi::commands::pi_overview,
            modules::pi::commands::pi_show_in_game,
            modules::pi::commands::pi_locked_get,
            modules::pi::commands::pi_locked_set,
            modules::wormholes::commands::wh_connections,
            modules::wormholes::commands::wh_add_connection,
            modules::wormholes::commands::wh_update_connection,
            modules::wormholes::commands::wh_delete_connection,
            modules::wormholes::commands::wh_route,
            modules::wormholes::commands::wh_import_evescout,
            modules::wormholes::commands::wh_jump_plan,
            modules::wormholes::commands::wh_type_reference,
            modules::wormholes::commands::wh_system_reference,
            modules::wormholes::commands::wh_tripwire_status,
            modules::wormholes::commands::wh_tripwire_connect,
            modules::wormholes::commands::wh_tripwire_disconnect,
            modules::wormholes::commands::wh_tripwire_import,
            modules::wormholes::commands::wh_paste_signatures,
            modules::wormholes::commands::wh_signatures,
            modules::localintel::commands::local_scan,
            modules::localintel::commands::local_log_names,
            modules::localintel::commands::localintel_zkill,
            modules::localintel::commands::localintel_get_watchlist,
            modules::localintel::commands::localintel_set_watchlist,
            modules::pvp::commands::pvp_profiles,
            modules::pvp::commands::pvp_pilot_fits,
            modules::pvp::commands::pvp_typical_fit,
            modules::lpstore::commands::lp_balances,
            modules::lpstore::commands::lp_offers,
            modules::character::commands::character_skills,
            modules::character::commands::character_standings,
            modules::character::commands::character_trade_fees,
            modules::character::commands::character_research,
            modules::character::commands::character_mining,
            modules::character::commands::character_fleet,
            modules::reprocessing::commands::reprocessing_scan,
            modules::reprocessing::commands::reprocessing_efficiency,
            modules::reprocessing::commands::reprocessing_get_list,
            modules::reprocessing::commands::reprocessing_set_list,
            modules::dpsmeter::commands::dps_start,
            modules::dpsmeter::commands::dps_stop,
            modules::dpsmeter::commands::dps_list_logs,
            modules::dpsmeter::commands::dps_playback,
            modules::scripts::commands::scripts_list,
            modules::scripts::commands::scripts_save,
            modules::scripts::commands::scripts_delete,
            modules::scripts::commands::scripts_run,
            modules::scripts::commands::scripts_examples,
            info::info_list,
            info::info_clear,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
