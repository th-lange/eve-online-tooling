//! Production profit engine.
//!
//! Pure, network-free calculation: given a blueprint's SDE rows and a price map
//! it computes the profit of **building and selling** an item versus selling the
//! inputs. The model is activity-aware and tree-shaped:
//!
//! - a build step is a generic `(activity, inputs, output)` node ([`BuildStep`])
//! - each input carries its [`Sourcing`] — `Buy` (value at market) or `Build`
//!   (a recursive sub-step). Buildable inputs take the cheaper of build vs buy,
//!   recursively (manufacturing + reactions).
//! - T2 items carry an [`Invention`] whose expected cost is amortized in.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::market::PriceModel;
use crate::sde::{BlueprintMaterial, BlueprintProduct};

/// Industry activity. Only [`Activity::Manufacturing`] is costed in v1; the
/// other variants are reserved for invention/T2 (#9) and reactions/T3 (#10).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub enum Activity {
    Manufacturing,
    Invention,
    Reaction,
}

/// Which price vector to value a role (materials or product) with. Defaults use
/// `SellMin`; the rest are user-selectable in the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PriceBasis {
    SellMin,
    BuyMax,
    SellPercentile,
    BuyPercentile,
    AdjustedPrice,
    AveragePrice,
}

/// How an input is obtained.
#[derive(Debug, Clone)]
#[allow(dead_code)]
pub enum Sourcing {
    /// Value the input at market (v1 default).
    Buy,
    /// Build it from a sub-step (recursive build-vs-buy; reserved for #10).
    Build(Box<BuildStep>),
}

/// One input line of a build step (pre-ME base quantity, per run).
#[derive(Debug, Clone)]
pub struct InputLine {
    pub type_id: i64,
    pub name: String,
    pub base_quantity: i64,
    pub sourcing: Sourcing,
}

/// Invention prerequisite for a T2 build (SDE activity 8). Its expected cost is
/// amortized into the manufacturing cost.
#[derive(Debug, Clone)]
pub struct Invention {
    /// Datacores (+ any other inputs) consumed per attempt.
    pub datacores: Vec<InputLine>,
    /// The T1 product's manufacturing materials, used to estimate the copy job
    /// fee for the consumed T1 BPC (EIV × cost index).
    pub copy_materials: Vec<InputLine>,
    /// Runs on the resulting T2 BPC per successful attempt.
    pub runs_per_success: i64,
    /// Success probability (0..1).
    pub probability: f64,
}

/// A generic build step: some activity turning inputs into a product.
#[derive(Debug, Clone)]
pub struct BuildStep {
    pub activity: Activity,
    pub blueprint_type_id: i64,
    pub product_type_id: i64,
    pub product_name: String,
    pub product_per_run: i64,
    pub inputs: Vec<InputLine>,
    /// Set for T2 items: invention must succeed before manufacturing.
    pub invention: Option<Invention>,
}

/// Tunables for a profit calculation. Defaults value everything at Jita sell-min
/// with no fees; callers override the cost index / taxes per system & structure.
#[derive(Debug, Clone)]
pub struct ProfitConfig {
    pub material_basis: PriceBasis,
    pub product_basis: PriceBasis,
    /// Manufacturing system cost index (0..1), from ESI `/industry/systems/`.
    pub system_cost_index: f64,
    /// Structure/facility tax fraction applied on top of the job fee.
    pub facility_tax: f64,
    /// Sales tax fraction (applied to revenue when `include_sales_cost`).
    pub sales_tax: f64,
    /// Broker fee fraction (applied to revenue when `include_sales_cost`).
    pub broker_fee: f64,
    /// Whether to subtract sales tax + broker fee from revenue.
    pub include_sales_cost: bool,
    /// Cost to acquire the blueprint copy, amortized **per run** (e.g. a faction
    /// or officer BPC from an LP store). Multiplied by `runs`.
    pub blueprint_cost_per_run: f64,
    /// Multiplier on the SDE base invention probability from the inventor's
    /// skills/decryptor (1.0 = base/skill-0; ~1.458 = all science skills at V).
    pub invention_skill_multiplier: f64,
}

