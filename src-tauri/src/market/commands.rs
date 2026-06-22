//! Tauri command surface for the market service.

use tauri::State;

use super::markets::{default_market, market_by_id, markets, Market};
use super::service::MarketService;
use super::types::PriceModel;

fn resolve(market_id: Option<String>) -> Market {
    market_id
        .as_deref()
        .and_then(market_by_id)
        .unwrap_or_else(default_market)
}

/// The selectable markets (trade hubs + a few whole-region options).
#[tauri::command]
pub fn market_hubs() -> Vec<Market> {
    markets()
}

/// Price model (all vectors) for a single type at the given market (default Jita).
#[tauri::command]
pub async fn market_price(
    service: State<'_, MarketService>,
    market_id: Option<String>,
    type_id: i64,
) -> Result<PriceModel, String> {
    let market = resolve(market_id);
    service
        .price_model(&market, type_id)
        .await
        .map_err(|e| e.to_string())
}

/// Price models for many types at the given market (global prices fetched once).
#[tauri::command]
pub async fn market_prices(
    service: State<'_, MarketService>,
    market_id: Option<String>,
    type_ids: Vec<i64>,
) -> Result<Vec<PriceModel>, String> {
    let market = resolve(market_id);
    service
        .price_models(&market, &type_ids)
        .await
        .map_err(|e| e.to_string())
}
