//! Tauri command surface for the production module.

use std::collections::HashMap;

use serde::Deserialize;
use tauri::{AppHandle, Manager, State};

use crate::lists::{self, ListItem};
use crate::market::{
    default_region_id, location_label, resolve_location, MarketService, PriceModel,
};
use crate::sde::{Sde, SdePaths};
use crate::storage;

use super::engine::{
    evaluate, manufacturing_step, Activity, BuildStep, InputLine, Invention, PriceBasis,
    ProfitBreakdown, ProfitConfig, Sourcing,
};
use crate::sde::Recipe;

/// How deep the recursive build-vs-buy tree is resolved.
const MAX_TREE_DEPTH: u32 = 5;

/// Resolve a material into an [`InputLine`], recursively attaching a `Build`
/// sub-step when the material has a recipe (manufacturing or reaction). Recipes
/// are memoized; `path` guards against cycles.
#[allow(clippy::too_many_arguments)]
fn resolve_input(
    sde: &Sde,
    cache: &mut HashMap<i64, Option<Recipe>>,
    needed: &mut std::collections::HashSet<i64>,
    type_id: i64,
    name: String,
    base_quantity: i64,
    depth: u32,
    path: &mut Vec<i64>,
) -> Result<InputLine, String> {
    needed.insert(type_id);
    let sourcing = if depth == 0 || path.contains(&type_id) {
        Sourcing::Buy
    } else {
        let recipe = match cache.get(&type_id) {
            Some(r) => r.clone(),
            None => {
                let r = sde.recipe_for(type_id).map_err(|e| e.to_string())?;
                cache.insert(type_id, r.clone());
                r
            }
        };
        match recipe {
            Some(recipe) => {
                path.push(type_id);
                let mut inputs = Vec::with_capacity(recipe.materials.len());
                for m in &recipe.materials {
                    inputs.push(resolve_input(
                        sde,
                        cache,
                        needed,
                        m.material_type_id,
                        m.name.clone(),
                        m.quantity,
                        depth - 1,
                        path,
                    )?);
                }
                path.pop();
                let activity = if recipe.activity_id == 11 {
                    Activity::Reaction
                } else {
                    Activity::Manufacturing
                };
                Sourcing::Build(Box::new(BuildStep {
                    activity,
                    blueprint_type_id: recipe.blueprint_type_id,
                    product_type_id: type_id,
                    product_name: name.clone(),
                    product_per_run: recipe.product_quantity,
                    inputs,
                    invention: None,
                }))
            }
            None => Sourcing::Buy,
        }
    };
    Ok(InputLine {
        type_id,
        name,
        base_quantity,
        sourcing,
    })
}

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
    /// Per-blueprint researched ME, keyed by blueprint type id, from the owned
    /// blueprint library. When a blueprint is owned, its real ME overrides the
    /// global `me` above (T2/T3 rows still use the invented BPC's ME). Empty by
    /// default; the UI populates it from the logged-in characters' blueprints.
    #[serde(default)]
    pub owned_me: HashMap<i64, i64>,
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
    /// Inventor science/encryption skill level (0..5) scaling invention
    /// probability. Default 5 (all V).
    #[serde(default)]
    pub invention_skill_level: Option<i64>,
    /// Decryptor type to apply to every T2 invention; `None` = no decryptor.
    #[serde(default)]
    pub decryptor_type_id: Option<i64>,
    /// Price the product at whichever hub pays the most (vs the chosen market).
    /// Materials are still priced at the chosen market.
    #[serde(default)]
    pub product_best_hub: bool,
    /// Time efficiency (default for un-owned blueprints), 0..20.
    #[serde(default)]
    pub te: i64,
    /// Per-blueprint researched TE (blueprintTypeId → TE) from the owned library.
    #[serde(default)]
    pub owned_te: HashMap<i64, i64>,
    /// Industry time-skill level (0..5): Industry −4%/lvl × Advanced Industry −3%/lvl.
    #[serde(default)]
    pub time_skill: i64,
    /// Structure time-efficiency bonus, percent (e.g. Raitaru 15, Sotiyo 30).
    #[serde(default)]
    pub structure_te_pct: f64,
    /// Combined structure+rig material multiplier (1.0 = none, 0.99 = −1%).
    #[serde(default = "default_me_bonus")]
    pub me_bonus: f64,
    /// Combined structure+rig cost saving on the cost-index portion (0..1).
    #[serde(default)]
    pub cost_bonus: f64,
    /// SCC surcharge fraction of EIV (CCP's 4% manufacturing default).
    #[serde(default = "default_scc")]
    pub scc_surcharge: f64,
}

