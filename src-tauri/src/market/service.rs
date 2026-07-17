//! Market price service: fetch ESI market data, cache it, and assemble the
//! multi-vector [`PriceModel`] per type for a chosen [`Market`].

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use crate::esi::{EsiClient, EsiError};

use super::aggregate::assemble_price_model;
use super::cache::TtlCache;
use super::flight::KeyLocks;
use super::fuzzwork::{Aggregate, FuzzworkClient};
use super::markets::Location;
use super::types::{AdjustedPrice, HistoryDay, Order, PriceModel};

/// Default window for the moving-average vector.
const MA_DAYS: usize = 7;

/// ESI returns 404 for `history`/`orders` of a type that isn't traded on the
/// market (some blueprint inputs aren't). That's "no data", not a hard error.
fn is_not_found(err: &EsiError) -> bool {
    matches!(err, EsiError::Http(e) if e.status() == Some(reqwest::StatusCode::NOT_FOUND))
}

pub struct MarketService {
    esi: EsiClient,
    fuzzwork: FuzzworkClient,
    ma_days: usize,
    // Orders/history are region-scoped, so cache them by (region_id, type_id).
    orders: TtlCache<(i64, i64), Vec<Order>>,
    history: TtlCache<(i64, i64), Vec<HistoryDay>>,
    // Fuzzwork aggregates, cached by (location key, type_id).
    aggregates: TtlCache<((i64, i64), i64), Aggregate>,
    // Global adjusted prices (one document for all types; the EIV basis).
    prices: TtlCache<(), Arc<HashMap<i64, AdjustedPrice>>>,
    // Single-flight guards (see flight.rs): concurrent identical lookups
    // collapse into one upstream request instead of each hitting ESI/Fuzzwork.
    orders_flight: KeyLocks<(i64, i64)>,
    history_flight: KeyLocks<(i64, i64)>,
    aggregates_flight: KeyLocks<(i64, i64)>,
    prices_flight: KeyLocks<()>,
}

impl Default for MarketService {
    fn default() -> Self {
        Self::new()
    }
}

impl MarketService {
    pub fn new() -> Self {
        Self::with_client(EsiClient::new())
    }

    /// Market service whose ESI reads are conditionally cached on disk under
    /// `<dir>/esi-cache/`, so price/order/history data survives restarts and
    /// revalidates with ETags instead of full re-downloads.
    pub fn with_cache(dir: std::path::PathBuf) -> Self {
        Self::with_client(EsiClient::with_cache(dir))
    }

    fn with_client(esi: EsiClient) -> Self {
        Self {
            esi,
            fuzzwork: FuzzworkClient::new(),
            ma_days: MA_DAYS,
            // TTLs roughly track ESI cache timers.
            orders: TtlCache::new(Duration::from_secs(300)),
            history: TtlCache::new(Duration::from_secs(1200)),
            aggregates: TtlCache::new(Duration::from_secs(900)),
            prices: TtlCache::new(Duration::from_secs(3600)),
            orders_flight: KeyLocks::new(),
            history_flight: KeyLocks::new(),
            aggregates_flight: KeyLocks::new(),
            prices_flight: KeyLocks::new(),
        }
    }

    /// Spot orders for a type in a region (cached per region).
    async fn orders_for(&self, region_id: i64, type_id: i64) -> Result<Vec<Order>, EsiError> {
        if let Some(cached) = self.orders.get(&(region_id, type_id)) {
            return Ok(cached);
        }
        // Single-flight: if another caller is fetching this key, wait for it,
        // then take the cache hit it left behind.
        let gate = self.orders_flight.lock_for(&(region_id, type_id));
        let _flight = gate.lock().await;
        if let Some(cached) = self.orders.get(&(region_id, type_id)) {
            return Ok(cached);
        }
        let path = format!("/latest/markets/{region_id}/orders/");
        let orders: Vec<Order> = match self
            .esi
            .get_paged(
                &path,
                &[
                    ("type_id", type_id.to_string()),
                    ("order_type", "all".to_string()),
                ],
            )
            .await
        {
            Ok(orders) => orders,
            Err(e) if is_not_found(&e) => Vec::new(),
            Err(e) => return Err(e),
        };
        self.orders.put((region_id, type_id), orders.clone());
        Ok(orders)
    }

    /// All live orders (buy + sell) for a type in a region, cached per region.
    /// Feeds the market-search order list, which fans this out across regions.
    pub async fn region_orders(
        &self,
        region_id: i64,
        type_id: i64,
    ) -> Result<Vec<Order>, EsiError> {
        self.orders_for(region_id, type_id).await
    }

