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
        .manage(market::MarketService::new())
        .manage(esi::AuthState::new())
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            esi::commands::auth_login,
            esi::commands::auth_characters,
            esi::commands::auth_logout,
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
            market::commands::market_regions,
            market::commands::market_price,
            market::commands::market_prices,
            market::commands::market_history,
            modules::production::commands::production_profit,
            modules::production::commands::production_decryptors,
            modules::production::commands::production_get_list,
            modules::production::commands::production_set_list,
            modules::trading::commands::station_trading,
            modules::trading::commands::trading_get_list,
            modules::trading::commands::trading_set_list,
            modules::daytrading::commands::daytrading_scan,
            modules::daytrading::commands::daytrading_get_list,
            modules::daytrading::commands::daytrading_set_list,
            modules::appraisal::commands::appraisal,
            modules::appraisal::commands::appraisal_reprocess,
            modules::assets::commands::assets_value,
            modules::accounting::commands::wallet_sync,
            modules::accounting::commands::profit_fifo,
            modules::contracts::commands::contracts_scan,
            modules::route::commands::system_activity,
            modules::route::commands::system_search,
            modules::route::commands::system_neighbourhood,
            modules::route::commands::route_location,
            modules::route::commands::route_breadcrumb,
            modules::route::commands::route_clear_breadcrumb,
            modules::orders::commands::market_orders,
            modules::industry::commands::industry_jobs,
            modules::wormholes::commands::wh_connections,
            modules::wormholes::commands::wh_add_connection,
            modules::wormholes::commands::wh_update_connection,
            modules::wormholes::commands::wh_delete_connection,
            modules::wormholes::commands::wh_route,
            modules::wormholes::commands::wh_paste_signatures,
            modules::wormholes::commands::wh_signatures,
            modules::localintel::commands::local_scan,
            modules::localintel::commands::localintel_zkill,
            modules::localintel::commands::localintel_get_watchlist,
            modules::localintel::commands::localintel_set_watchlist,
            modules::lpstore::commands::lp_balances,
            modules::lpstore::commands::lp_offers,
            modules::character::commands::character_skills,
            modules::character::commands::character_standings,
            modules::character::commands::character_research,
            modules::character::commands::character_mining,
            modules::character::commands::character_fleet,
            modules::reprocessing::commands::reprocessing_scan,
            modules::reprocessing::commands::reprocessing_efficiency,
            modules::reprocessing::commands::reprocessing_get_list,
            modules::reprocessing::commands::reprocessing_set_list,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
