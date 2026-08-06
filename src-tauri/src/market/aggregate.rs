//! Pure aggregation of raw ESI market data into a [`PriceModel`].
//!
//! These functions take plain data (no network), so they're directly
//! unit-testable with fixture order books and history.

use super::types::{AdjustedPrice, HistoryDay, Order, PriceModel};

/// Whether an order is at the requested station (or anywhere, when `None`).
fn at_station(order: &Order, station_id: Option<i64>) -> bool {
    station_id.is_none_or(|s| order.location_id == s)
}

/// Sell orders priced above this multiple of the sell median are treated as
/// outliers (overpriced junk / would-be scams) and dropped by the
/// "exclude scams" filter.
pub const SELL_OUTLIER_MULT: f64 = 10.0;
/// Buy orders priced below this fraction of the buy median are dropped likewise.
pub const BUY_OUTLIER_FRAC: f64 = 0.1;

/// Median of a price list (`None` for empty). Operates on a sorted copy.
fn median_price(prices: &[f64]) -> Option<f64> {
    if prices.is_empty() {
        return None;
    }
    let mut v = prices.to_vec();
    v.sort_by(f64::total_cmp);
    let n = v.len();
    Some(if n % 2 == 1 {
        v[n / 2]
    } else {
        (v[n / 2 - 1] + v[n / 2]) / 2.0
    })
}

/// "Exclude scams" outlier guard. Within `orders`, drop sell orders
/// priced above [`SELL_OUTLIER_MULT`]× the sell median and buy orders below
/// [`BUY_OUTLIER_FRAC`]× the buy median. Cheap sells and generous buys stay
/// visible; a side with no orders imposes no filter on that side. This is a
/// rough heuristic — misleading orders inside the band still pass.
pub fn filter_outliers(orders: &[Order]) -> Vec<Order> {
    let sell_prices: Vec<f64> = orders
        .iter()
        .filter(|o| !o.is_buy_order)
        .map(|o| o.price)
        .collect();
    let buy_prices: Vec<f64> = orders
        .iter()
        .filter(|o| o.is_buy_order)
        .map(|o| o.price)
        .collect();
    let sell_cap = median_price(&sell_prices).map(|m| m * SELL_OUTLIER_MULT);
    let buy_floor = median_price(&buy_prices).map(|m| m * BUY_OUTLIER_FRAC);
    orders
        .iter()
        .filter(|o| {
            if o.is_buy_order {
                buy_floor.is_none_or(|f| o.price >= f)
            } else {
                sell_cap.is_none_or(|c| o.price <= c)
            }
        })
        .cloned()
        .collect()
}

/// Lowest sell price among sell orders at `station_id` (whole region if `None`).
pub fn sell_min(orders: &[Order], station_id: Option<i64>) -> Option<f64> {
    orders
        .iter()
        .filter(|o| !o.is_buy_order && at_station(o, station_id))
        .map(|o| o.price)
        .fold(None, |acc, p| Some(acc.map_or(p, |a: f64| a.min(p))))
}

/// Highest buy price among buy orders at `station_id` (whole region if `None`).
pub fn buy_max(orders: &[Order], station_id: Option<i64>) -> Option<f64> {
    orders
        .iter()
        .filter(|o| o.is_buy_order && at_station(o, station_id))
        .map(|o| o.price)
        .fold(None, |acc, p| Some(acc.map_or(p, |a: f64| a.max(p))))
}

/// Most recent history day (by date).
pub fn latest_day(history: &[HistoryDay]) -> Option<&HistoryDay> {
    history.iter().max_by(|a, b| a.date.cmp(&b.date))
}

/// Mean of the daily average over the most recent `days` history entries.
pub fn moving_average(history: &[HistoryDay], days: usize) -> Option<f64> {
    if history.is_empty() || days == 0 {
        return None;
    }
    let mut sorted: Vec<&HistoryDay> = history.iter().collect();
    sorted.sort_by(|a, b| a.date.cmp(&b.date));
    let window = &sorted[sorted.len().saturating_sub(days)..];
    if window.is_empty() {
        return None;
    }
    let sum: f64 = window.iter().map(|h| h.average).sum();
    Some(sum / window.len() as f64)
}

