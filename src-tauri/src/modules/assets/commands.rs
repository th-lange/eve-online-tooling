//! Assets module — value the roster's holdings at a market (and where each
//! stack is worth the most).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::esi::{fetch_assets, AuthState};
use crate::market::{default_region_id, resolve_location, MarketService, PriceModel};
use crate::sde::{Sde, SdePaths};
use crate::storage;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetsParams {
    #[serde(default = "default_region_id")]
    pub region_id: i64,
    #[serde(default)]
    pub station_id: Option<i64>,
    /// Value each stack at the best-paying hub instead of the chosen market.
    #[serde(default)]
    pub best_hub: bool,
}

/// One owned item type, aggregated across the roster and valued.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetRow {
    pub type_id: i64,
    pub name: String,
    pub quantity: i64,
    pub sell_price: Option<f64>,
    pub buy_price: Option<f64>,
    pub sell_value: f64,
    pub buy_value: f64,
    pub sell_hub: Option<String>,
    pub volume: f64,
    pub category: Option<String>,
    pub group: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetsResult {
    pub rows: Vec<AssetRow>,
    pub sell_total: f64,
    pub buy_total: f64,
    pub volume_total: f64,
}

/// Aggregate the roster's personal assets by type, value each at the chosen
/// market (or best hub), and total the net worth + cargo volume.
#[tauri::command]
pub async fn assets_value(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
    market: State<'_, MarketService>,
    params: AssetsParams,
) -> Result<AssetsResult, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let sde = Sde::open(&SdePaths::new(dir.clone()).db).map_err(|e| e.to_string())?;

    // Quantity per type across the roster (reuses the durable roster-stock cache).
    let stock: HashMap<i64, i64> = match storage::cache_get(&dir, "roster_stock") {
        Some(s) => s,
        None => {
            let mut s: HashMap<i64, i64> = HashMap::new();
            for c in storage::load_roster(&dir) {
                if let Ok(assets) = fetch_assets(&auth_state, c.character_id).await {
                    for a in assets {
                        *s.entry(a.type_id).or_default() += a.quantity;
                    }
                }
            }
            let _ = storage::cache_put(&dir, "roster_stock", &s, 600);
            s
        }
    };
    if stock.is_empty() {
        return Ok(AssetsResult {
            rows: Vec::new(),
            sell_total: 0.0,
            buy_total: 0.0,
            volume_total: 0.0,
        });
    }

    let ids: Vec<i64> = stock.keys().copied().collect();
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
    let names = sde.market_items().map_err(|e| e.to_string())?;
    let name_vol: HashMap<i64, (String, f64)> = names
        .into_iter()
        .map(|m| (m.type_id, (m.name, m.volume.unwrap_or(0.0))))
        .collect();
    let categories = sde.category_names().map_err(|e| e.to_string())?;
    let groups = sde.group_names().map_err(|e| e.to_string())?;

    let (mut sell_total, mut buy_total, mut volume_total) = (0.0, 0.0, 0.0);
    let mut rows: Vec<AssetRow> = stock
        .into_iter()
        .map(|(type_id, quantity)| {
            let model = prices.get(&type_id);
            let buy_price = model.and_then(|m| m.buy_percentile);
            let (sell_price, sell_hub) = match best.get(&type_id) {
                Some(b) => (Some(b.price), Some(b.hub.clone())),
                None => (model.and_then(|m| m.sell_percentile), None),
            };
            let (name, vol_each) = name_vol
                .get(&type_id)
                .cloned()
                .unwrap_or_else(|| (format!("Type {type_id}"), 0.0));
            let q = quantity as f64;
            let sell_value = sell_price.unwrap_or(0.0) * q;
            let buy_value = buy_price.unwrap_or(0.0) * q;
            let volume = vol_each * q;
            sell_total += sell_value;
            buy_total += buy_value;
            volume_total += volume;
            AssetRow {
                type_id,
                name,
                quantity,
                sell_price,
                buy_price,
                sell_value,
                buy_value,
                sell_hub,
                volume,
                category: categories.get(&type_id).cloned(),
                group: groups.get(&type_id).cloned(),
            }
        })
        .collect();
    rows.sort_by(|a, b| {
        b.sell_value
            .partial_cmp(&a.sell_value)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    Ok(AssetsResult {
        rows,
        sell_total,
        buy_total,
        volume_total,
    })
}
