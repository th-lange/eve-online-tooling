//! Market price service: fetch ESI market data, cache it, and assemble the
//! multi-vector [`PriceModel`] per type.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use crate::esi::{EsiClient, EsiError};

use super::aggregate::assemble_price_model;
use super::cache::TtlCache;
use super::types::{
    AdjustedPrice, HistoryDay, Order, PriceModel, JITA_STATION_ID, THE_FORGE_REGION_ID,
};

/// Default window for the moving-average vector.
const MA_DAYS: usize = 7;

pub struct MarketService {
    esi: EsiClient,
    region_id: i64,
    station_id: i64,
    ma_days: usize,
    orders: TtlCache<i64, Vec<Order>>,
    history: TtlCache<i64, Vec<HistoryDay>>,
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
            region_id: THE_FORGE_REGION_ID,
            station_id: JITA_STATION_ID,
            ma_days: MA_DAYS,
            // TTLs roughly track ESI cache timers.
            orders: TtlCache::new(Duration::from_secs(300)),
            history: TtlCache::new(Duration::from_secs(1200)),
            prices: TtlCache::new(Duration::from_secs(3600)),
        }
    }

    /// Spot orders for a type in the hub region (cached).
    async fn orders_for(&self, type_id: i64) -> Result<Vec<Order>, EsiError> {
        if let Some(cached) = self.orders.get(&type_id) {
            return Ok(cached);
        }
        let path = format!("/latest/markets/{}/orders/", self.region_id);
        let orders: Vec<Order> = self
            .esi
            .get_paged(
                &path,
                &[
                    ("type_id", type_id.to_string()),
                    ("order_type", "all".to_string()),
                ],
            )
            .await?;
        self.orders.put(type_id, orders.clone());
        Ok(orders)
    }

    /// Daily history for a type in the hub region (cached).
    async fn history_for(&self, type_id: i64) -> Result<Vec<HistoryDay>, EsiError> {
        if let Some(cached) = self.history.get(&type_id) {
            return Ok(cached);
        }
        let path = format!("/latest/markets/{}/history/", self.region_id);
        let history: Vec<HistoryDay> = self
            .esi
            .get_json(&path, &[("type_id", type_id.to_string())])
            .await?;
        self.history.put(type_id, history.clone());
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

    /// Full price model for one type.
    pub async fn price_model(&self, type_id: i64) -> Result<PriceModel, EsiError> {
        let adjusted = self.adjusted_prices().await?;
        let orders = self.orders_for(type_id).await?;
        let history = self.history_for(type_id).await?;
        Ok(assemble_price_model(
            type_id,
            &orders,
            &history,
            adjusted.get(&type_id),
            self.ma_days,
            self.station_id,
        ))
    }

    /// Price models for many types. Global prices are fetched once and reused.
    pub async fn price_models(&self, type_ids: &[i64]) -> Result<Vec<PriceModel>, EsiError> {
        let adjusted = self.adjusted_prices().await?;
        let mut out = Vec::with_capacity(type_ids.len());
        for &type_id in type_ids {
            let orders = self.orders_for(type_id).await?;
            let history = self.history_for(type_id).await?;
            out.push(assemble_price_model(
                type_id,
                &orders,
                &history,
                adjusted.get(&type_id),
                self.ma_days,
                self.station_id,
            ));
        }
        Ok(out)
    }
}
