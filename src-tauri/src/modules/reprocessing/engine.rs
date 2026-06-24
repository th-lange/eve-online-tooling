//! Reprocessing / refining "reprocess-vs-sell" math. For an ore (or other
//! reprocessable item), compare selling it as-is against refining it and selling
//! the output minerals. Pure and network-free.

use serde::Serialize;

use crate::sde::ReprocessRecipe;

/// One refine output line, valued.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct OutputLine {
    pub type_id: i64,
    pub name: String,
    /// Units yielded per one input unit, after efficiency.
    pub per_unit: f64,
    pub unit_price: Option<f64>,
    /// Value per one input unit (per_unit × unit_price).
    pub value: f64,
}

/// A ranked reprocess-vs-sell row for one item.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ReprocessRow {
    pub type_id: i64,
    pub name: String,
    /// Sell price of the item itself (per unit).
    pub sell_price: Option<f64>,
    /// Refine value per unit (sum of output values at the given efficiency).
    pub reprocess_value: f64,
    /// reprocess_value − sell_price (per unit). Positive = refining wins.
    pub delta: f64,
    /// reprocess_value / sell_price − 1, or None when sell price is unknown.
    pub uplift: Option<f64>,
    pub outputs: Vec<OutputLine>,
    pub favorite: bool,
    pub group: Option<String>,
    /// Type ids whose price was missing (value is incomplete when set).
    pub missing_prices: Vec<i64>,
}

/// Value one item's reprocess-vs-sell at the given refine `efficiency` (0..1).
/// `output_price`/`item_price` return the per-unit sell price for a type, or
/// `None` when unpriced. Returns `None` if the recipe has no portion size.
pub fn evaluate(
    recipe: &ReprocessRecipe,
    efficiency: f64,
    item_price: Option<f64>,
    output_price: impl Fn(i64) -> Option<f64>,
    favorite: bool,
) -> Option<ReprocessRow> {
    if recipe.portion_size <= 0 {
        return None;
    }
    let portion = recipe.portion_size as f64;
    let mut reprocess_value = 0.0;
    let mut outputs = Vec::with_capacity(recipe.outputs.len());
    let mut missing_prices = Vec::new();
    for out in &recipe.outputs {
        // Per input unit: base per-portion qty × efficiency ÷ portion size.
        let per_unit = out.quantity as f64 * efficiency / portion;
        let unit_price = output_price(out.material_type_id);
        let value = match unit_price {
            Some(p) => per_unit * p,
            None => {
                missing_prices.push(out.material_type_id);
                0.0
            }
        };
        reprocess_value += value;
        outputs.push(OutputLine {
            type_id: out.material_type_id,
            name: out.name.clone(),
            per_unit,
            unit_price,
            value,
        });
    }
    let delta = reprocess_value - item_price.unwrap_or(0.0);
    let uplift = item_price.filter(|p| *p > 0.0).map(|p| reprocess_value / p - 1.0);
    Some(ReprocessRow {
        type_id: recipe.type_id,
        name: recipe.name.clone(),
        sell_price: item_price,
        reprocess_value,
        delta,
        uplift,
        outputs,
        favorite,
        group: None,
        missing_prices,
    })
}

/// Ore-track refine efficiency as a 0..1 fraction, following EVE's stacked model:
/// base 50% (+rig) × structure × security × skill/implant multipliers.
pub fn ore_efficiency(cfg: &EfficiencyConfig) -> f64 {
    let mut eff = 50.0 + cfg.rig_bonus_pct;
    eff *= cfg.structure_mult;
    eff *= cfg.security_mult;
    eff *= (1.0 + 0.03 * cfg.reprocessing as f64)
        * (1.0 + 0.02 * cfg.reprocessing_efficiency as f64)
        * (1.0 + 0.02 * cfg.ore_processing as f64)
        * (1.0 + cfg.implant_pct / 100.0);
    (eff / 100.0).min(1.0)
}

/// Inputs to [`ore_efficiency`]. Skills are levels 0..5.
#[derive(Debug, Clone, Copy)]
pub struct EfficiencyConfig {
    /// Reprocessing skill (+3%/level).
    pub reprocessing: i64,
    /// Reprocessing Efficiency skill (+2%/level).
    pub reprocessing_efficiency: i64,
    /// Ore-specific processing skill (+2%/level).
    pub ore_processing: i64,
    /// Hardwiring implant bonus, percent (e.g. 1 / 2 / 4).
    pub implant_pct: f64,
    /// Reprocessing rig bonus in percentage points (T1 = 1, T2 = 3, none = 0).
    pub rig_bonus_pct: f64,
    /// Structure multiplier (NPC = 1.0, Refinery = 1.02, Tatara-class = 1.055).
    pub structure_mult: f64,
    /// Security multiplier (hi = 1.0, low = 1.06, null/WH = 1.12).
    pub security_mult: f64,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sde::BlueprintMaterial;

    fn veldspar() -> ReprocessRecipe {
        ReprocessRecipe {
            type_id: 1230,
            name: "Veldspar".into(),
            portion_size: 100,
            outputs: vec![BlueprintMaterial {
                material_type_id: 34,
                name: "Tritanium".into(),
                quantity: 400,
            }],
        }
    }

    #[test]
    fn reprocess_value_scales_with_efficiency_and_portion() {
        // 400 Trit per 100 Veldspar at 100% = 4 Trit/unit; at 5 ISK each = 20/unit.
        let row = evaluate(&veldspar(), 1.0, Some(15.0), |_| Some(5.0), false).unwrap();
        assert!((row.reprocess_value - 20.0).abs() < 1e-6);
        assert!((row.delta - 5.0).abs() < 1e-6); // 20 reprocess − 15 sell
        assert!((row.uplift.unwrap() - (20.0 / 15.0 - 1.0)).abs() < 1e-6);
        // At 70% efficiency → 14/unit, refining now loses vs 15 sell.
        let row70 = evaluate(&veldspar(), 0.70, Some(15.0), |_| Some(5.0), false).unwrap();
        assert!((row70.reprocess_value - 14.0).abs() < 1e-6);
        assert!(row70.delta < 0.0);
    }

    #[test]
    fn missing_output_price_flags_and_skips() {
        let row = evaluate(&veldspar(), 1.0, Some(15.0), |_| None, false).unwrap();
        assert_eq!(row.reprocess_value, 0.0);
        assert_eq!(row.missing_prices, vec![34]);
    }

    #[test]
    fn ore_efficiency_matches_stacked_model() {
        // All-V reprocessing + reproc-eff, T2 rig, hi-sec NPC-ish station.
        let eff = ore_efficiency(&EfficiencyConfig {
            reprocessing: 5,
            reprocessing_efficiency: 5,
            ore_processing: 0,
            implant_pct: 0.0,
            rig_bonus_pct: 0.0,
            structure_mult: 1.0,
            security_mult: 1.0,
        });
        // 50 × (1.15)(1.10) / 100 = 0.6325.
        assert!((eff - 0.6325).abs() < 1e-6);
    }
}
