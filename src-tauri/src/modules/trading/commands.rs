//! Tauri command surface for the station-trading module.

use serde::Deserialize;
use tauri::{AppHandle, State};

use crate::lists::{self, ListItem};
use crate::market::{default_region_id, resolve_location, MarketService};

use super::engine::{evaluate, TradeConfig, TradeRow};

const RESULT_CAP: usize = 500;

/// History window (days) averaged for the daily-traded volume column.
const TRADED_VOLUME_DAYS: usize = 7;

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
    let (dir, sde) = crate::sde::dir_and_sde(&app)?;
    let items = sde.market_items().map_err(|e| e.to_string())?;
    let ids: Vec<i64> = items.iter().map(|i| i.type_id).collect();

    let location = resolve_location(params.region_id, params.station_id);
    let prices = market
        .price_map_at(location, &ids)
        .await
        .map_err(|e| e.to_string())?;

    let (blacklist, favorites) = lists::load_filter_sets(&dir, "blacklist", "favorites");
    let categories = sde.category_names().map_err(|e| e.to_string())?;
    let groups = sde.group_names().map_err(|e| e.to_string())?;
    let meta = sde.meta_group_names().map_err(|e| e.to_string())?;
    let config = TradeConfig {
        broker_fee: params.broker_fee,
        sales_tax: params.sales_tax,
    };

    let mut out: Vec<TradeRow> = items
        .iter()
        .filter(|item| !blacklist.contains(&item.type_id))
        .filter_map(|item| {
            let model = prices.get(item.type_id)?;
            let mut row = evaluate(
                item.type_id,
                &item.name,
                model,
                &config,
                favorites.contains(&item.type_id),
            )?;
            if row.profit_per_unit <= 0.0 || row.volume < params.min_volume {
                return None;
            }
            row.category = categories.get(&item.type_id).cloned();
            row.group = groups.get(&item.type_id).cloned();
            row.meta_group = Some(
                meta.get(&item.type_id)
                    .cloned()
                    .unwrap_or_else(|| "Tech I".to_string()),
            );
            Some(row)
        })
        .collect();

    out.sort_by(|a, b| {
        b.profit_per_unit
            .partial_cmp(&a.profit_per_unit)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    out.truncate(RESULT_CAP);

    // Enrich the displayed set with real daily-traded volume from market history
    // (units moved/day). Only the truncated rows are fetched, so we don't pull
    // history for the whole ~19k catalogue. Region-scoped + cached.
    let displayed_ids: Vec<i64> = out.iter().map(|r| r.type_id).collect();
    let stats = market
        .daily_traded_stats(params.region_id, &displayed_ids, TRADED_VOLUME_DAYS)
        .await;
    for row in &mut out {
        let s = stats.get(&row.type_id).cloned().unwrap_or_default();
        row.daily_traded = s.volume;
        row.days_of_supply = if s.volume > 0 {
            row.volume as f64 / s.volume as f64
        } else {
            0.0
        };
        // Flag a current sell price sitting at a recent extreme (mean-reversion risk).
        if s.high > 0.0 && row.sell > s.high {
            row.price_flag = Some(format!("above {TRADED_VOLUME_DAYS}d high"));
        } else if s.low > 0.0 && row.sell < s.low {
            row.price_flag = Some(format!("below {TRADED_VOLUME_DAYS}d low"));
        }
    }

    Ok(out)
}

/// The contents of a saved list (`blacklist` or `favorites`), with names.
#[tauri::command]
pub fn trading_get_list(app: AppHandle, list: String) -> Result<Vec<ListItem>, String> {
    let key = list_key(&list)?;
    lists::get_from_app(&app, key)
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
    lists::set_from_app(&app, key, type_id, add)
}