    /// Daily history for a type in a region (cached per region).
    async fn history_for(&self, region_id: i64, type_id: i64) -> Result<Vec<HistoryDay>, EsiError> {
        if let Some(cached) = self.history.get(&(region_id, type_id)) {
            return Ok(cached);
        }
        let gate = self.history_flight.lock_for(&(region_id, type_id));
        let _flight = gate.lock().await;
        if let Some(cached) = self.history.get(&(region_id, type_id)) {
            return Ok(cached);
        }
        let path = format!("/latest/markets/{region_id}/history/");
        let history: Vec<HistoryDay> = match self
            .esi
            .get_json(&path, &[("type_id", type_id.to_string())])
            .await
        {
            Ok(history) => history,
            Err(e) if is_not_found(&e) => Vec::new(),
            Err(e) => return Err(e),
        };
        self.history.put((region_id, type_id), history.clone());
        Ok(history)
    }

    /// Global adjusted/average prices, keyed by type id (cached as a whole).
    async fn adjusted_prices(&self) -> Result<Arc<HashMap<i64, AdjustedPrice>>, EsiError> {
        if let Some(cached) = self.prices.get(&()) {
            return Ok(cached);
        }
        let gate = self.prices_flight.lock_for(&());
        let _flight = gate.lock().await;
        if let Some(cached) = self.prices.get(&()) {
            return Ok(cached);
        }
        let list: Vec<AdjustedPrice> = self.esi.get_json("/latest/markets/prices/", &[]).await?;
        let map: HashMap<i64, AdjustedPrice> = list.into_iter().map(|p| (p.type_id, p)).collect();
        let arc = Arc::new(map);
        self.prices.put((), arc.clone());
        Ok(arc)
    }

    /// Raw daily market history for a type in a region (ascending by date),
    /// cached. Feeds the market history explorer.
    pub async fn history(&self, region_id: i64, type_id: i64) -> Result<Vec<HistoryDay>, EsiError> {
        self.history_for(region_id, type_id).await
    }

    /// Full price model for one type at a location, using live ESI orders +
    /// history (precise, with real daily-traded volume).
    pub async fn price_model(
        &self,
        location: Location,
        type_id: i64,
    ) -> Result<PriceModel, EsiError> {
        let adjusted = self.adjusted_prices().await?;
        let orders = self.orders_for(location.region_id(), type_id).await?;
        let history = self.history_for(location.region_id(), type_id).await?;
        Ok(assemble_price_model(
            type_id,
            &orders,
            &history,
            adjusted.get(&type_id),
            self.ma_days,
            location.station_id(),
        ))
    }

    /// Price models for many types at a location via live ESI orders + history.
    pub async fn price_models(
        &self,
        location: Location,
        type_ids: &[i64],
    ) -> Result<Vec<PriceModel>, EsiError> {
        let adjusted = self.adjusted_prices().await?;
        let mut out = Vec::with_capacity(type_ids.len());
        for &type_id in type_ids {
            let orders = self.orders_for(location.region_id(), type_id).await?;
            let history = self.history_for(location.region_id(), type_id).await?;
            out.push(assemble_price_model(
                type_id,
                &orders,
                &history,
                adjusted.get(&type_id),
                self.ma_days,
                location.station_id(),
            ));
        }
        Ok(out)
    }

    /// Fuzzwork aggregates for the given types at a location, cached per type.
    async fn aggregates_for(
        &self,
        location: Location,
        type_ids: &[i64],
    ) -> Result<HashMap<i64, Aggregate>, EsiError> {
        let key = location.key();
        let mut out = HashMap::with_capacity(type_ids.len());
        let mut misses = Vec::new();
        for &type_id in type_ids {
            match self.aggregates.get(&(key, type_id)) {
                Some(agg) => {
                    out.insert(type_id, agg);
                }
                None => misses.push(type_id),
            }
        }
        if !misses.is_empty() {
            // Single-flight per location: a concurrent scan of the same hub
            // waits here, then re-checks the cache and fetches only what's
            // still missing (usually nothing).
            let gate = self.aggregates_flight.lock_for(&key);
            let _flight = gate.lock().await;
            misses.retain(|&type_id| match self.aggregates.get(&(key, type_id)) {
                Some(agg) => {
                    out.insert(type_id, agg);
                    false
                }
                None => true,
            });
            if !misses.is_empty() {
                let fetched = self.fuzzwork.aggregates(location, &misses).await?;
                for (type_id, agg) in fetched {
                    self.aggregates.put((key, type_id), agg.clone());
                    out.insert(type_id, agg);
                }
            }
        }
        Ok(out)
    }

