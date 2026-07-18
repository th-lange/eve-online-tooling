//! Daytrading: short-term flips across **different regions**. For each item we
//! compare its price across several market hubs and surface the best gap — buy
//! where it's cheapest, sell where it's dearest — netting taxes and fees. The
//! binding constraint when hauling is cargo, so the headline metric is ISK/m³.
//! Pure and network-free.

use serde::Serialize;

/// Fee inputs for a daytrade calculation.
#[derive(Debug, Clone, Copy)]
pub struct DayTradeConfig {
    /// Sales tax fraction, applied to the sale.
    pub sales_tax: f64,
    /// Broker fee fraction, applied to the sale (you relist at the sell hub).
    pub broker_fee: f64,
    /// Hauling cost in ISK per m³, subtracted per unit (volume × rate).
    pub shipping_rate: f64,
}

/// An item's price at one hub (the realistic sell-side price there).
#[derive(Debug, Clone)]
pub struct Quote {
    pub region_id: i64,
    pub hub: String,
    pub price: f64,
}

/// A ranked cross-region flip for one item.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DayTradeRow {
    pub type_id: i64,
    pub name: String,
    /// Hub to buy at (cheapest) and its price.
    pub buy_region_id: i64,
    pub buy_hub: String,
    pub buy_price: f64,
    /// Hub to sell at (dearest) and its price.
    pub sell_region_id: i64,
    pub sell_hub: String,
    pub sell_price: f64,
    /// Net profit per unit after sales tax + broker fee + shipping.
    pub profit_per_unit: f64,
    /// Hauling cost per unit (volume × shipping rate).
    pub shipping_per_unit: f64,
    /// Profit ÷ acquisition cost.
    pub margin: f64,
    /// Packaged volume per unit, m³.
    pub volume_m3: f64,
    /// Profit per m³ of cargo — the hauler's ranking metric (0 if volume unknown).
    pub isk_per_m3: f64,
    /// Daily-traded volume at the sell hub (how much you can offload). Filled in
    /// by the command for the displayed set; 0 until then.
    pub dest_volume: i64,
    /// Units worth buying over the purchase window = dest_volume × days. Filled
    /// by the command; 0 until then.
    pub suggested_qty: i64,
    /// Total profit at the suggested quantity (profit_per_unit × suggested_qty).
    pub total_profit: f64,
    /// Sell-hub order-book sell supply ÷ daily-traded volume — how contested the
    /// sell side is (lower = clears faster). Filled by the command.
    pub days_of_supply: f64,
    pub favorite: bool,
    /// Category/group for search + filters (Ship/Module…, Frigate/Cruiser…).
    pub category: Option<String>,
    pub group: Option<String>,
    /// Meta group (Tech I/II/III, Faction, …), for the tech-level filter.
    pub meta_group: Option<String>,
}

/// Find the best cross-region flip for one item from its per-hub `quotes`. Buys
/// at the cheapest hub, sells at the dearest; `None` if fewer than two hubs
/// quote it, both ends land in the same region, or there's no profit after fees.
pub fn evaluate(
    type_id: i64,
    name: &str,
    volume_m3: Option<f64>,
    quotes: &[Quote],
    config: &DayTradeConfig,
    favorite: bool,
) -> Option<DayTradeRow> {
    if quotes.len() < 2 {
        return None;
    }
    let cmp = |a: &&Quote, b: &&Quote| {
        a.price
            .partial_cmp(&b.price)
            .unwrap_or(std::cmp::Ordering::Equal)
    };
    let buy = quotes.iter().min_by(cmp)?;
    let sell = quotes.iter().max_by(cmp)?;
    // A flip needs two *different* regions and positive prices.
    if buy.region_id == sell.region_id || buy.price <= 0.0 || sell.price <= 0.0 {
        return None;
    }
    let volume_m3 = volume_m3.unwrap_or(0.0);
    let shipping_per_unit = volume_m3 * config.shipping_rate;
    let revenue = sell.price * (1.0 - config.sales_tax - config.broker_fee);
    let profit_per_unit = revenue - buy.price - shipping_per_unit;
    let margin = profit_per_unit / buy.price;
    let isk_per_m3 = if volume_m3 > 0.0 {
        profit_per_unit / volume_m3
    } else {
        0.0
    };
    Some(DayTradeRow {
        type_id,
        name: name.to_string(),
        buy_region_id: buy.region_id,
        buy_hub: buy.hub.clone(),
        buy_price: buy.price,
        sell_region_id: sell.region_id,
        sell_hub: sell.hub.clone(),
        sell_price: sell.price,
        profit_per_unit,
        shipping_per_unit,
        margin,
        volume_m3,
        isk_per_m3,
        dest_volume: 0,
        suggested_qty: 0,
        total_profit: 0.0,
        days_of_supply: 0.0,
        favorite,
        category: None,
        group: None,
        meta_group: None,
    })
}

