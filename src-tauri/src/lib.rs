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
mod market;
mod model;
mod modules;
mod sde;
mod storage;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .manage(market::MarketService::new())
        .invoke_handler(tauri::generate_handler![
            commands::ping,
            sde::commands::sde_status,
            sde::commands::sde_update,
            sde::commands::sde_blueprint_materials,
            sde::commands::sde_blueprint_product,
            sde::commands::sde_type_info,
            sde::commands::sde_manufacturable_blueprints,
            market::commands::market_hubs,
            market::commands::market_price,
            market::commands::market_prices,
            modules::production::commands::production_profit,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