/// Combine spot orders, history and global prices into a [`PriceModel`].
pub fn assemble_price_model(
    type_id: i64,
    orders: &[Order],
    history: &[HistoryDay],
    adjusted: Option<&AdjustedPrice>,
    ma_days: usize,
    station_id: Option<i64>,
) -> PriceModel {
    let latest = latest_day(history);
    PriceModel {
        type_id,
        sell_min: sell_min(orders, station_id),
        buy_max: buy_max(orders, station_id),
        sell_percentile: None,
        buy_percentile: None,
        adjusted_price: adjusted.and_then(|a| a.adjusted_price),
        average_price: adjusted.and_then(|a| a.average_price),
        weighted_average: None,
        daily_average: latest.map(|h| h.average),
        daily_volume: latest.map(|h| h.volume),
        // Buy-side order-book depth isn't modelled in the per-item ESI path
        // (the order rows we parse don't carry remaining quantity).
        buy_volume: None,
        order_count: latest.map(|h| h.order_count),
        moving_average: moving_average(history, ma_days),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HUB: i64 = 60003760;
    const OTHER: i64 = 60000001;

    fn order(price: f64, is_buy: bool, station: i64) -> Order {
        Order {
            price,
            is_buy_order: is_buy,
            location_id: station,
            volume_remain: 0,
            system_id: 0,
        }
    }

    #[test]
    fn filter_outliers_drops_overpriced_sells_and_lowball_buys() {
        // Sell median = 100 → cap 1000; the 5000 sell is dropped, cheap ones stay.
        // Buy median = 90 → floor 9; the 1.0 buy is dropped, generous ones stay.
        let orders = vec![
            order(80.0, false, HUB),
            order(100.0, false, HUB),
            order(120.0, false, HUB),
            order(5000.0, false, HUB), // scam sell, dropped
            order(90.0, true, HUB),
            order(95.0, true, HUB),
            order(1.0, true, HUB), // lowball buy, dropped
        ];
        let kept = filter_outliers(&orders);
        let sells: Vec<f64> = kept
            .iter()
            .filter(|o| !o.is_buy_order)
            .map(|o| o.price)
            .collect();
        let buys: Vec<f64> = kept
            .iter()
            .filter(|o| o.is_buy_order)
            .map(|o| o.price)
            .collect();
        assert_eq!(sells, vec![80.0, 100.0, 120.0]);
        assert_eq!(buys, vec![90.0, 95.0]);
    }

    #[test]
    fn filter_outliers_keeps_cheap_sells_and_empty_sides() {
        // A single ultra-cheap sell is *not* dropped (bait stays visible), and a
        // side with no orders imposes no filter.
        let orders = vec![order(1.0, false, HUB), order(100.0, false, HUB)];
        assert_eq!(filter_outliers(&orders).len(), 2);
        assert!(filter_outliers(&[]).is_empty());
    }

    fn day(date: &str, average: f64, volume: i64, order_count: i64) -> HistoryDay {
        HistoryDay {
            date: date.to_string(),
            average,
            highest: average,
            lowest: average,
            order_count,
            volume,
        }
    }

    #[test]
    fn sell_min_picks_lowest_sell_at_hub() {
        let orders = vec![
            order(100.0, false, HUB),
            order(90.0, false, HUB),
            order(80.0, false, OTHER), // different station, ignored
            order(50.0, true, HUB),    // buy order, ignored
        ];
        assert_eq!(sell_min(&orders, Some(HUB)), Some(90.0));
    }

    #[test]
    fn buy_max_picks_highest_buy_at_hub() {
        let orders = vec![
            order(40.0, true, HUB),
            order(55.0, true, HUB),
            order(99.0, true, OTHER), // different station, ignored
            order(200.0, false, HUB), // sell order, ignored
        ];
        assert_eq!(buy_max(&orders, Some(HUB)), Some(55.0));
    }

    #[test]
    fn missing_orders_yield_none() {
        assert_eq!(sell_min(&[], Some(HUB)), None);
        assert_eq!(buy_max(&[], Some(HUB)), None);
    }

    #[test]
    fn moving_average_uses_last_n_days_unordered() {
        // Deliberately out of order; only the latest 3 should count: 30,40,50.
        let history = vec![
            day("2024-01-01", 10.0, 1, 1),
            day("2024-01-05", 50.0, 1, 1),
            day("2024-01-02", 20.0, 1, 1),
            day("2024-01-04", 40.0, 1, 1),
            day("2024-01-03", 30.0, 1, 1),
        ];
        assert_eq!(moving_average(&history, 3), Some(40.0));
        assert_eq!(moving_average(&history, 0), None);
        assert_eq!(moving_average(&[], 3), None);
    }

    #[test]
    fn assemble_combines_all_vectors() {
        let orders = vec![order(100.0, false, HUB), order(70.0, true, HUB)];
        let history = vec![
            day("2024-01-01", 80.0, 500, 12),
            day("2024-01-02", 90.0, 600, 15),
        ];
        let adjusted = AdjustedPrice {
            type_id: 34,
            adjusted_price: Some(85.0),
            average_price: Some(86.0),
        };
        let m = assemble_price_model(34, &orders, &history, Some(&adjusted), 2, Some(HUB));
        assert_eq!(m.type_id, 34);
        assert_eq!(m.sell_min, Some(100.0));
        assert_eq!(m.buy_max, Some(70.0));
        assert_eq!(m.adjusted_price, Some(85.0));
        assert_eq!(m.average_price, Some(86.0));
        assert_eq!(m.daily_average, Some(90.0)); // latest day
        assert_eq!(m.daily_volume, Some(600));
        assert_eq!(m.order_count, Some(15));
        assert_eq!(m.moving_average, Some(85.0)); // (80 + 90) / 2
    }

    #[test]
    fn assemble_with_no_data_is_all_none() {
        let m = assemble_price_model(34, &[], &[], None, 7, Some(HUB));
        assert_eq!(
            m,
            PriceModel {
                type_id: 34,
                ..Default::default()
            }
        );
    }
}
