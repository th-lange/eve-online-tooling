//! Station-trading margin calculation.
//!
//! Station trading = place a buy order, get filled, then place a sell order.
//! Profit per unit is the spread after broker fees (on both orders) and sales
//! tax (on the sale). Pure and network-free.

use serde::Serialize;

use crate::market::PriceModel;

/// Fee inputs for a station-trade calculation.
#[derive(Debug, Clone, Copy)]
pub struct TradeConfig {
    pub broker_fee: f64,
    pub sales_tax: f64,
}

/// A ranked station-trading opportunity.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TradeRow {
    pub type_id: i64,
    pub name: String,
    /// Price you acquire at (buy-order side).
    pub buy: f64,
    /// Price you sell at (sell-order side).
    pub sell: f64,
    /// Net profit per unit after broker fees + sales tax.
    pub profit_per_unit: f64,
    /// Profit / cost.
    pub margin: f64,
    /// Sell-side order-book depth — units currently listed in sell orders.
    pub volume: i64,
    /// Buy-side order-book depth — units currently listed in buy orders.
    pub buy_volume: i64,
    /// Buy-side depth ÷ sell-side depth — demand vs supply pressure on the book
    /// (>1 = more buyers listed than sellers).
    pub buy_sell_ratio: f64,
    /// Average units actually *traded* per day, from market history (#14). Filled
    /// in by the command for the displayed set; 0 until then. (Buys and sells are
    /// the same quantity — every trade is both — so this isn't split.)
    pub daily_traded: i64,
    /// Sell-side depth ÷ daily-traded — days of supply on the book (how long your
    /// stock takes to clear / how contested). Filled by the command.
    pub days_of_supply: f64,
    /// Set when the current sell price sits at a recent extreme ("above 30d high"
    /// / "below 30d low") — risk of mean reversion. Filled by the command.
    pub price_flag: Option<String>,
    pub favorite: bool,
    /// Category/group of the item (Ship/Module…, Frigate/Cruiser…), for search + filters.
    pub category: Option<String>,
    pub group: Option<String>,
    /// Meta group (Tech I/II/III, Faction, …), for the tech-level filter.
    pub meta_group: Option<String>,
}

/// Evaluate one item. `None` if it has no usable buy/sell price.
pub fn evaluate(
    type_id: i64,
    name: &str,
    model: &PriceModel,
    config: &TradeConfig,
    favorite: bool,
) -> Option<TradeRow> {
    let buy = model.buy_percentile?;
    let sell = model.sell_percentile?;
    if buy <= 0.0 || sell <= 0.0 {
        return None;
    }
    // Broker fee on placing the buy order, and on the sell order; sales tax on
    // the sale.
    let cost = buy * (1.0 + config.broker_fee);
    let revenue = sell * (1.0 - config.broker_fee - config.sales_tax);
    let profit_per_unit = revenue - cost;
    let margin = profit_per_unit / cost;
    Some(TradeRow {
        type_id,
        name: name.to_string(),
        buy,
        sell,
        profit_per_unit,
        margin,
        volume: model.daily_volume.unwrap_or(0),
        buy_volume: model.buy_volume.unwrap_or(0),
        buy_sell_ratio: {
            let sell_listed = model.daily_volume.unwrap_or(0);
            if sell_listed > 0 {
                model.buy_volume.unwrap_or(0) as f64 / sell_listed as f64
            } else {
                0.0
            }
        },
        daily_traded: 0,
        days_of_supply: 0.0,
        price_flag: None,
        favorite,
        category: None,
        group: None,
        meta_group: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn model(buy: f64, sell: f64, vol: i64) -> PriceModel {
        PriceModel {
            type_id: 1,
            buy_percentile: Some(buy),
            sell_percentile: Some(sell),
            daily_volume: Some(vol),
            buy_volume: Some(vol / 2),
            ..Default::default()
        }
    }

    #[test]
    fn computes_margin_after_fees() {
        // buy 100, sell 130, broker 3%, tax 4%.
        let config = TradeConfig {
            broker_fee: 0.03,
            sales_tax: 0.04,
        };
        let r = evaluate(1, "Widget", &model(100.0, 130.0, 500), &config, false).unwrap();
        // cost = 100×1.03 = 103; revenue = 130×0.93 = 120.9; profit = 17.9
        assert!((r.profit_per_unit - 17.9).abs() < 1e-6);
        assert!((r.margin - 17.9 / 103.0).abs() < 1e-6);
        assert_eq!(r.volume, 500);
        assert_eq!(r.buy_volume, 250);
    }

    #[test]
    fn none_without_prices() {
        let config = TradeConfig {
            broker_fee: 0.0,
            sales_tax: 0.0,
        };
        let m = PriceModel {
            type_id: 1,
            ..Default::default()
        };
        assert!(evaluate(1, "x", &m, &config, false).is_none());
    }
}
