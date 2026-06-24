//! Appraisal tool — paste a pile of items, get a buy/sell ISK valuation.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::market::{default_region_id, resolve_location, MarketService, PriceModel};
use crate::sde::{Sde, SdePaths};

/// One pasted line: an item name and a quantity (defaults to 1 in the UI).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppraisalItem {
    pub name: String,
    pub quantity: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppraisalParams {
    pub items: Vec<AppraisalItem>,
    #[serde(default = "default_region_id")]
    pub region_id: i64,
    #[serde(default)]
    pub station_id: Option<i64>,
    /// Sell side uses the best-paying hub instead of the chosen market.
    #[serde(default)]
    pub best_hub: bool,
}

/// One valued line of the appraisal.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppraisalLine {
    pub name: String,
    pub type_id: Option<i64>,
    pub quantity: i64,
    pub buy_price: Option<f64>,
    pub sell_price: Option<f64>,
    pub buy_value: f64,
    pub sell_value: f64,
    /// Best hub for the sell side (when `best_hub`), else `None`.
    pub sell_hub: Option<String>,
    pub volume: f64,
    /// False when the name couldn't be resolved to a type.
    pub resolved: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppraisalResult {
    pub lines: Vec<AppraisalLine>,
    pub buy_total: f64,
    pub sell_total: f64,
    pub volume_total: f64,
}

/// Resolve each pasted line to a type, price it at the chosen market (buy & sell),
/// and total the buy value, sell value, and cargo volume.
#[tauri::command]
pub async fn appraisal(
    app: AppHandle,
    market: State<'_, MarketService>,
    params: AppraisalParams,
) -> Result<AppraisalResult, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let sde = Sde::open(&SdePaths::new(dir).db).map_err(|e| e.to_string())?;

    // Resolve names → (type id, packaged volume), keeping the original line order.
    struct Resolved {
        name: String,
        quantity: i64,
        type_id: Option<i64>,
        volume_each: f64,
    }
    let mut resolved = Vec::with_capacity(params.items.len());
    for item in &params.items {
        let lookup = sde.type_by_name(item.name.trim()).map_err(|e| e.to_string())?;
        resolved.push(Resolved {
            name: item.name.clone(),
            quantity: item.quantity.max(0),
            type_id: lookup.map(|(id, _)| id),
            volume_each: lookup.and_then(|(_, v)| v).unwrap_or(0.0),
        });
    }

    let ids: Vec<i64> = resolved.iter().filter_map(|r| r.type_id).collect();
    let location = resolve_location(params.region_id, params.station_id);
    let prices: HashMap<i64, PriceModel> = market
        .price_models_at(location, &ids)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|m| (m.type_id, m))
        .collect();
    let best = if params.best_hub {
        market.best_sell_hubs(&ids).await.map_err(|e| e.to_string())?
    } else {
        HashMap::new()
    };

    let mut lines = Vec::with_capacity(resolved.len());
    let (mut buy_total, mut sell_total, mut volume_total) = (0.0, 0.0, 0.0);
    for r in resolved {
        let model = r.type_id.and_then(|id| prices.get(&id));
        let buy_price = model.and_then(|m| m.buy_percentile);
        let (sell_price, sell_hub) = match r.type_id.and_then(|id| best.get(&id)) {
            Some(b) => (Some(b.price), Some(b.hub.clone())),
            None => (model.and_then(|m| m.sell_percentile), None),
        };
        let q = r.quantity as f64;
        let buy_value = buy_price.unwrap_or(0.0) * q;
        let sell_value = sell_price.unwrap_or(0.0) * q;
        let volume = r.volume_each * q;
        buy_total += buy_value;
        sell_total += sell_value;
        volume_total += volume;
        lines.push(AppraisalLine {
            name: r.name,
            type_id: r.type_id,
            quantity: r.quantity,
            buy_price,
            sell_price,
            buy_value,
            sell_value,
            sell_hub,
            volume,
            resolved: r.type_id.is_some(),
        });
    }

    Ok(AppraisalResult {
        lines,
        buy_total,
        sell_total,
        volume_total,
    })
}