    /// Average daily-**traded** volume (units moved/day) over the last `days` of
    /// market history, for many types in a region, fetched concurrently. This is
    /// the real liquidity measure (vs. Fuzzwork's order-book *listed* units).
    /// Types with no history map to 0. Errors are swallowed per-type as 0 so one
    /// missing type can't fail the batch.
    pub async fn daily_traded_volumes(
        &self,
        region_id: i64,
        type_ids: &[i64],
        days: usize,
    ) -> HashMap<i64, i64> {
        use futures_util::stream::{self, StreamExt};
        const CONCURRENCY: usize = 16;
        stream::iter(type_ids.iter().copied())
            .map(|type_id| async move {
                let volume = match self.history_for(region_id, type_id).await {
                    Ok(history) => average_recent_volume(&history, days),
                    Err(_) => 0,
                };
                (type_id, volume)
            })
            .buffer_unordered(CONCURRENCY)
            .collect::<HashMap<i64, i64>>()
            .await
    }

    /// Like [`daily_traded_volumes`](Self::daily_traded_volumes) but also returns
    /// the recent **price band** (avg / low / high over the window) per type, so
    /// callers can flag a current price sitting at a historical extreme. One
    /// concurrent history fetch per type; missing history → zeroed stats.
    pub async fn daily_traded_stats(
        &self,
        region_id: i64,
        type_ids: &[i64],
        days: usize,
    ) -> HashMap<i64, TradedStats> {
        use futures_util::stream::{self, StreamExt};
        const CONCURRENCY: usize = 16;
        stream::iter(type_ids.iter().copied())
            .map(|type_id| async move {
                let stats = match self.history_for(region_id, type_id).await {
                    Ok(history) => recent_stats(&history, days),
                    Err(_) => TradedStats::default(),
                };
                (type_id, stats)
            })
            .buffer_unordered(CONCURRENCY)
            .collect::<HashMap<i64, TradedStats>>()
            .await
    }

    /// Price models for many types at a [`Location`] (region average or a hub),
    /// using Fuzzwork aggregates for sell/buy/volume plus the global adjusted
    /// price for the EIV (job-fee) basis. This is the bulk pricing path used to
    /// rank the whole catalogue.
    pub async fn price_models_at(
        &self,
        location: Location,
        type_ids: &[i64],
    ) -> Result<Vec<PriceModel>, EsiError> {
        let adjusted = self.adjusted_prices().await?;
        let aggregates = self.aggregates_for(location, type_ids).await?;
        Ok(type_ids
            .iter()
            .map(|&type_id| {
                model_from_aggregate(type_id, aggregates.get(&type_id), adjusted.get(&type_id))
            })
            .collect())
    }

    /// Like [`price_models_at`](Self::price_models_at), collected into a
    /// [`PriceMap`] keyed by type id — the shape most bulk-pricing call sites
    /// actually want, instead of hand-assembling a `HashMap` plus a
    /// `sell_percentile` accessor closure at every call site.
    pub async fn price_map_at(
        &self,
        location: Location,
        type_ids: &[i64],
    ) -> Result<PriceMap, EsiError> {
        let models = self.price_models_at(location, type_ids).await?;
        Ok(PriceMap(models.into_iter().map(|m| (m.type_id, m)).collect()))
    }

    /// For each type, the hub with the **highest realistic sell price** — "where
    /// is this worth the most to sell". Prices every known hub (Fuzzwork
    /// aggregates per hub station) and keeps the max `sell_percentile`. Types
    /// with no priced hub are absent from the map. Shared by production
    /// ("sell at best hub"), appraisal, and assets.
    pub async fn best_sell_hubs(
        &self,
        type_ids: &[i64],
    ) -> Result<HashMap<i64, BestSell>, EsiError> {
        let mut best: HashMap<i64, BestSell> = HashMap::new();
        for hub in super::markets::regions() {
            let station_id = hub.stations.first().map(|s| s.id);
            let label = hub
                .stations
                .first()
                .map(|s| s.name.clone())
                .unwrap_or_else(|| hub.name.clone());
            let location = super::markets::resolve_location(hub.id, station_id);
            for model in self.price_models_at(location, type_ids).await? {
                let Some(price) = model.sell_percentile else {
                    continue;
                };
                let entry = best.entry(model.type_id).or_insert(BestSell {
                    region_id: hub.id,
                    hub: label.clone(),
                    price,
                });
                if price > entry.price {
                    *entry = BestSell {
                        region_id: hub.id,
                        hub: label.clone(),
                        price,
                    };
                }
            }
        }
        Ok(best)
    }
}

