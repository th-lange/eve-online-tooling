//! Pure aggregation of raw ESI market data into a [`PriceModel`].
//!
//! These functions take plain data (no network), so they're directly
//! unit-testable with fixture order books and history.

use super::types::{AdjustedPrice, HistoryDay, Order, PriceModel};

/// Whether an order is at the requested station (or anywhere, when `None`).
fn at_station(order: &Order, station_id: Option<i64>) -> bool {
    station_id.is_none_or(|s| order.location_id == s)
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
        adjusted_price: adjusted.and_then(|a| a.adjusted_price),
        average_price: adjusted.and_then(|a| a.average_price),
        daily_average: latest.map(|h| h.average),
        daily_volume: latest.map(|h| h.volume),
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
        }
    }

    fn day(date: &str, average: f64, volume: i64, order_count: i64) -> HistoryDay {
        HistoryDay {
            date: date.to_string(),
            average,
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
