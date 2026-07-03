//! Appraisal tool — paste a pile of items, get a buy/sell ISK valuation.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::market::{default_region_id, resolve_location, MarketService, PriceModel};
use crate::sde::{Sde, SdePaths};

/// One pasted line: an item name and a quantity (defaults to 1 in the UI).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppraisalItem {
    pub name: String,
    pub quantity: i64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AppraisalParams {
    pub items: Vec<AppraisalItem>,
    #[serde(default = "default_region_id")]
    pub region_id: i64,
    #[serde(default)]
    pub station_id: Option<i64>,
    /// Sell side uses the best-paying hub instead of the chosen market.
    #[serde(default)]
    pub best_hub: bool,
}

/// One valued line of the appraisal.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppraisalLine {
    pub name: String,
    pub type_id: Option<i64>,
    pub quantity: i64,
    pub buy_price: Option<f64>,
    pub sell_price: Option<f64>,
    pub buy_value: f64,
    pub sell_value: f64,
    /// Best hub for the sell side (when `best_hub`), else `None`.
    pub sell_hub: Option<String>,
    pub volume: f64,
    /// False when the name couldn't be resolved to a type.
    pub resolved: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppraisalResult {
    pub lines: Vec<AppraisalLine>,
    pub buy_total: f64,
    pub sell_total: f64,
    pub volume_total: f64,
}

/// Resolve each pasted line to a type, price it at the chosen market (buy & sell),
/// and total the buy value, sell value, and cargo volume.
#[tauri::command]
pub async fn appraisal(
    app: AppHandle,
    market: State<'_, MarketService>,
    params: AppraisalParams,
) -> Result<AppraisalResult, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let sde = Sde::open(&SdePaths::new(dir).db).map_err(|e| e.to_string())?;

    // Resolve names → (type id, packaged volume), keeping the original line order.
    struct Resolved {
        name: String,
        quantity: i64,
        type_id: Option<i64>,
        volume_each: f64,
    }
    let mut resolved = Vec::with_capacity(params.items.len());
    for item in &params.items {
        let lookup = sde
            .type_by_name(item.name.trim())
            .map_err(|e| e.to_string())?;
        resolved.push(Resolved {
            name: item.name.clone(),
            quantity: item.quantity.max(0),
            type_id: lookup.map(|(id, _)| id),
            volume_each: lookup.and_then(|(_, v)| v).unwrap_or(0.0),
        });
    }

    let ids: Vec<i64> = resolved.iter().filter_map(|r| r.type_id).collect();
    let location = resolve_location(params.region_id, params.station_id);
    let prices: HashMap<i64, PriceModel> = market
        .price_models_at(location, &ids)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|m| (m.type_id, m))
        .collect();
    let best = if params.best_hub {
        market
            .best_sell_hubs(&ids)
            .await
            .map_err(|e| e.to_string())?
    } else {
        HashMap::new()
    };

    // Pick each line's buy/sell price (best hub overrides sell when requested),
    // then hand off to the pure valuation.
    let items: Vec<PricedItem> = resolved
        .into_iter()
        .map(|r| {
            let model = r.type_id.and_then(|id| prices.get(&id));
            let buy_price = model.and_then(|m| m.buy_percentile);
            let (sell_price, sell_hub) = match r.type_id.and_then(|id| best.get(&id)) {
                Some(b) => (Some(b.price), Some(b.hub.clone())),
                None => (model.and_then(|m| m.sell_percentile), None),
            };
            PricedItem {
                name: r.name,
                type_id: r.type_id,
                quantity: r.quantity,
                buy_price,
                sell_price,
                sell_hub,
                volume_each: r.volume_each,
            }
        })
        .collect();

    Ok(appraise(items))
}

/// A pasted line resolved to a type and priced, ready for valuation.
struct PricedItem {
    name: String,
    type_id: Option<i64>,
    quantity: i64,
    buy_price: Option<f64>,
    sell_price: Option<f64>,
    sell_hub: Option<String>,
    volume_each: f64,
}