fn default_me_bonus() -> f64 {
    1.0
}
fn default_scc() -> f64 {
    0.04
}

/// Base material efficiency of a freshly invented T2 blueprint copy (no decryptor).
const BASE_T2_ME: i64 = 2;

/// Rank **every** manufacturable item by build-vs-buy profit at the chosen
/// market. The whole catalogue is returned; the UI filters it client-side.
#[tauri::command]
pub async fn production_profit(
    app: AppHandle,
    market: State<'_, MarketService>,
    params: ProfitParams,
) -> Result<Vec<ProfitBreakdown>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let sde = Sde::open(&SdePaths::new(dir.clone()).db).map_err(|e| e.to_string())?;

    // Saved lists are keyed by blueprint type id (the ranking row's identity):
    // blacklisted blueprints are dropped, favorites are flagged for the UI.
    let blacklist: std::collections::HashSet<i64> =
        storage::load_id_list(&dir, PRODUCTION_BLACKLIST_KEY)
            .into_iter()
            .collect();
    let favorites: std::collections::HashSet<i64> =
        storage::load_id_list(&dir, PRODUCTION_FAVORITES_KEY)
            .into_iter()
            .collect();

    // Resolve the chosen decryptor (if any) once up front.
    let decryptor = match params.decryptor_type_id {
        Some(id) => sde
            .decryptors()
            .map_err(|e| e.to_string())?
            .into_iter()
            .find(|d| d.type_id == id),
        None => None,
    };

    // Build a manufacturing step for every manufacturable blueprint, collecting
    // the type ids we need prices for.
    let mut steps = Vec::new();
    let mut needed = std::collections::HashSet::new();
    let mut recipe_cache: HashMap<i64, Option<Recipe>> = HashMap::new();
    for bp in sde.manufacturable_blueprints().map_err(|e| e.to_string())? {
        if blacklist.contains(&bp.blueprint_type_id) {
            continue;
        }
        let product = crate::sde::BlueprintProduct {
            product_type_id: bp.product_type_id,
            name: bp.product_name,
            quantity: bp.product_quantity,
        };
        let materials = sde
            .blueprint_materials(bp.blueprint_type_id)
            .map_err(|e| e.to_string())?;
        needed.insert(product.product_type_id);

        let mut step = manufacturing_step(bp.blueprint_type_id, &product, &materials);
        // Recursively resolve each material into a build-or-buy sub-tree.
        let mut path = vec![product.product_type_id];
        let mut inputs = Vec::with_capacity(materials.len());
        for m in &materials {
            inputs.push(resolve_input(
                &sde,
                &mut recipe_cache,
                &mut needed,
                m.material_type_id,
                m.name.clone(),
                m.quantity,
                MAX_TREE_DEPTH,
                &mut path,
            )?);
        }
        step.inputs = inputs;
        // T2 items: attach the invention so its expected cost is amortized in.
        if let Some(inv) = sde
            .invention_for(bp.blueprint_type_id)
            .map_err(|e| e.to_string())?
        {
            // T1 product's manufacturing materials estimate the copy job fee.
            let copy_materials = sde
                .blueprint_materials(inv.inventing_blueprint_type_id)
                .map_err(|e| e.to_string())?;
            needed.extend(inv.datacores.iter().map(|d| d.material_type_id));
            needed.extend(copy_materials.iter().map(|m| m.material_type_id));
            let to_input = |m: &crate::sde::BlueprintMaterial| InputLine {
                type_id: m.material_type_id,
                name: m.name.clone(),
                base_quantity: m.quantity,
                sourcing: Sourcing::Buy,
            };
            // A decryptor shifts ME/runs/probability and is consumed per attempt.
            let mut datacores: Vec<InputLine> = inv.datacores.iter().map(to_input).collect();
            // T3 invention consumes an Ancient Relic bought at market; price it in
            // as a per-attempt input (it has no copy fee — relics aren't copied).
            if let Some(relic) = &inv.relic {
                needed.insert(relic.material_type_id);
                datacores.push(to_input(relic));
            }
            let (result_me, runs_per_success, probability) = match &decryptor {
                Some(d) => {
                    needed.insert(d.type_id);
                    datacores.push(InputLine {
                        type_id: d.type_id,
                        name: d.name.clone(),
                        base_quantity: 1,
                        sourcing: Sourcing::Buy,
                    });
                    (
                        BASE_T2_ME + d.me_modifier,
                        inv.runs_per_success + d.run_modifier,
                        inv.probability * d.probability_multiplier,
                    )
                }
                None => (BASE_T2_ME, inv.runs_per_success, inv.probability),
            };
            step.invention = Some(Invention {
                datacores,
                copy_materials: copy_materials.iter().map(to_input).collect(),
                runs_per_success,
                probability,
                result_me,
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

    // Invention probability multiplier from skills (1 + L/40 + 2L/30); all-V ≈ 1.458.
    let skill = params.invention_skill_level.unwrap_or(5).clamp(0, 5) as f64;
    let invention_skill_multiplier = 1.0 + skill / 40.0 + 2.0 * skill / 30.0;
    let defaults = ProfitConfig::default();
    let config = ProfitConfig {
        system_cost_index: params.system_cost_index,
        facility_tax: params.facility_tax,
        material_basis: params.material_basis.unwrap_or(PriceBasis::SellPercentile),
        product_basis: params.product_basis.unwrap_or(PriceBasis::SellPercentile),
        blueprint_cost_per_run: params.blueprint_cost_per_run,
        invention_skill_multiplier,
        me_bonus: params.me_bonus,
        cost_bonus: params.cost_bonus,
        scc_surcharge: params.scc_surcharge,
        ..defaults
    };

    let meta = sde.meta_group_names().map_err(|e| e.to_string())?;
    let categories = sde.category_names().map_err(|e| e.to_string())?;
    let groups = sde.group_names().map_err(|e| e.to_string())?;
    let base_times = sde.base_times(1).map_err(|e| e.to_string())?; // 1 = manufacturing

    // Job-time multipliers shared by every row: Industry (−4%/lvl) × Advanced
    // Industry (−3%/lvl) × structure TE bonus.
    let l = params.time_skill.clamp(0, 5) as f64;
    let time_skill_mult = (1.0 - 0.04 * l) * (1.0 - 0.03 * l);
    let structure_te_mult = 1.0 - params.structure_te_pct / 100.0;

    let mut out: Vec<ProfitBreakdown> = steps
        .iter()
        .map(|step| {
            // Owned blueprints use their researched ME; everything else the
            // global ME slider. (T2/T3 rows override with the invented BPC's ME
            // inside evaluate regardless.)
            let step_me = params
                .owned_me
                .get(&step.blueprint_type_id)
                .copied()
                .unwrap_or(params.me);
            let mut bd = evaluate(step, params.runs, step_me, &prices, &config);
            // Job time = base × runs × (1 − TE/100) × skill × structure.
            let te = params
                .owned_te
                .get(&step.blueprint_type_id)
                .copied()
                .unwrap_or(params.te);
            if let Some(&base) = base_times.get(&step.blueprint_type_id) {
                bd.job_time_seconds = base as f64
                    * params.runs as f64
                    * (1.0 - te as f64 / 100.0)
                    * time_skill_mult
                    * structure_te_mult;
            }
            bd.meta_group = Some(
                meta.get(&bd.product_type_id)
                    .cloned()
                    .unwrap_or_else(|| "Tech I".to_string()),
            );
            bd.category = categories.get(&bd.product_type_id).cloned();
            bd.group = groups.get(&bd.product_type_id).cloned();
            bd.market = Some(market_name.clone());
            bd.favorite = favorites.contains(&bd.blueprint_type_id);
            bd
        })
        .collect();

    // "Sell at best hub": re-price each product at whichever hub pays the most
    // and recompute the profit fields. Materials stay at the chosen market.
    if params.product_best_hub {
        let product_ids: Vec<i64> = out.iter().map(|r| r.product_type_id).collect();
        let best = market
            .best_sell_hubs(&product_ids)
            .await
            .map_err(|e| e.to_string())?;
        for bd in &mut out {
            if let Some(b) = best.get(&bd.product_type_id) {
                if b.price > bd.product_price.unwrap_or(0.0) {
                    reprice_product(bd, b.price, &b.hub);
                }
            }
        }
        out.sort_by(|a, b| {
            b.profit
                .partial_cmp(&a.profit)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        return Ok(out);
    }

    out.sort_by(|a, b| {
        b.profit
            .partial_cmp(&a.profit)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(out)
}

/// Re-price a breakdown's product at `unit_price` (the best hub's sell price)
/// and recompute the dependent profit fields. Production values revenue gross
/// (no sales cost), so revenue = units × price; cost is unchanged.
fn reprice_product(bd: &mut ProfitBreakdown, unit_price: f64, hub: &str) {
    let cost = bd.material_cost + bd.job_fee + bd.blueprint_cost + bd.invention_cost;
    bd.product_price = Some(unit_price);
    bd.revenue = bd.units_produced as f64 * unit_price;
    bd.profit = bd.revenue - cost;
    bd.margin = (bd.revenue > 0.0).then(|| bd.profit / bd.revenue);
    bd.roi = (cost > 0.0).then(|| bd.profit / cost);
    bd.profit_per_unit = if bd.units_produced > 0 {
        bd.profit / bd.units_produced as f64
    } else {
        0.0
    };
    bd.sell_hub = Some(hub.to_string());
}

/// The invention decryptors (for the UI dropdown).
#[tauri::command]
pub async fn production_decryptors(app: AppHandle) -> Result<Vec<crate::sde::Decryptor>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let sde = Sde::open(&SdePaths::new(dir).db).map_err(|e| e.to_string())?;
    sde.decryptors().map_err(|e| e.to_string())
}

/// Storage keys for production's saved lists — distinct from trading's so the
/// two modules' blacklists/favorites never collide.
const PRODUCTION_BLACKLIST_KEY: &str = "production_blacklist";
const PRODUCTION_FAVORITES_KEY: &str = "production_favorites";

/// Map the UI's logical list name to its (module-scoped) storage key.
fn list_key(list: &str) -> Result<&'static str, String> {
    match list {
        "blacklist" => Ok(PRODUCTION_BLACKLIST_KEY),
        "favorites" => Ok(PRODUCTION_FAVORITES_KEY),
        _ => Err(format!("unknown list: {list}")),
    }
}

/// The contents of a production saved list (`blacklist` or `favorites`), with
/// names. Ids are blueprint type ids.
#[tauri::command]
pub fn production_get_list(app: AppHandle, list: String) -> Result<Vec<ListItem>, String> {
    let key = list_key(&list)?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let sde = Sde::open(&SdePaths::new(dir.clone()).db).map_err(|e| e.to_string())?;
    Ok(lists::get(&sde, &dir, key))
}

/// Add or remove a blueprint type from a production saved list.
#[tauri::command]
pub fn production_set_list(
    app: AppHandle,
    list: String,
    type_id: i64,
    add: bool,
) -> Result<(), String> {
    let key = list_key(&list)?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    lists::set(&dir, key, type_id, add)
}
