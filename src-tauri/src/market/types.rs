use serde::{Deserialize, Serialize};

/// A market order as returned by `/markets/{region}/orders/`. We only model the
/// fields we use; serde ignores the rest of the response.
#[derive(Debug, Clone, Deserialize)]
pub struct Order {
    pub price: f64,
    pub is_buy_order: bool,
    pub location_id: i64,
}

/// One day of `/markets/{region}/history/`.
#[derive(Debug, Clone, Deserialize)]
pub struct HistoryDay {
    pub date: String,
    pub average: f64,
    #[serde(default)]
    pub highest: f64,
    #[serde(default)]
    pub lowest: f64,
    pub order_count: i64,
    pub volume: i64,
}

/// A row of `/markets/prices/` (global adjusted/average prices).
#[derive(Debug, Clone, Deserialize)]
pub struct AdjustedPrice {
    pub type_id: i64,
    #[serde(default)]
    pub adjusted_price: Option<f64>,
    #[serde(default)]
    pub average_price: Option<f64>,
}

/// All price vectors for one type. Every vector is optional so "no data" is
/// represented explicitly rather than as a misleading zero.
#[derive(Debug, Clone, Serialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct PriceModel {
    pub type_id: i64,
    /// Lowest sell order (what you pay to buy now).
    pub sell_min: Option<f64>,
    /// Highest buy order (what you get selling now).
    pub buy_max: Option<f64>,
    /// "Realistic" sell price (percentile) — ignores outlier orders.
    pub sell_percentile: Option<f64>,
    /// "Realistic" buy price (percentile).
    pub buy_percentile: Option<f64>,
    /// Global adjusted price (industry job-fee / EIV basis).
    pub adjusted_price: Option<f64>,
    /// Global average price.
    pub average_price: Option<f64>,
    /// Most recent daily average from market history.
    pub daily_average: Option<f64>,
    /// Sell-side order-book volume — units currently listed in sell orders. (In
    /// the per-item ESI path this instead holds the latest daily traded volume.)
    pub daily_volume: Option<i64>,
    /// Buy-side order-book volume — units currently listed in buy orders.
    pub buy_volume: Option<i64>,
    /// Most recent daily distinct-order count.
    pub order_count: Option<i64>,
    /// N-day moving average of the daily average.
    pub moving_average: Option<f64>,
}