/// The best hub to sell a type at, and that hub's realistic sell price.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BestSell {
    pub region_id: i64,
    pub hub: String,
    pub price: f64,
}

/// A lookup table of [`PriceModel`]s by type id, built by
/// [`MarketService::price_map_at`]. Replaces the hand-assembled
/// `HashMap<i64, PriceModel>` + `sell_percentile` accessor closure that used
/// to be repeated at every bulk-pricing call site.
#[derive(Debug, Clone, Default)]
pub struct PriceMap(HashMap<i64, PriceModel>);

impl PriceMap {
    /// The full price model for a type, if it was priced.
    pub fn get(&self, type_id: i64) -> Option<&PriceModel> {
        self.0.get(&type_id)
    }

    /// Realistic sell price (percentile), if the type has sell orders.
    pub fn sell(&self, type_id: i64) -> Option<f64> {
        self.get(type_id).and_then(|m| m.sell_percentile)
    }

    /// Realistic sell price, or `0.0` if the type is unpriced.
    pub fn sell_or_zero(&self, type_id: i64) -> f64 {
        self.sell(type_id).unwrap_or(0.0)
    }
}

/// Recent traded volume + price band over the last `days` of history.
#[derive(Debug, Clone, Default)]
pub struct TradedStats {
    /// Mean daily traded volume.
    pub volume: i64,
    /// Lowest daily low in the window.
    pub low: f64,
    /// Highest daily high in the window.
    pub high: f64,
}

/// Volume + price band (avg/low/high) over the `days` most recent history days.
fn recent_stats(history: &[HistoryDay], days: usize) -> TradedStats {
    if history.is_empty() || days == 0 {
        return TradedStats::default();
    }
    let recent = &history[history.len().saturating_sub(days)..];
    let volume = recent.iter().map(|h| h.volume).sum::<i64>() / recent.len() as i64;
    let low = recent
        .iter()
        .map(|h| if h.lowest > 0.0 { h.lowest } else { h.average })
        .fold(f64::INFINITY, f64::min);
    let high = recent
        .iter()
        .map(|h| h.highest.max(h.average))
        .fold(0.0_f64, f64::max);
    TradedStats {
        volume,
        low: if low.is_finite() { low } else { 0.0 },
        high,
    }
}

/// Mean of the `days` most recent days' traded volume. ESI history is ascending
/// by date, so the tail is the newest. Empty history → 0.
fn average_recent_volume(history: &[HistoryDay], days: usize) -> i64 {
    if history.is_empty() || days == 0 {
        return 0;
    }
    let recent = &history[history.len().saturating_sub(days)..];
    let total: i64 = recent.iter().map(|h| h.volume).sum();
    total / recent.len() as i64
}

/// Only treat a side as priced if it actually has orders.
fn priced(value: f64, order_count: i64) -> Option<f64> {
    (order_count > 0 && value > 0.0).then_some(value)
}

fn model_from_aggregate(
    type_id: i64,
    aggregate: Option<&Aggregate>,
    adjusted: Option<&AdjustedPrice>,
) -> PriceModel {
    let sell = aggregate.map(|a| &a.sell);
    let buy = aggregate.map(|a| &a.buy);
    PriceModel {
        type_id,
        sell_min: sell.and_then(|s| priced(s.min, s.order_count)),
        buy_max: buy.and_then(|b| priced(b.max, b.order_count)),
        sell_percentile: sell.and_then(|s| priced(s.percentile, s.order_count)),
        buy_percentile: buy.and_then(|b| priced(b.percentile, b.order_count)),
        average_price: sell.and_then(|s| priced(s.weighted_average, s.order_count)),
        adjusted_price: adjusted.and_then(|a| a.adjusted_price),
        daily_volume: sell.map(|s| s.volume as i64),
        buy_volume: buy.map(|b| b.volume as i64),
        order_count: sell.map(|s| s.order_count),
        daily_average: None,
        moving_average: None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(volume: i64) -> HistoryDay {
        HistoryDay {
            date: "2026-01-01".into(),
            average: 1.0,
            highest: 1.0,
            lowest: 1.0,
            order_count: 1,
            volume,
        }
    }

    #[test]
    fn averages_only_the_recent_window() {
        // Oldest → newest; last 3 of [10,20,30,40,50] = (30+40+50)/3 = 40.
        let history: Vec<HistoryDay> = [10, 20, 30, 40, 50].into_iter().map(day).collect();
        assert_eq!(average_recent_volume(&history, 3), 40);
        // Window longer than history → average of everything.
        assert_eq!(average_recent_volume(&history, 99), 30);
        // No history → 0, never a panic.
        assert_eq!(average_recent_volume(&[], 7), 0);
    }
}
