//! Tauri command surface for the market service.

use tauri::State;

use super::markets::{regions, resolve_location, Region};
use super::service::MarketService;
use super::types::PriceModel;

/// The selectable regions, each with its hub station.
#[tauri::command]
pub fn market_regions() -> Vec<Region> {
    regions()
}

/// Price model for a single type at a region (and optional station), via live
/// ESI orders + history.
#[tauri::command]
pub async fn market_price(
    service: State<'_, MarketService>,
    region_id: i64,
    station_id: Option<i64>,
    type_id: i64,
) -> Result<PriceModel, String> {
    let location = resolve_location(region_id, station_id);
    service
        .price_model(location, type_id)
        .await
        .map_err(|e| e.to_string())
}

/// Price models for many types at a region (and optional station).
#[tauri::command]
pub async fn market_prices(
    service: State<'_, MarketService>,
    region_id: i64,
    station_id: Option<i64>,
    type_ids: Vec<i64>,
) -> Result<Vec<PriceModel>, String> {
    let location = resolve_location(region_id, station_id);
    service
        .price_models(location, &type_ids)
        .await
        .map_err(|e| e.to_string())
}
