//! Tauri command surface for the production module.

use std::collections::HashMap;

use serde::Deserialize;
use tauri::{AppHandle, Manager, State};

use crate::market::{
    default_region_id, location_label, resolve_location, MarketService, PriceModel,
};
use crate::sde::{Sde, SdePaths};

use super::engine::{
    evaluate, manufacturing_step, InputLine, Invention, PriceBasis, ProfitBreakdown, ProfitConfig,
    Sourcing,
};

fn default_runs() -> i64 {
    1
}

/// Parameters for the production ranking. Everything here affects pricing/cost,
/// so changing one re-runs the calculation; the UI filters the results.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfitParams {
    /// Region to price against (default The Forge).
    #[serde(default = "default_region_id")]
    pub region_id: i64,
    /// Station within the region; `None` prices against the region average.
    #[serde(default)]
    pub station_id: Option<i64>,
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
    /// Amortized blueprint acquisition cost per run (e.g. a faction BPC).
    #[serde(default)]
    pub blueprint_cost_per_run: f64,
}

/// Rank **every** manufacturable item by build-vs-buy profit at the chosen
/// market. The whole catalogue is returned; the UI filters it client-side.
#[tauri::command]
pub async fn production_profit(
    app: AppHandle,
    market: State<'_, MarketService>,
    params: ProfitParams,
) -> Result<Vec<ProfitBreakdown>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let sde = Sde::open(&SdePaths::new(dir).db).map_err(|e| e.to_string())?;

    // Build a manufacturing step for every manufacturable blueprint, collecting
    // the type ids we need prices for.
    let mut steps = Vec::new();
    let mut needed = std::collections::HashSet::new();
    for bp in sde.manufacturable_blueprints().map_err(|e| e.to_string())? {
        let product = crate::sde::BlueprintProduct {
            product_type_id: bp.product_type_id,
            name: bp.product_name,
            quantity: bp.product_quantity,
        };
        let materials = sde
            .blueprint_materials(bp.blueprint_type_id)
            .map_err(|e| e.to_string())?;
        needed.insert(product.product_type_id);
        needed.extend(materials.iter().map(|m| m.material_type_id));

        let mut step = manufacturing_step(bp.blueprint_type_id, &product, &materials);
        // T2 items: attach the invention so its expected cost is amortized in.
        if let Some(inv) = sde
            .invention_for(bp.blueprint_type_id)
            .map_err(|e| e.to_string())?
        {
            needed.extend(inv.datacores.iter().map(|d| d.material_type_id));
            step.invention = Some(Invention {
                datacores: inv
                    .datacores
                    .iter()
                    .map(|d| InputLine {
                        type_id: d.material_type_id,
                        name: d.name.clone(),
                        base_quantity: d.quantity,
                        sourcing: Sourcing::Buy,
                    })
                    .collect(),
                runs_per_success: inv.runs_per_success,
                probability: inv.probability,
            });
        }
        steps.push(step);
    }
    let ids: Vec<i64> = needed.into_iter().collect();

    // Price everything at the chosen location (Fuzzwork aggregates + ESI adjusted).
    let location = resolve_location(params.region_id, params.station_id);
    let market_name = location_label(params.region_id, params.station_id);
    let prices: HashMap<i64, PriceModel> = market
        .price_models_at(location, &ids)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|m| (m.type_id, m))
        .collect();

    let defaults = ProfitConfig::default();
    let config = ProfitConfig {
        system_cost_index: params.system_cost_index,
        facility_tax: params.facility_tax,
        material_basis: params.material_basis.unwrap_or(PriceBasis::SellPercentile),
        product_basis: params.product_basis.unwrap_or(PriceBasis::SellPercentile),
        blueprint_cost_per_run: params.blueprint_cost_per_run,
        ..defaults
    };

    let meta = sde.meta_group_names().map_err(|e| e.to_string())?;
    let categories = sde.category_names().map_err(|e| e.to_string())?;

    let mut out: Vec<ProfitBreakdown> = steps
        .iter()
        .map(|step| {
            let mut bd = evaluate(step, params.runs, params.me, &prices, &config);
            bd.meta_group = Some(
                meta.get(&bd.product_type_id)
                    .cloned()
                    .unwrap_or_else(|| "Tech I".to_string()),
            );
            bd.category = categories.get(&bd.product_type_id).cloned();
            bd.market = Some(market_name.clone());
            bd
        })
        .collect();

    out.sort_by(|a, b| {
        b.profit
            .partial_cmp(&a.profit)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(out)
}
