//! Tauri command surface for the production module.

use std::collections::{HashMap, HashSet};

use serde::Deserialize;
use tauri::{AppHandle, Manager, State};

use crate::market::{MarketService, PriceModel};
use crate::sde::{BlueprintProduct, Sde, SdePaths};

use super::engine::{evaluate, manufacturing_step, PriceBasis, ProfitBreakdown, ProfitConfig};

fn default_runs() -> i64 {
    1
}

/// Which blueprints to evaluate.
#[derive(Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub enum ProfitMode {
    /// Only the blueprints in `blueprint_type_ids`, priced precisely (spot
    /// orders + history + volume).
    #[default]
    Selected,
    /// Every manufacturable blueprint, priced cheaply with global average
    /// prices (one ESI call; no spot/volume).
    All,
}

/// Parameters for a profit ranking.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfitParams {
    #[serde(default)]
    pub mode: ProfitMode,
    /// Used in `Selected` mode.
    #[serde(default)]
    pub blueprint_type_ids: Vec<i64>,
    #[serde(default = "default_runs")]
    pub runs: i64,
    #[serde(default)]
    pub me: i64,
    #[serde(default)]
    pub system_cost_index: f64,
    #[serde(default)]
    pub facility_tax: f64,
    #[serde(default)]
    pub material_basis: Option<PriceBasis>,
    #[serde(default)]
    pub product_basis: Option<PriceBasis>,
}

/// Evaluate and rank blueprints by profit (descending).
///
/// In `Selected` mode it prices each blueprint precisely; in `All` mode it
/// ranks the whole catalogue using global average prices (one ESI call).
#[tauri::command]
pub async fn production_profit(
    app: AppHandle,
    market: State<'_, MarketService>,
    params: ProfitParams,
) -> Result<Vec<ProfitBreakdown>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let sde = Sde::open(&SdePaths::new(dir).db).map_err(|e| e.to_string())?;

    // Resolve the (blueprint, product) set for the chosen mode.
    let blueprints: Vec<(i64, BlueprintProduct)> = match params.mode {
        ProfitMode::All => sde
            .manufacturable_blueprints()
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|b| {
                (
                    b.blueprint_type_id,
                    BlueprintProduct {
                        product_type_id: b.product_type_id,
                        name: b.product_name,
                        quantity: b.product_quantity,
                    },
                )
            })
            .collect(),
        ProfitMode::Selected => {
            let mut v = Vec::new();
            for &bp in &params.blueprint_type_ids {
                if let Some(product) = sde.blueprint_product(bp).map_err(|e| e.to_string())? {
                    v.push((bp, product));
                }
            }
            v
        }
    };

    // Build a manufacturing step per blueprint, collecting the type ids we need
    // prices for.
    let mut steps = Vec::with_capacity(blueprints.len());
    let mut needed: HashSet<i64> = HashSet::new();
    for (bp, product) in &blueprints {
        let materials = sde.blueprint_materials(*bp).map_err(|e| e.to_string())?;
        needed.insert(product.product_type_id);
        needed.extend(materials.iter().map(|m| m.material_type_id));
        steps.push(manufacturing_step(*bp, product, &materials));
    }

    // Price the needed types — precisely (Selected) or in bulk (All).
    let ids: Vec<i64> = needed.into_iter().collect();
    let price_list = match params.mode {
        ProfitMode::All => market.average_price_models(&ids).await,
        ProfitMode::Selected => market.price_models(&ids).await,
    }
    .map_err(|e| e.to_string())?;
    let prices: HashMap<i64, PriceModel> = price_list.into_iter().map(|m| (m.type_id, m)).collect();

    // In All mode only average prices are available, so force that basis.
    let defaults = ProfitConfig::default();
    let (material_basis, product_basis) = match params.mode {
        ProfitMode::All => (PriceBasis::AveragePrice, PriceBasis::AveragePrice),
        ProfitMode::Selected => (
            params.material_basis.unwrap_or(defaults.material_basis),
            params.product_basis.unwrap_or(defaults.product_basis),
        ),
    };
    let config = ProfitConfig {
        system_cost_index: params.system_cost_index,
        facility_tax: params.facility_tax,
        material_basis,
        product_basis,
        ..defaults
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
