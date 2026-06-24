//! Tauri command surface for the market service.

use serde::Serialize;
use tauri::State;

use super::markets::{regions, resolve_location, Region};
use super::service::MarketService;
use super::types::PriceModel;

/// One day of market history, for the history explorer (camelCase for the UI).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPoint {
    pub date: String,
    pub average: f64,
    pub highest: f64,
    pub lowest: f64,
    pub volume: i64,
    pub order_count: i64,
}

/// Daily market history for a type in a region (ascending by date).
#[tauri::command]
pub async fn market_history(
    service: State<'_, MarketService>,
    region_id: i64,
    type_id: i64,
) -> Result<Vec<HistoryPoint>, String> {
    let days = service
        .history(region_id, type_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(days
        .into_iter()
        .map(|d| HistoryPoint {
            date: d.date,
            average: d.average,
            highest: d.highest,
            lowest: d.lowest,
            volume: d.volume,
            order_count: d.order_count,
        })
        .collect())
}

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
