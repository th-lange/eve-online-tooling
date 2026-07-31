//! Tauri command surface for the production module.

use std::collections::HashMap;

use serde::Deserialize;
use tauri::{AppHandle, State};

use crate::esi::EsiClient;
use crate::lists::{self, ListItem};
use crate::market::{default_region_id, location_label, resolve_location, MarketService};
use crate::sde::Sde;
use crate::storage;

use super::engine::{
    evaluate_with_stock, manufacturing_step, Activity, BuildStep, InputLine, Invention, PriceBasis,
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
    build: bool,
    path: &mut Vec<i64>,
) -> Result<InputLine, String> {
    needed.insert(type_id);
    let sourcing = if !build || depth == 0 || path.contains(&type_id) {
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
                        build,
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
    /// Owned stock per type id (from `roster_stock`); netted against the
    /// top-level bill of materials so you only buy the shortfall. Empty = none.
    #[serde(default)]
    pub stock: HashMap<i64, i64>,
    /// Build sub-components (recursive build-vs-buy). When false, every material
    /// is simply bought at market — no intermediate manufacturing. Default true.
    #[serde(default = "default_build_components")]
    pub build_components: bool,
    /// Subtract sale costs (broker fee + sales tax) from product revenue.
    #[serde(default)]
    pub include_sales_cost: bool,
    /// Sales tax fraction applied to revenue (when `include_sales_cost`).
    #[serde(default)]
    pub sales_tax: f64,
    /// Broker fee fraction applied to revenue (when `include_sales_cost`).
    #[serde(default)]
    pub broker_fee: f64,
}

fn default_build_components() -> bool {
    true
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
    let (dir, sde) = crate::sde::dir_and_sde(&app)?;

    // Saved lists are keyed by blueprint type id (the ranking row's identity):
    // blacklisted blueprints are dropped, favorites are flagged for the UI.
    let (blacklist, favorites) =
        lists::load_filter_sets(&dir, PRODUCTION_BLACKLIST_KEY, PRODUCTION_FAVORITES_KEY);

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
                params.build_components,
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
                base_blueprint_type_id: inv.inventing_blueprint_type_id,
            });
        }
        steps.push(step);
    }
    let ids: Vec<i64> = needed.into_iter().collect();

    // Price everything at the chosen location (Fuzzwork aggregates + ESI adjusted).
    let location = resolve_location(params.region_id, params.station_id);
    let market_name = location_label(params.region_id, params.station_id);
    let prices = market
        .price_map_at(location, &ids)
        .await
        .map_err(|e| e.to_string())?;

    // Invention probability multiplier from skills (1 + L/40 + 2L/30); all-V ≈ 1.458.
    let skill = params.invention_skill_level.unwrap_or(5).clamp(0, 5) as f64;
    let invention_skill_multiplier = 1.0 + skill / 40.0 + 2.0 * skill / 30.0;
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
        include_sales_cost: params.include_sales_cost,
        sales_tax: params.sales_tax,
        broker_fee: params.broker_fee,
    };

    let meta = sde.meta_group_names().map_err(|e| e.to_string())?;
    let categories = sde.category_names().map_err(|e| e.to_string())?;
    let groups = sde.group_names().map_err(|e| e.to_string())?;
    let base_times = sde.base_times(1).map_err(|e| e.to_string())?; // 1 = manufacturing
                                                                    // Names for the T1 (or T3 relic) blueprint each T2/T3 row is invented
                                                                    // from, so the UI can show what a "build" actually starts from.
    let base_bp_ids: Vec<i64> = steps
        .iter()
        .filter_map(|s| s.invention.as_ref().map(|i| i.base_blueprint_type_id))
        .collect();
    let base_bp_names: HashMap<i64, String> = sde
        .type_names(&base_bp_ids)
        .map_err(|e| e.to_string())?
        .into_iter()
        .collect();

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
            let mut bd = evaluate_with_stock(
                step,
                params.runs,
                step_me,
                prices.as_map(),
                &config,
                &params.stock,
            );
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
            if let Some(inv) = bd.invention.as_mut() {
                inv.base_blueprint_name = base_bp_names
                    .get(&inv.base_blueprint_type_id)
                    .cloned()
                    .unwrap_or_default();
            }
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
        // Same revenue basis the engine used, so repriced and untouched rows
        // stay comparable.
        let sales_cost = if params.include_sales_cost {
            params.sales_tax + params.broker_fee
        } else {
            0.0
        };
        for bd in &mut out {
            if let Some(b) = best.get(&bd.product_type_id) {
                if b.price > bd.product_price.unwrap_or(0.0) {
                    reprice_product(bd, b.price, &b.hub, sales_cost);
                }
            }
        }
    }

    out.sort_by(|a, b| {
        b.profit
            .partial_cmp(&a.profit)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(out)
}

/// Re-price a breakdown's product at `unit_price` (the best hub's sell price)
/// and recompute the dependent profit fields. `sales_cost` is the combined
/// sales-tax + broker-fee fraction taken off revenue (0.0 when the caller
/// values revenue gross) — it must match the basis the engine used, or
/// repriced rows would not be comparable with the rest. Cost is unchanged.
/// Pure (testable).
fn reprice_product(bd: &mut ProfitBreakdown, unit_price: f64, hub: &str, sales_cost: f64) {
    let cost = bd.material_cost + bd.job_fee + bd.blueprint_cost + bd.invention_cost;
    bd.product_price = Some(unit_price);
    bd.revenue = bd.units_produced as f64 * unit_price * (1.0 - sales_cost);
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
    let sde = crate::sde::open_from_app(&app)?;
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
    lists::get_from_app(&app, key)
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
    lists::set_from_app(&app, key, type_id, add)
}

// --- Live per-system industry cost index (ESI /industry/systems/) ---

#[derive(Deserialize)]
struct EsiIndustrySystem {
    solar_system_id: i64,
    cost_indices: Vec<EsiCostIndex>,
}
#[derive(Deserialize)]
struct EsiCostIndex {
    activity: String,
    cost_index: f64,
}

/// The **manufacturing** cost index CCP applies to job fees in a solar system,
/// from ESI `/industry/systems/` (public). The full list is fetched once and
/// cached ~1h on disk, then looked up per system. `None` when the system isn't
/// listed (e.g. wormhole space). Lets the production tab use the real index
/// instead of a hand-entered guess.
#[tauri::command]
pub async fn production_system_cost_index(
    app: AppHandle,
    esi: State<'_, EsiClient>,
    system_id: i64,
) -> Result<Option<f64>, String> {
    let dir = crate::storage::app_data_dir(&app)?;
    let map: HashMap<i64, f64> = match storage::cache_get(&dir, "industry_cost_indices") {
        Some(cached) => cached,
        None => {
            let systems: Vec<EsiIndustrySystem> = esi
                .get_json("/latest/industry/systems/", &[])
                .await
                .map_err(|e| e.to_string())?;
            let map: HashMap<i64, f64> = systems
                .into_iter()
                .filter_map(|s| {
                    s.cost_indices
                        .iter()
                        .find(|c| c.activity == "manufacturing")
                        .map(|c| (s.solar_system_id, c.cost_index))
                })
                .collect();
            let _ = storage::cache_put(&dir, "industry_cost_indices", &map, 3600);
            map
        }
    };
    Ok(map.get(&system_id).copied())
}

#[cfg(test)]
mod resolve_input_tests {
    use std::collections::HashSet;

    use crate::sde::test_sde;

    use super::*;

    /// A↔B cycle: blueprint 11 (product A=10) needs 1x B=20; blueprint 21
    /// (product B=20) needs 1x A=10.
    fn cycle_sde() -> Sde {
        test_sde(
            "CREATE TABLE invTypes(typeID INT, typeName TEXT);
             INSERT INTO invTypes VALUES (10, 'A'), (20, 'B');
             CREATE TABLE industryActivityProducts(typeID INT, activityID INT, productTypeID INT, quantity INT);
             CREATE TABLE industryActivityMaterials(typeID INT, activityID INT, materialTypeID INT, quantity INT);
             INSERT INTO industryActivityProducts VALUES (11, 1, 10, 1), (21, 1, 20, 1);
             INSERT INTO industryActivityMaterials VALUES (11, 1, 20, 1), (21, 1, 10, 1);",
        )
    }

    /// A straight-line chain A=10 -> B=20 -> C=30, where C is a raw material
    /// with no recipe of its own (a genuine Buy leaf).
    fn chain_sde() -> Sde {
        test_sde(
            "CREATE TABLE invTypes(typeID INT, typeName TEXT);
             INSERT INTO invTypes VALUES (10, 'A'), (20, 'B'), (30, 'C');
             CREATE TABLE industryActivityProducts(typeID INT, activityID INT, productTypeID INT, quantity INT);
             CREATE TABLE industryActivityMaterials(typeID INT, activityID INT, materialTypeID INT, quantity INT);
             INSERT INTO industryActivityProducts VALUES (11, 1, 10, 1), (21, 1, 20, 1);
             INSERT INTO industryActivityMaterials VALUES (11, 1, 20, 1), (21, 1, 30, 1);",
        )
    }

    /// Reaction formula 500 (activityID 11) makes 100x Composite (600) from
    /// 50x Tritanium (200, a Buy leaf).
    fn reaction_sde() -> Sde {
        test_sde(
            "CREATE TABLE invTypes(typeID INT, typeName TEXT);
             INSERT INTO invTypes VALUES (200, 'Tritanium'), (600, 'Composite');
             CREATE TABLE industryActivityProducts(typeID INT, activityID INT, productTypeID INT, quantity INT);
             CREATE TABLE industryActivityMaterials(typeID INT, activityID INT, materialTypeID INT, quantity INT);
             INSERT INTO industryActivityProducts VALUES (500, 11, 600, 100);
             INSERT INTO industryActivityMaterials VALUES (500, 11, 200, 50);",
        )
    }

    fn build_step(line: &InputLine) -> &BuildStep {
        match &line.sourcing {
            Sourcing::Build(step) => step,
            Sourcing::Buy => panic!("expected {} to be Build, got Buy", line.type_id),
        }
    }

    fn assert_buy(line: &InputLine) {
        assert!(
            matches!(line.sourcing, Sourcing::Buy),
            "expected {} to be Buy",
            line.type_id
        );
    }

    #[test]
    fn cycle_terminates_with_inner_recurrence_bought() {
        let sde = cycle_sde();
        let mut cache = HashMap::new();
        let mut needed = HashSet::new();
        let mut path = Vec::new();

        let root = resolve_input(
            &sde,
            &mut cache,
            &mut needed,
            10,
            "A".to_string(),
            1,
            MAX_TREE_DEPTH,
            true,
            &mut path,
        )
        .unwrap();

        // A builds from B, B builds from A -- but the second occurrence of A
        // (closing the cycle) must be bought, not recursed into again.
        let a_step = build_step(&root);
        assert_eq!(a_step.inputs.len(), 1);
        let b_line = &a_step.inputs[0];
        assert_eq!(b_line.type_id, 20);
        let b_step = build_step(b_line);
        assert_eq!(b_step.inputs.len(), 1);
        let inner_a = &b_step.inputs[0];
        assert_eq!(inner_a.type_id, 10);
        assert_buy(inner_a);
        // `path` is restored to empty once the top-level call returns.
        assert!(path.is_empty());
    }

    #[test]
    fn zero_depth_buys_without_touching_the_recipe_cache() {
        let sde = chain_sde();
        let mut cache = HashMap::new();
        let mut needed = HashSet::new();
        let mut path = Vec::new();

        let line = resolve_input(
            &sde,
            &mut cache,
            &mut needed,
            10,
            "A".to_string(),
            1,
            0,
            true,
            &mut path,
        )
        .unwrap();

        assert_buy(&line);
        assert!(cache.is_empty(), "depth 0 must never consult recipe_for");
    }

    #[test]
    fn build_false_buys_without_touching_the_recipe_cache() {
        let sde = chain_sde();
        let mut cache = HashMap::new();
        let mut needed = HashSet::new();
        let mut path = Vec::new();

        let line = resolve_input(
            &sde,
            &mut cache,
            &mut needed,
            10,
            "A".to_string(),
            1,
            MAX_TREE_DEPTH,
            false,
            &mut path,
        )
        .unwrap();

        assert_buy(&line);
        assert!(
            cache.is_empty(),
            "build=false must never consult recipe_for"
        );
    }

    #[test]
    fn depth_one_builds_the_root_but_buys_its_direct_input() {
        let sde = chain_sde();
        let mut cache = HashMap::new();
        let mut needed = HashSet::new();
        let mut path = Vec::new();

        let root = resolve_input(
            &sde,
            &mut cache,
            &mut needed,
            10,
            "A".to_string(),
            1,
            1,
            true,
            &mut path,
        )
        .unwrap();

        let a_step = build_step(&root);
        assert_eq!(a_step.inputs.len(), 1);
        // B (A's direct input) is bought: depth 1 -> B is resolved at depth 0.
        assert_buy(&a_step.inputs[0]);
        assert_eq!(a_step.inputs[0].type_id, 20);
        // C is never reached, so its recipe (if any) is never even looked up.
        assert_eq!(cache.len(), 1);
        assert!(cache.contains_key(&10));
    }

    #[test]
    fn reaction_activity_carries_formula_blueprint_and_product_quantity() {
        let sde = reaction_sde();
        let mut cache = HashMap::new();
        let mut needed = HashSet::new();
        let mut path = Vec::new();

        let line = resolve_input(
            &sde,
            &mut cache,
            &mut needed,
            600,
            "Composite".to_string(),
            50,
            MAX_TREE_DEPTH,
            true,
            &mut path,
        )
        .unwrap();

        let step = build_step(&line);
        assert_eq!(step.activity, Activity::Reaction);
        assert_eq!(step.blueprint_type_id, 500);
        assert_eq!(step.product_type_id, 600);
        assert_eq!(step.product_per_run, 100);
        assert_eq!(step.inputs.len(), 1);
        assert_eq!(step.inputs[0].type_id, 200);
        assert_buy(&step.inputs[0]);
    }

    #[test]
    fn needed_set_covers_the_whole_resolved_tree() {
        let sde = chain_sde();
        let mut cache = HashMap::new();
        let mut needed = HashSet::new();
        let mut path = Vec::new();

        resolve_input(
            &sde,
            &mut cache,
            &mut needed,
            10,
            "A".to_string(),
            1,
            MAX_TREE_DEPTH,
            true,
            &mut path,
        )
        .unwrap();

        // Root (built) + B (built) + C (bought leaf) must all be present, or
        // downstream pricing silently drops whichever id is missing.
        assert_eq!(needed, HashSet::from([10, 20, 30]));
    }
}

#[cfg(test)]
mod reprice_tests {
    use super::*;

    /// A 10-unit row costing 100 ISK total, currently priced at 20/unit.
    fn breakdown() -> ProfitBreakdown {
        ProfitBreakdown {
            blueprint_type_id: 1,
            product_type_id: 2,
            product_name: "Widget".into(),
            runs: 1,
            me: 0,
            materials: Vec::new(),
            job_time_seconds: 0.0,
            units_produced: 10,
            material_cost: 60.0,
            job_fee: 40.0,
            blueprint_cost: 0.0,
            invention_cost: 0.0,
            invention: None,
            product_price: Some(20.0),
            revenue: 200.0,
            profit: 100.0,
            margin: Some(0.5),
            roi: Some(1.0),
            profit_per_unit: 10.0,
            meta_group: None,
            category: None,
            group: None,
            market: None,
            sell_hub: None,
            favorite: false,
            product_volume: None,
            missing_prices: Vec::new(),
        }
    }

    #[test]
    fn reprices_gross_when_sales_costs_are_off() {
        let mut bd = breakdown();
        reprice_product(&mut bd, 30.0, "Jita", 0.0);
        assert_eq!(bd.product_price, Some(30.0));
        assert_eq!(bd.revenue, 300.0);
        assert_eq!(bd.profit, 200.0); // 300 − 100 cost
        assert_eq!(bd.margin, Some(200.0 / 300.0));
        assert_eq!(bd.roi, Some(2.0));
        assert_eq!(bd.profit_per_unit, 20.0);
        assert_eq!(bd.sell_hub.as_deref(), Some("Jita"));
    }

    #[test]
    fn applies_the_engines_sales_cost_basis() {
        // 8% off revenue must land on the repriced row too, or a best-hub row
        // would be compared against net-revenue rows on a gross basis.
        let mut bd = breakdown();
        reprice_product(&mut bd, 30.0, "Amarr", 0.08);
        assert_eq!(bd.revenue, 300.0 * 0.92);
        assert_eq!(bd.profit, 300.0 * 0.92 - 100.0);
    }

    #[test]
    fn zero_valued_edges_stay_finite() {
        // Zero price → zero revenue: margin undefined, ROI still defined.
        let mut bd = breakdown();
        reprice_product(&mut bd, 0.0, "Jita", 0.0);
        assert_eq!(bd.revenue, 0.0);
        assert_eq!(bd.margin, None);
        assert_eq!(bd.roi, Some(-1.0));

        // Zero cost → ROI undefined rather than infinite.
        let mut free = breakdown();
        free.material_cost = 0.0;
        free.job_fee = 0.0;
        reprice_product(&mut free, 5.0, "Jita", 0.0);
        assert_eq!(free.roi, None);
        assert_eq!(free.profit, 50.0);

        // Zero units → no division by zero in the per-unit figure.
        let mut empty = breakdown();
        empty.units_produced = 0;
        reprice_product(&mut empty, 5.0, "Jita", 0.0);
        assert_eq!(empty.profit_per_unit, 0.0);
    }
}
