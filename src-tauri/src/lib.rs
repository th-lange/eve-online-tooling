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

mod commands;
mod esi;
mod evescout;
mod lists;
mod market;
mod model;
mod modules;
mod sde;
mod storage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            // Resolve the app data dir once and give the shared services a
            // disk-backed conditional cache rooted there, so ESI reads survive
            // restarts and revalidate with ETags (see esi::cache).
            use tauri::Manager;
            let dir = app
                .path()
                .app_data_dir()
                .expect("could not resolve the app data directory");
            app.manage(market::MarketService::with_cache(dir.clone()));
            app.manage(esi::AuthState::with_cache(dir));
            app.manage(modules::dpsmeter::commands::DpsState::default());

            // Fetch key data early, in the background — never block launch. Keeps
            // the SDE current (daily, md5-gated) and primes the active
            // character's assets into the conditional cache.
            let handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                sde::commands::auto_refresh(&handle).await;
                esi::commands::warm_active_character(&handle).await;
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::ping,
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
            market::commands::market_prices,
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
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