/// Value priced lines: per line, `price × qty` (a missing price counts as 0) and
/// `volume_each × qty`, plus the running buy/sell/volume totals. Pure, so the
/// valuation is unit-tested without the SDE or market service.
fn appraise(items: Vec<PricedItem>) -> AppraisalResult {
    let mut lines = Vec::with_capacity(items.len());
    let (mut buy_total, mut sell_total, mut volume_total) = (0.0, 0.0, 0.0);
    for it in items {
        let q = it.quantity as f64;
        let buy_value = it.buy_price.unwrap_or(0.0) * q;
        let sell_value = it.sell_price.unwrap_or(0.0) * q;
        let volume = it.volume_each * q;
        buy_total += buy_value;
        sell_total += sell_value;
        volume_total += volume;
        lines.push(AppraisalLine {
            name: it.name,
            type_id: it.type_id,
            quantity: it.quantity,
            buy_price: it.buy_price,
            sell_price: it.sell_price,
            buy_value,
            sell_value,
            sell_hub: it.sell_hub,
            volume,
            resolved: it.type_id.is_some(),
        });
    }
    AppraisalResult {
        lines,
        buy_total,
        sell_total,
        volume_total,
    }
}

// --- Reprocess appraisal: paste ores → mineral yield + value ---

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReprocessAppraisalParams {
    pub items: Vec<AppraisalItem>,
    #[serde(default = "default_region_id")]
    pub region_id: i64,
    #[serde(default)]
    pub station_id: Option<i64>,
    /// Refining efficiency as a fraction (0..1). Default 0.70.
    #[serde(default = "default_efficiency")]
    pub efficiency: f64,
}
fn default_efficiency() -> f64 {
    0.70
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReprocessInputLine {
    pub name: String,
    pub quantity: i64,
    pub resolved: bool,
    /// Whole portions that reprocess (leftover under one portion is wasted).
    pub reprocessed: i64,
    /// Market value of the minerals this line yields.
    pub yield_value: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MineralLine {
    pub type_id: i64,
    pub name: String,
    pub quantity: i64,
    pub unit_price: Option<f64>,
    pub value: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReprocessAppraisalResult {
    pub inputs: Vec<ReprocessInputLine>,
    pub minerals: Vec<MineralLine>,
    pub mineral_total: f64,
    /// What the inputs would sell for as-is (the reprocess-vs-sell comparison).
    pub input_sell_total: f64,
    pub efficiency: f64,
}

/// Paste items (ores, modules…) and get the **reprocessing yield** — the
/// minerals/materials they refine into at the given efficiency, valued at the
/// chosen market — plus what the inputs would sell for as-is.
#[tauri::command]
pub async fn appraisal_reprocess(
    app: AppHandle,
    market: State<'_, MarketService>,
    params: ReprocessAppraisalParams,
) -> Result<ReprocessAppraisalResult, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let sde = Sde::open(&SdePaths::new(dir).db).map_err(|e| e.to_string())?;
    let eff = params.efficiency.clamp(0.0, 1.0);

    // Resolve each line to its reprocess recipe.
    struct Resolved {
        name: String,
        quantity: i64,
        type_id: Option<i64>,
        recipe: Option<crate::sde::ReprocessRecipe>,
    }
    let mut resolved = Vec::with_capacity(params.items.len());
    for item in &params.items {
        let lookup = sde
            .type_by_name(item.name.trim())
            .map_err(|e| e.to_string())?;
        let recipe = match lookup {
            Some((id, _)) => sde.reprocess_recipe(id).map_err(|e| e.to_string())?,
            None => None,
        };
        resolved.push(Resolved {
            name: item.name.clone(),
            quantity: item.quantity.max(0),
            type_id: lookup.map(|(id, _)| id),
            recipe,
        });
    }

    // Aggregate mineral output across all inputs.
    let mut mineral_qty: HashMap<i64, (String, i64)> = HashMap::new();
    let mut per_line_minerals: Vec<HashMap<i64, i64>> = Vec::with_capacity(resolved.len());
    for r in &resolved {
        let mut line_min: HashMap<i64, i64> = HashMap::new();
        if let Some(recipe) = &r.recipe {
            let cycles = r.quantity / recipe.portion_size.max(1);
            for out in &recipe.outputs {
                let q = (out.quantity as f64 * cycles as f64 * eff).round() as i64;
                if q > 0 {
                    *line_min.entry(out.material_type_id).or_default() += q;
                    let slot = mineral_qty
                        .entry(out.material_type_id)
                        .or_insert((out.name.clone(), 0));
                    slot.1 += q;
                }
            }
        }
        per_line_minerals.push(line_min);
    }

    // Price minerals + the inputs themselves at the chosen market.
    let mut ids: HashSet<i64> = mineral_qty.keys().copied().collect();
    for r in &resolved {
        if let Some(id) = r.type_id {
            ids.insert(id);
        }
    }
    let ids: Vec<i64> = ids.into_iter().collect();
    let prices: HashMap<i64, PriceModel> = market
        .price_models_at(resolve_location(params.region_id, params.station_id), &ids)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|m| (m.type_id, m))
        .collect();
    let sell = |id: i64| {
        prices
            .get(&id)
            .and_then(|m| m.sell_percentile)
            .unwrap_or(0.0)
    };

    let mut minerals: Vec<MineralLine> = mineral_qty
        .into_iter()
        .map(|(type_id, (name, quantity))| {
            let unit = prices.get(&type_id).and_then(|m| m.sell_percentile);
            MineralLine {
                type_id,
                name,
                quantity,
                unit_price: unit,
                value: quantity as f64 * unit.unwrap_or(0.0),
            }
        })
        .collect();
    minerals.sort_by(|a, b| {
        b.value
            .partial_cmp(&a.value)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mineral_total: f64 = minerals.iter().map(|m| m.value).sum();

    let mut input_sell_total = 0.0;
    let inputs = resolved
        .iter()
        .zip(per_line_minerals)
        .map(|(r, line_min)| {
            input_sell_total += r
                .type_id
                .map(|id| r.quantity as f64 * sell(id))
                .unwrap_or(0.0);
            let yield_value: f64 = line_min.iter().map(|(id, q)| *q as f64 * sell(*id)).sum();
            let reprocessed = r
                .recipe
                .as_ref()
                .map(|rec| (r.quantity / rec.portion_size.max(1)) * rec.portion_size)
                .unwrap_or(0);
            ReprocessInputLine {
                name: r.name.clone(),
                quantity: r.quantity,
                resolved: r.recipe.is_some(),
                reprocessed,
                yield_value,
            }
        })
        .collect();

    Ok(ReprocessAppraisalResult {
        inputs,
        minerals,
        mineral_total,
        input_sell_total,
        efficiency: eff,
    })
}

#[cfg(test)]
mod tests {
    use super::{appraise, PricedItem};

    fn item(
        type_id: Option<i64>,
        quantity: i64,
        buy: Option<f64>,
        sell: Option<f64>,
        volume_each: f64,
    ) -> PricedItem {
        PricedItem {
            name: "x".into(),
            type_id,
            quantity,
            buy_price: buy,
            sell_price: sell,
            sell_hub: None,
            volume_each,
        }
    }

    #[test]
    fn values_lines_and_sums_totals() {
        let r = appraise(vec![
            item(Some(1), 10, Some(5.0), Some(8.0), 0.5),
            item(Some(2), 3, Some(100.0), Some(120.0), 2.0),
        ]);
        // Line 1: buy 50, sell 80, vol 5. Line 2: buy 300, sell 360, vol 6.
        assert_eq!(r.lines[0].buy_value, 50.0);
        assert_eq!(r.lines[0].sell_value, 80.0);
        assert_eq!(r.lines[0].volume, 5.0);
        assert_eq!(r.buy_total, 350.0);
        assert_eq!(r.sell_total, 440.0);
        assert_eq!(r.volume_total, 11.0);
    }

    #[test]
    fn missing_price_counts_as_zero_value() {
        let r = appraise(vec![item(Some(1), 4, None, None, 1.0)]);
        assert_eq!(r.lines[0].buy_value, 0.0);
        assert_eq!(r.lines[0].sell_value, 0.0);
        // Volume still accrues even when unpriced.
        assert_eq!(r.volume_total, 4.0);
        assert_eq!(r.buy_total, 0.0);
    }

    #[test]
    fn unresolved_line_is_flagged() {
        let r = appraise(vec![item(None, 1, None, None, 0.0)]);
        assert!(!r.lines[0].resolved);
    }

    #[test]
    fn resolved_flag_follows_type_id() {
        let r = appraise(vec![item(Some(7), 1, Some(1.0), Some(1.0), 0.0)]);
        assert!(r.lines[0].resolved);
    }
}