impl Default for ProfitConfig {
    fn default() -> Self {
        Self {
            material_basis: PriceBasis::SellMin,
            product_basis: PriceBasis::SellMin,
            system_cost_index: 0.0,
            facility_tax: 0.0,
            sales_tax: 0.0,
            broker_fee: 0.0,
            include_sales_cost: false,
            blueprint_cost_per_run: 0.0,
            invention_skill_multiplier: 1.0,
        }
    }
}

/// Per-material cost line for the UI drill-down.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct MaterialLine {
    pub type_id: i64,
    pub name: String,
    pub required_quantity: i64,
    /// Unit cost used (the cheaper of build vs buy when buildable).
    pub unit_price: Option<f64>,
    pub line_cost: f64,
    /// True when building this input is cheaper than buying it.
    pub built: bool,
}

/// Invention cost detail for the drill-down (T2 items).
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct InventionBreakdown {
    /// Datacores consumed per attempt (quantity, unit price, cost).
    pub datacores: Vec<MaterialLine>,
    pub datacore_cost: f64,
    pub invention_job_fee: f64,
    /// Copy job fee for the T1 BPC consumed each attempt.
    pub copy_fee: f64,
    pub attempt_cost: f64,
    /// Skill-adjusted success probability (0..1).
    pub probability: f64,
    pub runs_per_success: i64,
    /// Invention cost per produced unit-run = attempt_cost / (probability × runs).
    pub per_unit: f64,
}

/// How deep the recursive build-vs-buy resolver descends.
const MAX_BUILD_DEPTH: u32 = 8;

/// Per-unit cost to **build** this step's product, recursively choosing the
/// cheaper of build vs buy for each input. `None` if the subtree can't be fully
/// priced (so the caller falls back to buying).
fn build_unit_cost(
    step: &BuildStep,
    prices: &HashMap<i64, PriceModel>,
    config: &ProfitConfig,
    depth: u32,
) -> Option<f64> {
    if depth == 0 || step.product_per_run <= 0 {
        return None;
    }
    let mut materials_total = 0.0;
    let mut eiv = 0.0;
    for input in &step.inputs {
        let model = prices.get(&input.type_id);
        let buy_unit = price_for(model, config.material_basis);
        let unit = match &input.sourcing {
            Sourcing::Build(sub) => {
                match (build_unit_cost(sub, prices, config, depth - 1), buy_unit) {
                    (Some(b), Some(y)) => b.min(y),
                    (Some(b), None) => b,
                    (None, Some(y)) => y,
                    (None, None) => return None,
                }
            }
            Sourcing::Buy => buy_unit?,
        };
        // Sub-builds use base (ME 0) quantities — we don't know per-component ME.
        materials_total += input.base_quantity as f64 * unit;
        eiv += eiv_unit_value(model) * input.base_quantity as f64;
    }
    let job_fee = eiv * config.system_cost_index * (1.0 + config.facility_tax);
    Some((materials_total + job_fee) / step.product_per_run as f64)
}

/// The result of evaluating a build step.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProfitBreakdown {
    pub blueprint_type_id: i64,
    pub product_type_id: i64,
    pub product_name: String,
    pub runs: i64,
    pub me: i64,
    pub units_produced: i64,
    pub material_cost: f64,
    pub job_fee: f64,
    /// Amortized blueprint acquisition cost for this job (per-run cost × runs).
    pub blueprint_cost: f64,
    /// Amortized invention cost for this job (T2 items; 0 otherwise).
    pub invention_cost: f64,
    /// Invention cost detail (T2 items only).
    pub invention: Option<InventionBreakdown>,
    pub revenue: f64,
    pub profit: f64,
    /// Profit / revenue, or `None` when revenue is zero. Capped at 100%.
    pub margin: Option<f64>,
    /// Return on investment: profit / cost. Can exceed 100% (e.g. build for
    /// 100, sell for 600 -> 500%). `None` when cost is zero.
    pub roi: Option<f64>,
    pub profit_per_unit: f64,
    /// Meta group of the product (Tech I/II, Faction, Officer, …). Filled by the
    /// command layer from the SDE; the pure engine leaves it `None`.
    pub meta_group: Option<String>,
    /// Category of the product (Ship, Module, Charge, …). Filled by the command
    /// layer from the SDE; the pure engine leaves it `None`.
    pub category: Option<String>,
    /// Group of the product (Frigate, Cruiser, …). Filled by the command layer.
    pub group: Option<String>,
    /// Which market this result was priced at. Filled by the command layer; the
    /// pure engine leaves it `None`.
    pub market: Option<String>,
    /// Product daily volume (liquidity), for downstream filtering.
    pub product_volume: Option<i64>,
    /// Per-unit sell price of the product at the chosen basis (the target price).
    pub product_price: Option<f64>,
    pub materials: Vec<MaterialLine>,
    /// Type ids we could not price; the row's numbers are incomplete when set.
    pub missing_prices: Vec<i64>,
}

