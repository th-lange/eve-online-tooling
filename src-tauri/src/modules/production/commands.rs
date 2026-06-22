//! Tauri command surface for the production module.

use std::collections::{HashMap, HashSet};

use serde::Deserialize;
use tauri::{AppHandle, Manager, State};

use crate::market::{MarketService, PriceModel};
use crate::sde::{Sde, SdePaths};

use super::engine::{evaluate, manufacturing_step, ProfitBreakdown, ProfitConfig};

fn default_runs() -> i64 {
    1
}

/// Parameters for a profit ranking. Callers pass the blueprints to evaluate
/// (e.g. the character's owned blueprints) plus runs/ME and optional fee inputs.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfitParams {
    pub blueprint_type_ids: Vec<i64>,
    #[serde(default = "default_runs")]
    pub runs: i64,
    #[serde(default)]
    pub me: i64,
    #[serde(default)]
    pub system_cost_index: f64,
    #[serde(default)]
    pub facility_tax: f64,
}

/// Evaluate and rank the given blueprints by profit (descending).
///
/// Pulls each blueprint's materials/product from the local SDE, fetches the
/// needed market prices in one batch, runs the engine, and sorts.
#[tauri::command]
pub async fn production_profit(
    app: AppHandle,
    market: State<'_, MarketService>,
    params: ProfitParams,
) -> Result<Vec<ProfitBreakdown>, String> {
    // Open the SDE (read-only) from the app data dir.
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let sde = Sde::open(&SdePaths::new(dir).db).map_err(|e| e.to_string())?;

    // Build a manufacturing step per blueprint, collecting every type id we'll
    // need a price for.
    let mut steps = Vec::new();
    let mut needed: HashSet<i64> = HashSet::new();
    for &bp in &params.blueprint_type_ids {
        let Some(product) = sde.blueprint_product(bp).map_err(|e| e.to_string())? else {
            continue; // not a manufacturing blueprint
        };
        let materials = sde.blueprint_materials(bp).map_err(|e| e.to_string())?;
        needed.insert(product.product_type_id);
        needed.extend(materials.iter().map(|m| m.material_type_id));
        steps.push(manufacturing_step(bp, &product, &materials));
    }

    // Fetch all needed prices once.
    let ids: Vec<i64> = needed.into_iter().collect();
    let prices: HashMap<i64, PriceModel> = market
        .price_models(&ids)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|m| (m.type_id, m))
        .collect();

    let config = ProfitConfig {
        system_cost_index: params.system_cost_index,
        facility_tax: params.facility_tax,
        ..Default::default()
    };

    let mut out: Vec<ProfitBreakdown> = steps
        .iter()
        .map(|step| evaluate(step, params.runs, params.me, &prices, &config))
        .collect();
    out.sort_by(|a, b| {
        b.profit
            .partial_cmp(&a.profit)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(out)
}
