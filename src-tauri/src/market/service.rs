//! Market price service: fetch ESI market data, cache it, and assemble the
//! multi-vector [`PriceModel`] per type for a chosen [`Market`].

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use crate::esi::{EsiClient, EsiError};

use super::aggregate::assemble_price_model;
use super::cache::TtlCache;
use super::markets::Market;
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
    ma_days: usize,
    // Orders/history are region-scoped, so cache them by (region_id, type_id).
    orders: TtlCache<(i64, i64), Vec<Order>>,
    history: TtlCache<(i64, i64), Vec<HistoryDay>>,
    // Global adjusted/average prices (one document for all types).
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
            ma_days: MA_DAYS,
            // TTLs roughly track ESI cache timers.
            orders: TtlCache::new(Duration::from_secs(300)),
            history: TtlCache::new(Duration::from_secs(1200)),
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

    /// Full price model for one type at the given market.
    pub async fn price_model(&self, market: &Market, type_id: i64) -> Result<PriceModel, EsiError> {
        let adjusted = self.adjusted_prices().await?;
        let orders = self.orders_for(market.region_id, type_id).await?;
        let history = self.history_for(market.region_id, type_id).await?;
        Ok(assemble_price_model(
            type_id,
            &orders,
            &history,
            adjusted.get(&type_id),
            self.ma_days,
            market.station_id,
        ))
    }

    /// Price models for many types at the given market. Global prices are
    /// fetched once and reused.
    pub async fn price_models(
        &self,
        market: &Market,
        type_ids: &[i64],
    ) -> Result<Vec<PriceModel>, EsiError> {
        let adjusted = self.adjusted_prices().await?;
        let mut out = Vec::with_capacity(type_ids.len());
        for &type_id in type_ids {
            let orders = self.orders_for(market.region_id, type_id).await?;
            let history = self.history_for(market.region_id, type_id).await?;
            out.push(assemble_price_model(
                type_id,
                &orders,
                &history,
                adjusted.get(&type_id),
                self.ma_days,
                market.station_id,
            ));
        }
        Ok(out)
    }

    /// Cheap price models for many types using only the global adjusted/average
    /// prices (one ESI call total, market-independent). Spot sell/buy and volume
    /// are left empty — for ranking the whole catalogue, where per-item fetches
    /// don't scale.
    pub async fn average_price_models(
        &self,
        type_ids: &[i64],
    ) -> Result<Vec<PriceModel>, EsiError> {
        let adjusted = self.adjusted_prices().await?;
        Ok(type_ids
            .iter()
            .map(|&type_id| {
                let a = adjusted.get(&type_id);
                PriceModel {
                    type_id,
                    adjusted_price: a.and_then(|x| x.adjusted_price),
                    average_price: a.and_then(|x| x.average_price),
                    ..Default::default()
                }
            })
            .collect())
    }
}
