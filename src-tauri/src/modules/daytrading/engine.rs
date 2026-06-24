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

    #[test]
    fn picks_cheapest_buy_and_dearest_sell_after_fees() {
        // Cheapest at region 2 (90), dearest at region 3 (140); 5% tax, 2% broker, 2 m³.
        let quotes = [quote(1, 100.0), quote(2, 90.0), quote(3, 140.0)];
        let r = evaluate(1, "Widget", Some(2.0), &quotes, &config(0.05, 0.02, 0.0), false).unwrap();
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
        let r = evaluate(1, "Widget", Some(2.0), &quotes, &config(0.05, 0.02, 5.0), false).unwrap();
        assert!((r.shipping_per_unit - 10.0).abs() < 1e-6);
        assert!((r.profit_per_unit - 30.2).abs() < 1e-6);
        assert!((r.isk_per_m3 - 15.1).abs() < 1e-6);
    }

    #[test]
    fn none_without_two_hubs() {
        assert!(evaluate(1, "x", Some(1.0), &[quote(1, 100.0)], &config(0.0, 0.0, 0.0), false).is_none());
    }

    #[test]
    fn none_when_no_cross_region_profit() {
        // Same price everywhere → no gap, profit ≤ 0.
        let quotes = [quote(1, 100.0), quote(2, 100.0)];
        let r = evaluate(1, "x", Some(1.0), &quotes, &config(0.0, 0.0, 0.0), false);
        assert!(r.is_none() || r.unwrap().profit_per_unit == 0.0);
    }
}
