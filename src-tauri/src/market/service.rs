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