/// ME-adjusted required quantity of a material for `runs` runs.
///
/// `max(runs, ceil(base * runs * (1 - me/100)))` — at least one unit per run.
pub fn required_quantity(base_quantity: i64, runs: i64, me: i64) -> i64 {
    let factor = 1.0 - (me as f64) / 100.0;
    let raw = (base_quantity as f64) * (runs as f64) * factor;
    (raw.ceil() as i64).max(runs)
}

/// Build a single-level manufacturing step from SDE rows (all inputs `Buy`).
pub fn manufacturing_step(
    blueprint_type_id: i64,
    product: &BlueprintProduct,
    materials: &[BlueprintMaterial],
) -> BuildStep {
    BuildStep {
        activity: Activity::Manufacturing,
        blueprint_type_id,
        product_type_id: product.product_type_id,
        product_name: product.name.clone(),
        product_per_run: product.quantity,
        inputs: materials
            .iter()
            .map(|m| InputLine {
                type_id: m.material_type_id,
                name: m.name.clone(),
                base_quantity: m.quantity,
                sourcing: Sourcing::Buy,
            })
            .collect(),
        invention: None,
    }
}

fn price_for(model: Option<&PriceModel>, basis: PriceBasis) -> Option<f64> {
    let m = model?;
    match basis {
        PriceBasis::SellMin => m.sell_min,
        PriceBasis::BuyMax => m.buy_max,
        PriceBasis::SellPercentile => m.sell_percentile,
        PriceBasis::BuyPercentile => m.buy_percentile,
        PriceBasis::AdjustedPrice => m.adjusted_price,
        PriceBasis::AveragePrice => m.average_price,
    }
}

/// EIV unit value of a material (adjusted price, falling back to average).
fn eiv_unit_value(model: Option<&PriceModel>) -> f64 {
    model
        .and_then(|m| m.adjusted_price.or(m.average_price))
        .unwrap_or(0.0)
}

