//! Market Orders — the logged-in character's open buy/sell orders, with
//! undercut detection against the current best price at each order's region.
//!
//! Requires the `esi-markets.read_character_orders.v1` scope (must be enabled on
//! the EVE app + a re-login before this returns data).

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::esi::{authed_get, resolve_names, AuthState};
use crate::market::{resolve_location, MarketService, PriceModel};
use crate::sde::{Sde, SdePaths};
use crate::storage;

#[derive(Deserialize)]
struct EsiOrder {
    order_id: i64,
    type_id: i64,
    #[serde(default)]
    is_buy_order: bool,
    price: f64,
    volume_remain: i64,
    volume_total: i64,
    location_id: i64,
    region_id: i64,
    issued: String,
}

/// One of the character's open market orders, with undercut status.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderRow {
    pub order_id: i64,
    pub type_id: i64,
    pub name: String,
    pub is_buy: bool,
    pub price: f64,
    pub volume_remain: i64,
    pub volume_total: i64,
    pub location: String,
    pub region_id: i64,
    /// Current best competing price at the order's region (sell-min for a sell
    /// order, buy-max for a buy order), or null if unpriced.
    pub best_price: Option<f64>,
    /// True when someone is beating this order (cheaper sell / higher buy).
    pub undercut: bool,
    pub issued: String,
}

/// The first roster character's open market orders, each flagged as undercut or
/// top-of-book against the region's current best price.
#[tauri::command]
pub async fn market_orders(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
    market: State<'_, MarketService>,
) -> Result<Vec<OrderRow>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let character_id = storage::load_roster(&dir)
        .into_iter()
        .next()
        .map(|c| c.character_id)
        .ok_or_else(|| "Log in a character first".to_string())?;

    let orders: Vec<EsiOrder> = authed_get(
        &auth_state,
        character_id,
        &format!("/latest/characters/{character_id}/orders/"),
    )
    .await
    .map_err(|e| e.to_string())?;
    if orders.is_empty() {
        return Ok(Vec::new());
    }

    // Best price per (region, type): one Fuzzwork pull per region.
    let mut by_region: HashMap<i64, Vec<i64>> = HashMap::new();
    for o in &orders {
        by_region.entry(o.region_id).or_default().push(o.type_id);
    }
    let mut best: HashMap<(i64, i64), PriceModel> = HashMap::new();
    for (region_id, type_ids) in &by_region {
        let models = market
            .price_models_at(resolve_location(*region_id, None), type_ids)
            .await
            .map_err(|e| e.to_string())?;
        for m in models {
            best.insert((*region_id, m.type_id), m);
        }
    }

    // Names: type from SDE, location from /universe/names (NPC stations resolve;
    // player structures may not — fall back to the id).
    let sde = Sde::open(&SdePaths::new(dir).db).map_err(|e| e.to_string())?;
    let loc_ids: Vec<i64> = orders.iter().map(|o| o.location_id).collect();
    let loc_names = resolve_names(&auth_state, &loc_ids).await;

    let rows = orders
        .into_iter()
        .map(|o| {
            let model = best.get(&(o.region_id, o.type_id));
            let best_price = if o.is_buy_order {
                model.and_then(|m| m.buy_max)
            } else {
                model.and_then(|m| m.sell_min)
            };
            // Undercut: a cheaper sell (best < mine) or a higher buy (best > mine)
            // exists. When you hold the best, best == your price → not undercut.
            let undercut = match best_price {
                Some(b) if o.is_buy_order => b > o.price,
                Some(b) => b < o.price,
                None => false,
            };
            let name = sde
                .type_info(o.type_id)
                .ok()
                .flatten()
                .map(|t| t.name)
                .unwrap_or_else(|| format!("Type {}", o.type_id));
            OrderRow {
                order_id: o.order_id,
                type_id: o.type_id,
                name,
                is_buy: o.is_buy_order,
                price: o.price,
                volume_remain: o.volume_remain,
                volume_total: o.volume_total,
                location: loc_names
                    .get(&o.location_id)
                    .cloned()
                    .unwrap_or_else(|| format!("Location {}", o.location_id)),
                region_id: o.region_id,
                best_price,
                undercut,
                issued: o.issued,
            }
        })
        .collect();
    Ok(rows)
}