/// Units worth buying = the sell hub's demand over the window, less what you
/// already own (so a flip doesn't tell you to restock your own hangar). Never
/// negative. `owned` is 0 when stock-netting is off.
pub fn net_suggested_qty(demand: i64, owned: i64) -> i64 {
    (demand - owned).max(0)
}

/// Two views matter for hauling: ISK/m³ (cargo-bound) and absolute profit — a
/// bulky ship can have low ISK/m³ but a big per-unit margin. Keep the top
/// `profit_cap` by profit, sort the rest by ISK/m³ and truncate to
/// `result_cap`, then union the profit-capped set back in (deduped by
/// `type_id`) so high-value flips aren't silently dropped by the cargo cap.
pub fn rank_and_cap(
    mut rows: Vec<DayTradeRow>,
    profit_cap: usize,
    result_cap: usize,
) -> Vec<DayTradeRow> {
    rows.sort_by(|a, b| {
        b.profit_per_unit
            .partial_cmp(&a.profit_per_unit)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let by_profit: Vec<DayTradeRow> = rows.iter().take(profit_cap).cloned().collect();
    rows.sort_by(|a, b| {
        b.isk_per_m3
            .partial_cmp(&a.isk_per_m3)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    rows.truncate(result_cap);
    let present: std::collections::HashSet<i64> = rows.iter().map(|r| r.type_id).collect();
    rows.extend(
        by_profit
            .into_iter()
            .filter(|r| !present.contains(&r.type_id)),
    );
    rows
}

/// Fill in the fields that need live data outside `evaluate`'s pure quote
/// comparison: how much of the sell hub's daily volume is worth buying over
/// the purchase window (net of owned stock), the profit at that quantity, and
/// how contested the sell-hub order book is relative to daily turnover.
pub fn enrich(row: &mut DayTradeRow, dest_volume: i64, purchase_days: f64, owned: i64, listed: i64) {
    row.dest_volume = dest_volume;
    let demand = (dest_volume as f64 * purchase_days).round() as i64;
    row.suggested_qty = net_suggested_qty(demand, owned);
    row.total_profit = row.profit_per_unit * row.suggested_qty as f64;
    row.days_of_supply = if dest_volume > 0 {
        listed as f64 / dest_volume as f64
    } else {
        0.0
    };
}

/// Liquidity floor: drop rows the sell hub can't absorb over a day. `0` keeps
/// everything (the UI's floor is off).
pub fn retain_min_demand(mut rows: Vec<DayTradeRow>, min_daily_demand: i64) -> Vec<DayTradeRow> {
    if min_daily_demand > 0 {
        rows.retain(|r| r.dest_volume >= min_daily_demand);
    }
    rows
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quote(region_id: i64, price: f64) -> Quote {
        Quote {
            region_id,
            hub: format!("Hub{region_id}"),
            price,
        }
    }

    fn config(sales_tax: f64, broker_fee: f64, shipping_rate: f64) -> DayTradeConfig {
        DayTradeConfig {
            sales_tax,
            broker_fee,
            shipping_rate,
        }
    }

    fn row(type_id: i64, profit_per_unit: f64, isk_per_m3: f64) -> DayTradeRow {
        DayTradeRow {
            type_id,
            name: format!("Item{type_id}"),
            buy_region_id: 1,
            buy_hub: "Buy".to_string(),
            buy_price: 10.0,
            sell_region_id: 2,
            sell_hub: "Sell".to_string(),
            sell_price: 20.0,
            profit_per_unit,
            shipping_per_unit: 0.0,
            margin: 0.0,
            volume_m3: 1.0,
            isk_per_m3,
            dest_volume: 0,
            suggested_qty: 0,
            total_profit: 0.0,
            days_of_supply: 0.0,
            favorite: false,
            category: None,
            group: None,
            meta_group: None,
        }
    }

    #[test]
    fn picks_cheapest_buy_and_dearest_sell_after_fees() {
        // Cheapest at region 2 (90), dearest at region 3 (140); 5% tax, 2% broker, 2 m³.
        let quotes = [quote(1, 100.0), quote(2, 90.0), quote(3, 140.0)];
        let r = evaluate(
            1,
            "Widget",
            Some(2.0),
            &quotes,
            &config(0.05, 0.02, 0.0),
            false,
        )
        .unwrap();
        assert_eq!(r.buy_region_id, 2);
        assert_eq!(r.sell_region_id, 3);
        // revenue = 140 × (1 − 0.07) = 130.2; profit = 130.2 − 90 = 40.2.
        assert!((r.profit_per_unit - 40.2).abs() < 1e-6);
        assert!((r.isk_per_m3 - 20.1).abs() < 1e-6);
    }

    #[test]
    fn shipping_is_netted_per_unit() {
        // Same as above but 5 ISK/m³ × 2 m³ = 10 shipping/unit → profit 30.2.
        let quotes = [quote(2, 90.0), quote(3, 140.0)];
        let r = evaluate(
            1,
            "Widget",
            Some(2.0),
            &quotes,
            &config(0.05, 0.02, 5.0),
            false,
        )
        .unwrap();
        assert!((r.shipping_per_unit - 10.0).abs() < 1e-6);
        assert!((r.profit_per_unit - 30.2).abs() < 1e-6);
        assert!((r.isk_per_m3 - 15.1).abs() < 1e-6);
    }

    #[test]
    fn nets_owned_stock_off_suggested_qty() {
        // Demand 1000, own 300 → suggest 700; own more than demand → 0, never negative.
        assert_eq!(net_suggested_qty(1000, 300), 700);
        assert_eq!(net_suggested_qty(1000, 0), 1000); // toggle off
        assert_eq!(net_suggested_qty(500, 800), 0); // already overstocked
    }

    #[test]
    fn none_without_two_hubs() {
        assert!(evaluate(
            1,
            "x",
            Some(1.0),
            &[quote(1, 100.0)],
            &config(0.0, 0.0, 0.0),
            false
        )
        .is_none());
    }

    #[test]
    fn none_when_no_cross_region_profit() {
        // Same price everywhere → no gap, profit ≤ 0.
        let quotes = [quote(1, 100.0), quote(2, 100.0)];
        let r = evaluate(1, "x", Some(1.0), &quotes, &config(0.0, 0.0, 0.0), false);
        assert!(r.is_none() || r.unwrap().profit_per_unit == 0.0);
    }

    #[test]
    fn rank_and_cap_keeps_bulky_high_profit_row_via_profit_union_without_duplicating() {
        // 3 rows ranked by isk/m3 fill the result cap; a 4th row (type 99) has a
        // huge profit_per_unit but a tiny isk/m3, so it's truncated from the
        // isk/m3 view — the profit union must bring it back exactly once.
        let rows = vec![
            row(1, 10.0, 300.0),
            row(2, 10.0, 200.0),
            row(3, 10.0, 100.0),
            row(99, 10_000.0, 1.0),
        ];
        let result = rank_and_cap(rows, /* profit_cap */ 1, /* result_cap */ 3);
        assert_eq!(result.iter().filter(|r| r.type_id == 99).count(), 1);
        assert_eq!(result.len(), 4);
    }

    #[test]
    fn rank_and_cap_does_not_duplicate_a_row_already_in_both_caps() {
        // A single row that's both the top isk/m3 row and the top profit row
        // must appear exactly once in the merged output.
        let rows = vec![row(1, 100.0, 50.0), row(2, 1.0, 1.0)];
        let result = rank_and_cap(rows, 1, 1);
        assert_eq!(result.iter().filter(|r| r.type_id == 1).count(), 1);
    }

    #[test]
    fn enrich_zero_dest_volume_gives_zero_days_of_supply() {
        let mut r = row(1, 10.0, 5.0);
        enrich(&mut r, /* dest_volume */ 0, /* purchase_days */ 2.0, /* owned */ 0, /* listed */ 500);
        assert_eq!(r.days_of_supply, 0.0);
        assert_eq!(r.suggested_qty, 0);
        assert_eq!(r.total_profit, 0.0);
    }

    #[test]
    fn enrich_computes_suggested_qty_and_total_profit() {
        let mut r = row(1, 10.0, 5.0);
        enrich(&mut r, /* dest_volume */ 100, /* purchase_days */ 2.0, /* owned */ 50, /* listed */ 300);
        // demand = round(100 * 2.0) = 200; net of 50 owned -> 150.
        assert_eq!(r.suggested_qty, 150);
        assert!((r.total_profit - 1500.0).abs() < 1e-9);
        assert!((r.days_of_supply - 3.0).abs() < 1e-9);
    }

    #[test]
    fn retain_min_demand_drops_illiquid_rows_and_zero_disables_the_floor() {
        let mut a = row(1, 10.0, 5.0);
        a.dest_volume = 5;
        let mut b = row(2, 10.0, 5.0);
        b.dest_volume = 50;
        let rows = vec![a.clone(), b.clone()];
        let result = retain_min_demand(rows.clone(), 10);
        assert_eq!(result.iter().map(|r| r.type_id).collect::<Vec<_>>(), vec![2]);
        let unfiltered = retain_min_demand(rows, 0);
        assert_eq!(unfiltered.len(), 2);
    }
}
