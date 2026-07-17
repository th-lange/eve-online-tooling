//! Tauri command surface for the daytrading (cross-region arbitrage) module.

use std::collections::{HashMap, HashSet};

use serde::Deserialize;
use tauri::{AppHandle, State};

use crate::lists::{self, ListItem};
use crate::market::{regions, resolve_location, MarketService, PriceModel};

use super::engine::{evaluate, DayTradeConfig, DayTradeRow, Quote};

const RESULT_CAP: usize = 500;
/// On top of the ISK/m³ top list, also keep this many by absolute per-unit
/// profit, so high-value bulky flips (ships) aren't hidden by the cargo metric.
const PROFIT_CAP: usize = 200;

/// History window (days) averaged for the sell-hub daily-traded volume.
const TRADED_VOLUME_DAYS: usize = 7;

/// Storage keys — distinct from the other modules' lists.
const DAYTRADING_BLACKLIST_KEY: &str = "daytrading_blacklist";
const DAYTRADING_FAVORITES_KEY: &str = "daytrading_favorites";

/// Map the UI's logical list name to its (module-scoped) storage key.
fn list_key(list: &str) -> Result<&'static str, String> {
    match list {
        "blacklist" => Ok(DAYTRADING_BLACKLIST_KEY),
        "favorites" => Ok(DAYTRADING_FAVORITES_KEY),
        _ => Err(format!("unknown list: {list}")),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DayTradeParams {
    /// Region (hub) ids to scan. Empty = all known hubs.
    #[serde(default)]
    pub region_ids: Vec<i64>,
    #[serde(default)]
    pub sales_tax: f64,
    #[serde(default)]
    pub broker_fee: f64,
    /// Hauling cost in ISK per m³ (0 = ignore shipping).
    #[serde(default)]
    pub shipping_rate: f64,
    /// Minimum profit per unit (ISK) to keep a row.
    #[serde(default)]
    pub min_profit: f64,
    /// Days of demand to stock — suggested quantity = sell-hub daily volume × this.
    #[serde(default = "default_purchase_days")]
    pub purchase_days: f64,
    /// Drop rows whose sell-hub daily-traded volume is below this (illiquid).
    #[serde(default)]
    pub min_daily_demand: i64,
    /// Owned stock per type id (from `roster_stock`), netted off the suggested
    /// quantity so it doesn't tell you to buy what's already in your hangar.
    /// Empty = don't subtract (the UI's "subtract owned stock" toggle off).
    #[serde(default)]
    pub stock: HashMap<i64, i64>,
    /// Item categories (a whitelist) to scan/price — the scan starts from this
    /// reduced id set instead of the whole catalogue. Empty = the default
    /// day-trade set (Ships + Modules + Charges); pass explicit ids to override
    /// (e.g. add Drones, or `[]`-but-non-default via a full-catalogue selection).
    #[serde(default = "default_category_ids")]
    pub category_ids: Vec<i64>,
}

fn default_purchase_days() -> f64 {
    1.0
}

/// EVE category ids for the default day-trade set: Ship / Module / Charge.
fn default_category_ids() -> Vec<i64> {
    vec![6, 7, 8]
}

/// One hub being scanned: its region, station, short label, and per-type prices.
struct HubPrices {
    region_id: i64,
    label: String,
    prices: HashMap<i64, PriceModel>,
}

/// Scan several market hubs for the best cross-region flip per item: buy where
/// it's cheapest, sell where it's dearest, after taxes and fees. Excludes
/// blacklisted items; marks favorites.
#[tauri::command]
pub async fn daytrading_scan(
    app: AppHandle,
    market: State<'_, MarketService>,
    params: DayTradeParams,
) -> Result<Vec<DayTradeRow>, String> {
    let (dir, sde) = crate::sde::dir_and_sde(&app)?;
    // Whitelist scan: only price the chosen categories (default Ships/Modules/
    // Charges) instead of the whole ~19k catalogue — the headline win of #87.
    let items = sde
        .market_items_in_categories(&params.category_ids)
        .map_err(|e| e.to_string())?;
    let ids: Vec<i64> = items.iter().map(|i| i.type_id).collect();

    // Resolve which hubs to scan (default: all). Each hub prices at its station.
    let all_hubs = regions();
    let selected: Vec<_> = all_hubs
        .iter()
        .filter(|h| params.region_ids.is_empty() || params.region_ids.contains(&h.id))
        .collect();
    if selected.len() < 2 {
        return Err("pick at least two hubs to compare".into());
    }

    // Price the whole catalogue at each selected hub (Fuzzwork aggregates, cached).
    let mut hubs: Vec<HubPrices> = Vec::with_capacity(selected.len());
    for hub in &selected {
        let station_id = hub.stations.first().map(|s| s.id);
        let label = hub
            .stations
            .first()
            .map(|s| s.name.clone())
            .unwrap_or_else(|| hub.name.clone());
        let location = resolve_location(hub.id, station_id);
        let prices: HashMap<i64, PriceModel> = market
            .price_models_at(location, &ids)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|m| (m.type_id, m))
            .collect();
        hubs.push(HubPrices {
            region_id: hub.id,
            label,
            prices,
        });
    }

    let (blacklist, favorites) =
        lists::load_filter_sets(&dir, DAYTRADING_BLACKLIST_KEY, DAYTRADING_FAVORITES_KEY);
    let categories = sde.category_names().map_err(|e| e.to_string())?;
    let groups = sde.group_names().map_err(|e| e.to_string())?;
    let meta = sde.meta_group_names().map_err(|e| e.to_string())?;
    let config = DayTradeConfig {
        sales_tax: params.sales_tax,
        broker_fee: params.broker_fee,
        shipping_rate: params.shipping_rate,
    };

    let mut out: Vec<DayTradeRow> = items
        .iter()
        .filter(|item| !blacklist.contains(&item.type_id))
        .filter_map(|item| {
            // Collect this item's realistic sell-side price at each hub.
            let quotes: Vec<Quote> = hubs
                .iter()
                .filter_map(|h| {
                    let price = h.prices.get(&item.type_id)?.sell_percentile?;
                    Some(Quote {
                        region_id: h.region_id,
                        hub: h.label.clone(),
                        price,
                    })
                })
                .collect();
            let mut row = evaluate(
                item.type_id,
                &item.name,
                item.volume,
                &quotes,
                &config,
                favorites.contains(&item.type_id),
            )?;
            if row.profit_per_unit < params.min_profit || row.profit_per_unit <= 0.0 {
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

    // Two views matter for hauling: ISK/m³ (cargo-bound) and absolute profit — a
    // bulky ship can have low ISK/m³ but a big per-unit margin. Keep the top of
    // each so high-value flips aren't silently dropped by the cap.
    out.sort_by(|a, b| {
        b.profit_per_unit
            .partial_cmp(&a.profit_per_unit)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let by_profit: Vec<DayTradeRow> = out.iter().take(PROFIT_CAP).cloned().collect();
    out.sort_by(|a, b| {
        b.isk_per_m3
            .partial_cmp(&a.isk_per_m3)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    out.truncate(RESULT_CAP);
    let present: HashSet<i64> = out.iter().map(|r| r.type_id).collect();
    out.extend(
        by_profit
            .into_iter()
            .filter(|r| !present.contains(&r.type_id)),
    );

    // Enrich the displayed set with daily-traded volume at each row's sell hub
    // (how much you can realistically offload). Group by sell region so each
    // region's history is fetched once.
    let mut by_region: HashMap<i64, Vec<i64>> = HashMap::new();
    for row in &out {
        by_region
            .entry(row.sell_region_id)
            .or_default()
            .push(row.type_id);
    }
    let mut traded: HashMap<i64, i64> = HashMap::new();
    for (region_id, type_ids) in &by_region {
        let vols = market
            .daily_traded_volumes(*region_id, type_ids, TRADED_VOLUME_DAYS)
            .await;
        traded.extend(vols);
    }
    for row in &mut out {
        row.dest_volume = traded.get(&row.type_id).copied().unwrap_or(0);
        // Suggested quantity = how much the sell hub moves over the window, less
        // what you already own (so you don't restock your own hangar). `stock` is
        // empty when the UI's "subtract owned stock" toggle is off.
        let demand = (row.dest_volume as f64 * params.purchase_days).round() as i64;
        let owned = params.stock.get(&row.type_id).copied().unwrap_or(0);
        row.suggested_qty = super::engine::net_suggested_qty(demand, owned);
        row.total_profit = row.profit_per_unit * row.suggested_qty as f64;
        // Days-of-supply = sell-hub order-book sell listing ÷ daily-traded. High =
        // a contested book (slow to clear); low = clears fast.
        let listed = hubs
            .iter()
            .find(|h| h.region_id == row.sell_region_id)
            .and_then(|h| h.prices.get(&row.type_id))
            .and_then(|m| m.daily_volume)
            .unwrap_or(0);
        row.days_of_supply = if row.dest_volume > 0 {
            listed as f64 / row.dest_volume as f64
        } else {
            0.0
        };
    }

    // Liquidity floor: drop rows the sell hub can't absorb (after enrichment,
    // since dest_volume comes from history).
    if params.min_daily_demand > 0 {
        out.retain(|r| r.dest_volume >= params.min_daily_demand);
    }

    Ok(out)
}

/// The contents of a daytrading saved list (`blacklist` or `favorites`).
#[tauri::command]
pub fn daytrading_get_list(app: AppHandle, list: String) -> Result<Vec<ListItem>, String> {
    let key = list_key(&list)?;
    lists::get_from_app(&app, key)
}

/// Add or remove a type from a daytrading saved list.
#[tauri::command]
pub fn daytrading_set_list(
    app: AppHandle,
    list: String,
    type_id: i64,
    add: bool,
) -> Result<(), String> {
    let key = list_key(&list)?;
    lists::set_from_app(&app, key, type_id, add)
}
