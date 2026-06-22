//! Tauri command surface for the market service.

use tauri::State;

use super::service::MarketService;
use super::types::PriceModel;

/// Price model (all vectors) for a single type.
#[tauri::command]
pub async fn market_price(
    service: State<'_, MarketService>,
    type_id: i64,
) -> Result<PriceModel, String> {
    service
        .price_model(type_id)
        .await
        .map_err(|e| e.to_string())
}

/// Price models for many types in one call (global prices fetched once).
#[tauri::command]
pub async fn market_prices(
    service: State<'_, MarketService>,
    type_ids: Vec<i64>,
) -> Result<Vec<PriceModel>, String> {
    service
        .price_models(&type_ids)
        .await
        .map_err(|e| e.to_string())
}