/// Evaluate a (manufacturing) build step into a profit breakdown.
///
/// v1 values every input at market (`Sourcing::Buy`); `Build` sub-steps are
/// treated as buy until the recursive resolver lands in #10.
pub fn evaluate(
    step: &BuildStep,
    runs: i64,
    me: i64,
    prices: &HashMap<i64, PriceModel>,
    config: &ProfitConfig,
) -> ProfitBreakdown {
    debug_assert!(
        matches!(step.activity, Activity::Manufacturing),
        "only manufacturing is costed in v1"
    );
    let mut missing_prices = Vec::new();

    // Materials: ME-adjusted quantity valued at the material price basis.
    let mut material_cost = 0.0;
    let mut eiv = 0.0;
    let mut materials = Vec::with_capacity(step.inputs.len());
    for input in &step.inputs {
        let model = prices.get(&input.type_id);
        let required = required_quantity(input.base_quantity, runs, me);
        let buy_unit = price_for(model, config.material_basis);
        // Buildable inputs (a sub-recipe) take the cheaper of build vs buy.
        let (unit_price, built) = match &input.sourcing {
            Sourcing::Build(sub) => {
                match (
                    build_unit_cost(sub, prices, config, MAX_BUILD_DEPTH),
                    buy_unit,
                ) {
                    (Some(b), Some(y)) if b < y => (Some(b), true),
                    (Some(_), Some(y)) => (Some(y), false),
                    (Some(b), None) => (Some(b), true),
                    (None, y) => (y, false),
                }
            }
            Sourcing::Buy => (buy_unit, false),
        };
        let line_cost = match unit_price {
            Some(p) => p * required as f64,
            None => {
                missing_prices.push(input.type_id);
                0.0
            }
        };
        material_cost += line_cost;
        // EIV uses base (pre-ME) quantities at adjusted price, across all runs.
        eiv += eiv_unit_value(model) * (input.base_quantity as f64) * (runs as f64);
        materials.push(MaterialLine {
            type_id: input.type_id,
            name: input.name.clone(),
            required_quantity: required,
            unit_price,
            line_cost,
            built,
        });
    }

    let job_fee = eiv * config.system_cost_index * (1.0 + config.facility_tax);

    // Revenue from selling the product.
    let units_produced = step.product_per_run * runs;
    let product_model = prices.get(&step.product_type_id);
    let product_volume = product_model.and_then(|m| m.daily_volume);
    let product_price = price_for(product_model, config.product_basis);
    let revenue = match product_price {
        Some(price) => {
            let gross = price * units_produced as f64;
            if config.include_sales_cost {
                gross * (1.0 - config.sales_tax - config.broker_fee)
            } else {
                gross
            }
        }
        None => {
            missing_prices.push(step.product_type_id);
            0.0
        }
    };

    let blueprint_cost = config.blueprint_cost_per_run * runs as f64;

    // Invention (T2): amortize the expected attempt cost over the runs it yields.
    let (invention_cost, invention) = match &step.invention {
        Some(inv) => {
            let mut datacore_lines = Vec::with_capacity(inv.datacores.len());
            let mut datacore_cost = 0.0;
            let mut invention_eiv = 0.0;
            for dc in &inv.datacores {
                let model = prices.get(&dc.type_id);
                let unit = price_for(model, config.material_basis);
                let line = match unit {
                    Some(p) => p * dc.base_quantity as f64,
                    None => {
                        missing_prices.push(dc.type_id);
                        0.0
                    }
                };
                datacore_cost += line;
                invention_eiv += eiv_unit_value(model) * dc.base_quantity as f64;
                datacore_lines.push(MaterialLine {
                    type_id: dc.type_id,
                    name: dc.name.clone(),
                    required_quantity: dc.base_quantity,
                    unit_price: unit,
                    line_cost: line,
                    built: false,
                });
            }
            let invention_job_fee =
                invention_eiv * config.system_cost_index * (1.0 + config.facility_tax);
            // Copy job fee for the T1 BPC consumed each attempt: EIV of the T1
            // product × the (manufacturing) cost index, as an approximation.
            let copy_eiv: f64 = inv
                .copy_materials
                .iter()
                .map(|m| eiv_unit_value(prices.get(&m.type_id)) * m.base_quantity as f64)
                .sum();
            let copy_fee = copy_eiv * config.system_cost_index * (1.0 + config.facility_tax);
            let attempt_cost = datacore_cost + invention_job_fee + copy_fee;
            let probability = (inv.probability * config.invention_skill_multiplier).min(1.0);
            let yielded = probability * inv.runs_per_success as f64;
            let per_unit = if yielded > 0.0 {
                attempt_cost / yielded
            } else {
                0.0
            };
            let breakdown = InventionBreakdown {
                datacores: datacore_lines,
                datacore_cost,
                invention_job_fee,
                copy_fee,
                attempt_cost,
                probability,
                runs_per_success: inv.runs_per_success,
                per_unit,
            };
            (per_unit * runs as f64, Some(breakdown))
        }
        None => (0.0, None),
    };

    let cost = material_cost + job_fee + blueprint_cost + invention_cost;
    let profit = revenue - cost;
    let margin = if revenue > 0.0 {
        Some(profit / revenue)
    } else {
        None
    };
    let roi = if cost > 0.0 {
        Some(profit / cost)
    } else {
        None
    };
    let profit_per_unit = if units_produced > 0 {
        profit / units_produced as f64
    } else {
        0.0
    };

    ProfitBreakdown {
        blueprint_type_id: step.blueprint_type_id,
        product_type_id: step.product_type_id,
        product_name: step.product_name.clone(),
        runs,
        me,
        units_produced,
        material_cost,
        job_fee,
        blueprint_cost,
        invention_cost,
        invention,
        revenue,
        profit,
        margin,
        roi,
        profit_per_unit,
        meta_group: None,
        category: None,
        group: None,
        market: None,
        product_volume,
        product_price,
        materials,
        missing_prices,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn approx(a: f64, b: f64) {
        assert!((a - b).abs() < 1e-6, "expected {b}, got {a}");
    }

    fn price(
        type_id: i64,
        sell: Option<f64>,
        adjusted: Option<f64>,
        volume: Option<i64>,
    ) -> PriceModel {
        PriceModel {
            type_id,
            sell_min: sell,
            adjusted_price: adjusted,
            daily_volume: volume,
            ..Default::default()
        }
    }

    // Blueprint 999 -> 1x Widget(100) from 40x Trit(200) + 10x Pyerite(300).
    fn widget_step() -> BuildStep {
        BuildStep {
            activity: Activity::Manufacturing,
            blueprint_type_id: 999,
            product_type_id: 100,
            product_name: "Widget".into(),
            product_per_run: 1,
            inputs: vec![
                InputLine {
                    type_id: 200,
                    name: "Tritanium".into(),
                    base_quantity: 40,
                    sourcing: Sourcing::Buy,
                },
                InputLine {
                    type_id: 300,
                    name: "Pyerite".into(),
                    base_quantity: 10,
                    sourcing: Sourcing::Buy,
                },
            ],
            invention: None,
        }
    }

    fn widget_prices() -> HashMap<i64, PriceModel> {
        HashMap::from([
            (200, price(200, Some(5.0), Some(4.0), None)),
            (300, price(300, Some(10.0), Some(8.0), None)),
            (100, price(100, Some(1000.0), Some(900.0), Some(1200))),
        ])
    }

    #[test]
    fn required_quantity_applies_me_and_min_per_run() {
        assert_eq!(required_quantity(40, 1, 10), 36); // ceil(36)
        assert_eq!(required_quantity(10, 1, 10), 9); // ceil(9)
        assert_eq!(required_quantity(40, 1, 0), 40); // no ME
        assert_eq!(required_quantity(1, 3, 10), 3); // 2.7 -> ceil 3, also min runs
        assert_eq!(required_quantity(1, 5, 90), 5); // 0.5 -> clamps up to runs
    }

    #[test]
    fn hand_verified_profit() {
        let config = ProfitConfig {
            system_cost_index: 0.05,
            facility_tax: 0.1,
            ..Default::default()
        };
        let b = evaluate(&widget_step(), 1, 10, &widget_prices(), &config);

        // materials: 36*5 + 9*10 = 270
        approx(b.material_cost, 270.0);
        // EIV = 40*4 + 10*8 = 240; fee = 240 * 0.05 * 1.1 = 13.2
        approx(b.job_fee, 13.2);
        approx(b.revenue, 1000.0);
        approx(b.profit, 716.8);
        approx(b.margin.unwrap(), 0.7168);
        // ROI = profit / cost = 716.8 / (270 + 13.2) -> ~253%, well over 100%.
        approx(b.roi.unwrap(), 716.8 / 283.2);
        approx(b.profit_per_unit, 716.8);
        assert_eq!(b.units_produced, 1);
        assert_eq!(b.product_volume, Some(1200));
        assert!(b.missing_prices.is_empty());
        assert_eq!(b.materials.len(), 2);
        approx(b.materials[0].line_cost, 180.0);
    }

    fn buildable_step() -> (BuildStep, HashMap<i64, PriceModel>) {
        // Product 100 needs 1× A(10); A is buildable from 2× B(20).
        let sub = BuildStep {
            activity: Activity::Manufacturing,
            blueprint_type_id: 11,
            product_type_id: 10,
            product_name: "A".into(),
            product_per_run: 1,
            inputs: vec![InputLine {
                type_id: 20,
                name: "B".into(),
                base_quantity: 2,
                sourcing: Sourcing::Buy,
            }],
            invention: None,
        };
        let step = BuildStep {
            activity: Activity::Manufacturing,
            blueprint_type_id: 1,
            product_type_id: 100,
            product_name: "P".into(),
            product_per_run: 1,
            inputs: vec![InputLine {
                type_id: 10,
                name: "A".into(),
                base_quantity: 1,
                sourcing: Sourcing::Build(Box::new(sub)),
            }],
            invention: None,
        };
        let prices = HashMap::from([
            (10, price(10, Some(100.0), Some(100.0), None)),
            (20, price(20, Some(10.0), Some(10.0), None)),
            (100, price(100, Some(1000.0), Some(900.0), None)),
        ]);
        (step, prices)
    }

    #[test]
    fn recursive_build_wins_when_cheaper() {
        let (step, prices) = buildable_step();
        // Build A = 2×B(10) = 20 < buy A (100).
        let b = evaluate(&step, 1, 0, &prices, &ProfitConfig::default());
        assert!(b.materials[0].built);
        approx(b.materials[0].line_cost, 20.0);
        approx(b.material_cost, 20.0);
    }

    #[test]
    fn recursive_buy_wins_when_cheaper() {
        let (step, mut prices) = buildable_step();
        // Make B expensive so building A (2×200=400) costs more than buying (100).
        prices.insert(20, price(20, Some(200.0), Some(200.0), None));
        let b = evaluate(&step, 1, 0, &prices, &ProfitConfig::default());
        assert!(!b.materials[0].built);
        approx(b.materials[0].line_cost, 100.0);
    }

    #[test]
    fn invention_cost_is_amortized() {
        let mut step = widget_step();
        step.invention = Some(Invention {
            datacores: vec![InputLine {
                type_id: 500,
                name: "Datacore".into(),
                base_quantity: 2,
                sourcing: Sourcing::Buy,
            }],
            copy_materials: vec![],
            runs_per_success: 10,
            probability: 0.5,
        });
        let mut prices = widget_prices();
        prices.insert(500, price(500, Some(100.0), Some(100.0), None));
        // Default config: SellMin basis, cost index 0 (no invention job fee).
        let b = evaluate(&step, 1, 10, &prices, &ProfitConfig::default());
        // attempt = 2 datacores × 100 = 200; per mfg-run = 200 / (0.5 × 10) = 40.
        approx(b.invention_cost, 40.0);
        // profit = 1000 − materials 270 − invention 40
        approx(b.profit, 1000.0 - 270.0 - 40.0);
        let inv = b.invention.unwrap();
        approx(inv.datacore_cost, 200.0);
        approx(inv.per_unit, 40.0);
        assert_eq!(inv.datacores.len(), 1);
    }

    #[test]
    fn blueprint_cost_per_run_reduces_profit() {
        let config = ProfitConfig {
            blueprint_cost_per_run: 100.0,
            ..Default::default()
        };
        let b = evaluate(&widget_step(), 1, 10, &widget_prices(), &config);
        approx(b.blueprint_cost, 100.0);
        // materials 270, no job fee (index 0), blueprint 100 -> profit 630
        approx(b.profit, 1000.0 - 270.0 - 100.0);
    }

    #[test]
    fn missing_material_price_is_flagged_not_zero_cost_silent() {
        let mut prices = widget_prices();
        prices.remove(&300); // Pyerite unpriced
        let b = evaluate(&widget_step(), 1, 10, &prices, &ProfitConfig::default());
        assert_eq!(b.missing_prices, vec![300]);
        // Only Tritanium counted: 36*5 = 180
        approx(b.material_cost, 180.0);
        assert_eq!(b.materials[1].unit_price, None);
        approx(b.materials[1].line_cost, 0.0);
    }

    #[test]
    fn missing_product_price_flags_and_yields_no_revenue() {
        let mut prices = widget_prices();
        prices.remove(&100); // product unpriced
        let b = evaluate(&widget_step(), 1, 10, &prices, &ProfitConfig::default());
        assert!(b.missing_prices.contains(&100));
        approx(b.revenue, 0.0);
        assert!(b.margin.is_none());
        // profit is negative cost, not a silent zero
        assert!(b.profit < 0.0);
    }

    #[test]
    fn scales_with_runs() {
        let b = evaluate(
            &widget_step(),
            10,
            0,
            &widget_prices(),
            &ProfitConfig::default(),
        );
        assert_eq!(b.units_produced, 10);
        // no ME: 400*5 + 100*10 = 3000
        approx(b.material_cost, 3000.0);
        approx(b.revenue, 10_000.0);
    }
}
