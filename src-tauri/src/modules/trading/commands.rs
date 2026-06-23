//! Tauri command surface for the station-trading module.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::market::{default_region_id, resolve_location, MarketService, PriceModel};
use crate::sde::{Sde, SdePaths};
use crate::storage;

use super::engine::{evaluate, TradeConfig, TradeRow};

const RESULT_CAP: usize = 500;

/// Only these named lists are persisted (guards the filename).
fn list_key(list: &str) -> Result<&'static str, String> {
    match list {
        "blacklist" => Ok("blacklist"),
        "favorites" => Ok("favorites"),
        _ => Err(format!("unknown list: {list}")),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TradeParams {
    #[serde(default = "default_region_id")]
    pub region_id: i64,
    #[serde(default)]
    pub station_id: Option<i64>,
    #[serde(default)]
    pub broker_fee: f64,
    #[serde(default)]
    pub sales_tax: f64,
    #[serde(default)]
    pub min_volume: i64,
}

/// Rank tradeable items at a market by station-trade profit (buy→sell spread
/// after fees). Excludes blacklisted items; marks favorites.
#[tauri::command]
pub async fn station_trading(
    app: AppHandle,
    market: State<'_, MarketService>,
    params: TradeParams,
) -> Result<Vec<TradeRow>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let sde = Sde::open(&SdePaths::new(dir.clone()).db).map_err(|e| e.to_string())?;
    let items = sde.market_items().map_err(|e| e.to_string())?;
    let ids: Vec<i64> = items.iter().map(|i| i.type_id).collect();

    let location = resolve_location(params.region_id, params.station_id);
    let prices: HashMap<i64, PriceModel> = market
        .price_models_at(location, &ids)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|m| (m.type_id, m))
        .collect();

    let blacklist: HashSet<i64> = storage::load_id_list(&dir, "blacklist")
        .into_iter()
        .collect();
    let favorites: HashSet<i64> = storage::load_id_list(&dir, "favorites")
        .into_iter()
        .collect();
    let config = TradeConfig {
        broker_fee: params.broker_fee,
        sales_tax: params.sales_tax,
    };

    let mut out: Vec<TradeRow> = items
        .iter()
        .filter(|item| !blacklist.contains(&item.type_id))
        .filter_map(|item| {
            let model = prices.get(&item.type_id)?;
            let row = evaluate(
                item.type_id,
                &item.name,
                model,
                &config,
                favorites.contains(&item.type_id),
            )?;
            (row.profit_per_unit > 0.0 && row.volume >= params.min_volume).then_some(row)
        })
        .collect();

    out.sort_by(|a, b| {
        b.profit_per_unit
            .partial_cmp(&a.profit_per_unit)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    out.truncate(RESULT_CAP);
    Ok(out)
}

/// An item on a saved list (with its name).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ListItem {
    pub type_id: i64,
    pub name: String,
}

/// The contents of a saved list (`blacklist` or `favorites`), with names.
#[tauri::command]
pub fn trading_get_list(app: AppHandle, list: String) -> Result<Vec<ListItem>, String> {
    let key = list_key(&list)?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let sde = Sde::open(&SdePaths::new(dir.clone()).db).map_err(|e| e.to_string())?;
    let ids = storage::load_id_list(&dir, key);
    let out = ids
        .into_iter()
        .map(|type_id| {
            let name = sde
                .type_info(type_id)
                .ok()
                .flatten()
                .map(|t| t.name)
                .unwrap_or_else(|| format!("Type {type_id}"));
            ListItem { type_id, name }
        })
        .collect();
    Ok(out)
}

/// Add or remove a type from a saved list.
#[tauri::command]
pub fn trading_set_list(
    app: AppHandle,
    list: String,
    type_id: i64,
    add: bool,
) -> Result<(), String> {
    let key = list_key(&list)?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut ids = storage::load_id_list(&dir, key);
    ids.retain(|&x| x != type_id);
    if add {
        ids.push(type_id);
    }
    storage::save_id_list(&dir, key, &ids)
}
