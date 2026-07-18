//! Tauri command surface for the reprocessing (reprocess-vs-sell) module.

use std::collections::HashSet;

use serde::Deserialize;
use tauri::{AppHandle, State};

use crate::lists::{self, ListItem};
use crate::market::{default_region_id, resolve_location, MarketService};

use super::engine::{evaluate, ore_efficiency, EfficiencyConfig, ReprocessRow};

const RESULT_CAP: usize = 1000;
/// Asteroid/ore category — the primary reprocess-vs-sell decision.
const ORE_CATEGORY_ID: i64 = 25;

const REPROCESSING_BLACKLIST_KEY: &str = "reprocessing_blacklist";
const REPROCESSING_FAVORITES_KEY: &str = "reprocessing_favorites";

fn list_key(list: &str) -> Result<&'static str, String> {
    match list {
        "blacklist" => Ok(REPROCESSING_BLACKLIST_KEY),
        "favorites" => Ok(REPROCESSING_FAVORITES_KEY),
        _ => Err(format!("unknown list: {list}")),
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReprocessParams {
    #[serde(default = "default_region_id")]
    pub region_id: i64,
    #[serde(default)]
    pub station_id: Option<i64>,
    // Efficiency inputs (skills 0..5).
    #[serde(default)]
    pub reprocessing: i64,
    #[serde(default)]
    pub reprocessing_efficiency: i64,
    #[serde(default)]
    pub ore_processing: i64,
    #[serde(default)]
    pub implant_pct: f64,
    #[serde(default)]
    pub rig_bonus_pct: f64,
    #[serde(default = "default_mult")]
    pub structure_mult: f64,
    #[serde(default = "default_mult")]
    pub security_mult: f64,
}

fn default_mult() -> f64 {
    1.0
}

/// Rank ores by reprocess-vs-sell at a market: refine value per unit (outputs
/// valued at the chosen market) minus the ore's own sell price. Excludes
/// blacklisted items; marks favorites.
#[tauri::command]
pub async fn reprocessing_scan(
    app: AppHandle,
    market: State<'_, MarketService>,
    params: ReprocessParams,
) -> Result<Vec<ReprocessRow>, String> {
    let (dir, sde) = crate::sde::dir_and_sde(&app)?;
    let recipes = sde
        .reprocess_recipes(ORE_CATEGORY_ID)
        .map_err(|e| e.to_string())?;

    // Price every ore plus every distinct output mineral at the chosen market.
    let mut ids: HashSet<i64> = HashSet::new();
    for r in &recipes {
        ids.insert(r.type_id);
        ids.extend(r.outputs.iter().map(|o| o.material_type_id));
    }
    let ids: Vec<i64> = ids.into_iter().collect();
    let location = resolve_location(params.region_id, params.station_id);
    let prices = market
        .price_map_at(location, &ids)
        .await
        .map_err(|e| e.to_string())?;
    let sell = |type_id: i64| prices.sell(type_id);

    let efficiency = ore_efficiency(&EfficiencyConfig {
        reprocessing: params.reprocessing,
        reprocessing_efficiency: params.reprocessing_efficiency,
        ore_processing: params.ore_processing,
        implant_pct: params.implant_pct,
        rig_bonus_pct: params.rig_bonus_pct,
        structure_mult: params.structure_mult,
        security_mult: params.security_mult,
    });

    let (blacklist, favorites) =
        lists::load_filter_sets(&dir, REPROCESSING_BLACKLIST_KEY, REPROCESSING_FAVORITES_KEY);
    let groups = sde.group_names().map_err(|e| e.to_string())?;

    let mut out: Vec<ReprocessRow> = recipes
        .iter()
        .filter(|r| !blacklist.contains(&r.type_id))
        .filter_map(|r| {
            let mut row = evaluate(
                r,
                efficiency,
                sell(r.type_id),
                sell,
                favorites.contains(&r.type_id),
            )?;
            // Only ores that are actually priced (have a sell or a refine value).
            if row.sell_price.is_none() && row.reprocess_value <= 0.0 {
                return None;
            }
            row.group = groups.get(&r.type_id).cloned();
            Some(row)
        })
        .collect();

    // Rank by the refine uplift (best reprocess-vs-sell first).
    out.sort_by(|a, b| {
        b.delta
            .partial_cmp(&a.delta)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    out.truncate(RESULT_CAP);
    Ok(out)
}

/// The reprocessing efficiency for the given inputs (so the UI can show it).
#[tauri::command]
pub fn reprocessing_efficiency(params: ReprocessParams) -> f64 {
    ore_efficiency(&EfficiencyConfig {
        reprocessing: params.reprocessing,
        reprocessing_efficiency: params.reprocessing_efficiency,
        ore_processing: params.ore_processing,
        implant_pct: params.implant_pct,
        rig_bonus_pct: params.rig_bonus_pct,
        structure_mult: params.structure_mult,
        security_mult: params.security_mult,
    })
}

#[tauri::command]
pub fn reprocessing_get_list(app: AppHandle, list: String) -> Result<Vec<ListItem>, String> {
    let key = list_key(&list)?;
    lists::get_from_app(&app, key)
}

#[tauri::command]
pub fn reprocessing_set_list(
    app: AppHandle,
    list: String,
    type_id: i64,
    add: bool,
) -> Result<(), String> {
    let key = list_key(&list)?;
    lists::set_from_app(&app, key, type_id, add)
}
