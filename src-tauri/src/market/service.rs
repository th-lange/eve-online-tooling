//! Market price service: fetch ESI market data, cache it, and assemble the
//! multi-vector [`PriceModel`] per type for a chosen [`Market`].

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use crate::esi::{EsiClient, EsiError};

use super::aggregate::assemble_price_model;
use super::cache::TtlCache;
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
}

impl Default for MarketService {
    fn default() -> Self {
        Self::new()
    }
}

impl MarketService {
    pub fn new() -> Self {
        Self {
            esi: EsiClient::new(),
            fuzzwork: FuzzworkClient::new(),
            ma_days: MA_DAYS,
            // TTLs roughly track ESI cache timers.
            orders: TtlCache::new(Duration::from_secs(300)),
            history: TtlCache::new(Duration::from_secs(1200)),
            aggregates: TtlCache::new(Duration::from_secs(900)),
            prices: TtlCache::new(Duration::from_secs(3600)),
        }
    }

    /// Spot orders for a type in a region (cached per region).
    async fn orders_for(&self, region_id: i64, type_id: i64) -> Result<Vec<Order>, EsiError> {
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

    /// Daily history for a type in a region (cached per region).
    async fn history_for(&self, region_id: i64, type_id: i64) -> Result<Vec<HistoryDay>, EsiError> {
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
        let list: Vec<AdjustedPrice> = self.esi.get_json("/latest/markets/prices/", &[]).await?;
        let map: HashMap<i64, AdjustedPrice> = list.into_iter().map(|p| (p.type_id, p)).collect();
        let arc = Arc::new(map);
        self.prices.put((), arc.clone());
        Ok(arc)
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
            let fetched = self.fuzzwork.aggregates(location, &misses).await?;
            for (type_id, agg) in fetched {
                self.aggregates.put((key, type_id), agg.clone());
                out.insert(type_id, agg);
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
