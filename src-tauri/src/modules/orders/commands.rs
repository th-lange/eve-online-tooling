//! Market Orders — the logged-in character's open buy/sell orders, with
//! undercut detection against the current best price at each order's station.
//!
//! Requires the `esi-markets.read_character_orders.v1` scope (must be enabled on
//! the EVE app + a re-login before this returns data).

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::esi::{authed_get, resolve_names, AuthState};
use crate::market::{resolve_location, MarketService, PriceModel};
use crate::model::AppError;
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
    pub character_id: i64,
    pub character_name: String,
    pub order_id: i64,
    pub type_id: i64,
    pub name: String,
    pub is_buy: bool,
    pub price: f64,
    pub volume_remain: i64,
    pub volume_total: i64,
    pub location: String,
    pub region_id: i64,
    /// The station/structure the order sits in (ESI `location_id`).
    pub location_id: i64,
    /// Current best competing price at the order's **station** (sell-min for a
    /// sell order, buy-max for a buy order), or null if unpriced (e.g. a private
    /// structure with no public market data).
    pub best_price: Option<f64>,
    /// True when someone is beating this order (cheaper sell / higher buy).
    pub undercut: bool,
    pub issued: String,
}

/// Open market orders across the target characters (the whole roster when
/// "All characters" is active, else just the active one), each flagged as
/// undercut or top-of-book against the current best price **at the order's
/// own station**. A character whose orders can't be fetched is skipped
/// rather than failing the whole call.
#[tauri::command]
pub async fn market_orders(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
    market: State<'_, MarketService>,
) -> Result<Vec<OrderRow>, AppError> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    collect_orders(&dir, &auth_state, &market).await
}

/// Open orders across the target characters — the app-free core, shared by the
/// command and the capability registry.
pub(crate) async fn collect_orders(
    dir: &Path,
    auth: &AuthState,
    market: &MarketService,
) -> Result<Vec<OrderRow>, AppError> {
    let character_ids = storage::target_characters(dir);
    if character_ids.is_empty() {
        return Err(AppError::auth_required());
    }
    let names = storage::character_names(dir);

    let mut rows = Vec::new();
    for character_id in character_ids {
        let character_name = names.get(&character_id).cloned().unwrap_or_default();
        if let Ok(mut character_rows) =
            fetch_character_orders(auth, market, dir, character_id, &character_name).await
        {
            rows.append(&mut character_rows);
        }
    }
    Ok(rows)
}

/// One character's open orders, priced and flagged for undercut.
async fn fetch_character_orders(
    auth_state: &AuthState,
    market: &MarketService,
    dir: &std::path::Path,
    character_id: i64,
    character_name: &str,
) -> Result<Vec<OrderRow>, AppError> {
    let orders: Vec<EsiOrder> = authed_get(
        auth_state,
        character_id,
        &format!("/latest/characters/{character_id}/orders/"),
    )
    .await
    .map_err(|e| e.to_string())?;
    if orders.is_empty() {
        return Ok(Vec::new());
    }

    // Best price per (station, type): price each order against the *station* it
    // sits in (not the whole region), so undercut reflects local competition.
    // One Fuzzwork pull per station the character has orders in.
    let mut by_station: HashMap<(i64, i64), Vec<i64>> = HashMap::new();
    for o in &orders {
        by_station
            .entry((o.region_id, o.location_id))
            .or_default()
            .push(o.type_id);
    }
    let mut best: HashMap<(i64, i64), PriceModel> = HashMap::new();
    for ((region_id, location_id), type_ids) in &by_station {
        let models = market
            .price_models_at(resolve_location(*region_id, Some(*location_id)), type_ids)
            .await
            .map_err(|e| e.to_string())?;
        for m in models {
            best.insert((*location_id, m.type_id), m);
        }
    }

    // Names: type from SDE, location from /universe/names (NPC stations resolve;
    // player structures may not — fall back to the id).
    let loc_ids: Vec<i64> = orders.iter().map(|o| o.location_id).collect();
    let loc_names = resolve_names(auth_state, &loc_ids).await;
    let sde = Sde::open(&SdePaths::new(dir.to_path_buf()).db).map_err(|e| e.to_string())?;

    let rows = orders
        .into_iter()
        .map(|o| {
            let model = best.get(&(o.location_id, o.type_id));
            let best_price = if o.is_buy_order {
                model.and_then(|m| m.buy_max)
            } else {
                model.and_then(|m| m.sell_min)
            };
            let undercut = is_undercut(best_price, o.price, o.is_buy_order);
            let name = sde
                .type_info(o.type_id)
                .ok()
                .flatten()
                .map(|t| t.name)
                .unwrap_or_else(|| format!("Type {}", o.type_id));
            OrderRow {
                character_id,
                character_name: character_name.to_string(),
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
                location_id: o.location_id,
                best_price,
                undercut,
                issued: o.issued,
            }
        })
        .collect();
    Ok(rows)
}

/// Whether someone is beating this order: a cheaper competing sell (`best < mine`)
/// or a higher competing buy (`best > mine`). Holding the best price yourself
/// means `best == mine` → not undercut. No competing price ⇒ not undercut.
fn is_undercut(best_price: Option<f64>, price: f64, is_buy: bool) -> bool {
    match best_price {
        Some(b) if is_buy => b > price,
        Some(b) => b < price,
        None => false,
    }
}

#[cfg(test)]
mod tests {
    use super::is_undercut;

    #[test]
    fn sell_order_is_undercut_only_by_a_cheaper_sell() {
        // A cheaper competing sell undercuts; equal (you hold best) or dearer does not.
        assert!(is_undercut(Some(99.0), 100.0, false));
        assert!(!is_undercut(Some(100.0), 100.0, false));
        assert!(!is_undercut(Some(101.0), 100.0, false));
    }

    #[test]
    fn buy_order_is_undercut_only_by_a_higher_buy() {
        assert!(is_undercut(Some(101.0), 100.0, true));
        assert!(!is_undercut(Some(100.0), 100.0, true));
        assert!(!is_undercut(Some(99.0), 100.0, true));
    }

    #[test]
    fn no_competing_price_is_never_undercut() {
        assert!(!is_undercut(None, 100.0, false));
        assert!(!is_undercut(None, 100.0, true));
    }
}
