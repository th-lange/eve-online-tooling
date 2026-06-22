//! Production profit engine.
//!
//! Pure, network-free calculation: given a blueprint's SDE rows and a price map
//! it computes the profit of **building and selling** an item versus selling the
//! inputs. v1 implements single-level **manufacturing**, but the model is
//! activity-aware and tree-shaped so invention/T2 (#9) and reactions/T3 (#10)
//! slot in without a rewrite:
//!
//! - a build step is a generic `(activity, inputs, output)` node ([`BuildStep`])
//! - each input carries its [`Sourcing`] — `Buy` (value at market, the v1
//!   default) or `Build` (a recursive sub-step, reserved for #10).

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
    DailyAverage,
    MovingAverage,
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

/// A generic build step: some activity turning inputs into a product.
#[derive(Debug, Clone)]
pub struct BuildStep {
    pub activity: Activity,
    pub blueprint_type_id: i64,
    pub product_type_id: i64,
    pub product_name: String,
    pub product_per_run: i64,
    pub inputs: Vec<InputLine>,
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
    pub unit_price: Option<f64>,
    pub line_cost: f64,
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
    /// Product daily volume (liquidity), for downstream filtering.
    pub product_volume: Option<i64>,
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
    }
}

fn price_for(model: Option<&PriceModel>, basis: PriceBasis) -> Option<f64> {
    let m = model?;
    match basis {
        PriceBasis::SellMin => m.sell_min,
        PriceBasis::BuyMax => m.buy_max,
        PriceBasis::DailyAverage => m.daily_average,
        PriceBasis::MovingAverage => m.moving_average,
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
        // v1 values every input at market; the recursive `Build` resolver lands
        // in #10, at which point a sub-step's own build cost is compared here.
        let unit_price = match &input.sourcing {
            Sourcing::Buy => price_for(model, config.material_basis),
            Sourcing::Build(_) => price_for(model, config.material_basis),
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
        });
    }

    let job_fee = eiv * config.system_cost_index * (1.0 + config.facility_tax);

    // Revenue from selling the product.
    let units_produced = step.product_per_run * runs;
    let product_model = prices.get(&step.product_type_id);
    let product_volume = product_model.and_then(|m| m.daily_volume);
    let revenue = match price_for(product_model, config.product_basis) {
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

    let cost = material_cost + job_fee;
    let profit = revenue - material_cost - job_fee;
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
        revenue,
        profit,
        margin,
        roi,
        profit_per_unit,
        meta_group: None,
        product_volume,
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
