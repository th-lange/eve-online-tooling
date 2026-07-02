//! LP-store browser + calculator — rank an NPC corp's loyalty-store offers by
//! ISK/LP yield. Offers are public; the character's LP balances need a scope.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::esi::{authed_get, resolve_names, AuthState, EsiClient};
use crate::market::{resolve_location, MarketService, PriceModel};
use crate::sde::{Sde, SdePaths};
use crate::storage;

fn first_character(app: &AppHandle) -> Result<i64, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    storage::active_character(&dir).ok_or_else(|| "Log in a character first".to_string())
}

// --- LP balances (corp picker) ---

#[derive(Deserialize)]
struct EsiLoyalty {
    corporation_id: i64,
    loyalty_points: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LpBalance {
    pub corporation_id: i64,
    pub corporation: String,
    pub points: i64,
}

/// The character's loyalty-point balance per NPC corporation.
#[tauri::command]
pub async fn lp_balances(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
) -> Result<Vec<LpBalance>, String> {
    let character_id = first_character(&app)?;
    let points: Vec<EsiLoyalty> = authed_get(
        &auth_state,
        character_id,
        &format!("/latest/characters/{character_id}/loyalty/points/"),
    )
    .await
    .map_err(|e| e.to_string())?;
    let ids: Vec<i64> = points.iter().map(|p| p.corporation_id).collect();
    let names = resolve_names(&auth_state, &ids).await;
    let mut out: Vec<LpBalance> = points
        .into_iter()
        .map(|p| LpBalance {
            corporation: names
                .get(&p.corporation_id)
                .cloned()
                .unwrap_or_else(|| format!("#{}", p.corporation_id)),
            corporation_id: p.corporation_id,
            points: p.loyalty_points,
        })
        .collect();
    out.sort_by(|a, b| b.points.cmp(&a.points));
    Ok(out)
}

// --- Offers (valued + ranked) ---

#[derive(Clone, Serialize, Deserialize)]
struct EsiOffer {
    type_id: i64,
    quantity: i64,
    lp_cost: i64,
    isk_cost: i64,
    #[serde(default)]
    required_items: Vec<EsiRequired>,
}
#[derive(Clone, Serialize, Deserialize)]
struct EsiRequired {
    type_id: i64,
    quantity: i64,
}

/// Locally-cached raw offers with the pull time, so the (rarely-changing) LP
/// store isn't re-fetched on every calculation.
#[derive(Serialize, Deserialize)]
struct CachedOffers {
    fetched_at: u64,
    offers: Vec<EsiOffer>,
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LpParams {
    pub corporation_id: i64,
    /// ISK value assigned to one loyalty point (default 1000).
    #[serde(default = "default_isk_per_lp")]
    pub isk_per_lp: f64,
    /// Force a re-pull of the offers (ignore the local cache).
    #[serde(default)]
    pub refresh: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OffersResult {
    /// Unix seconds the offers were pulled from ESI (cached locally).
    pub fetched_at: u64,
    pub rows: Vec<OfferRow>,
}
fn default_isk_per_lp() -> f64 {
    1000.0
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfferRow {
    pub name: String,
    pub quantity: i64,
    pub lp_cost: i64,
    pub isk_cost: i64,
    /// Jita sell value of the received item(s), less ~5% sales overhead.
    pub sell_value: f64,
    /// LP×rate + ISK + handed-in items at Jita.
    pub cost: f64,
    pub profit: f64,
    /// Net ISK per LP (profit / lp_cost).
    pub isk_per_lp: f64,
}

/// Rank an NPC corp's LP-store offers by ISK/LP. Offers are public; values use
/// Jita and a configurable ISK-per-LP basis.
#[tauri::command]
pub async fn lp_offers(
    app: AppHandle,
    market: State<'_, MarketService>,
    params: LpParams,
) -> Result<OffersResult, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let sde = Sde::open(&SdePaths::new(dir.clone()).db).map_err(|e| e.to_string())?;
    let esi = EsiClient::new();

    // Offers change rarely — serve them from the local cache unless refreshing.
    let key = format!("lp_offers_{}", params.corporation_id);
    let (offers, fetched_at) = match if params.refresh {
        None
    } else {
        storage::load_data::<CachedOffers>(&dir, &key)
    } {
        Some(c) => (c.offers, c.fetched_at),
        None => {
            let offers: Vec<EsiOffer> = esi
                .get_paged(
                    &format!("/latest/loyalty/stores/{}/offers/", params.corporation_id),
                    &[],
                )
                .await
                .map_err(|e| e.to_string())?;
            let fetched_at = now_secs();
            let _ = storage::save_data(
                &dir,
                &key,
                &CachedOffers {
                    fetched_at,
                    offers: offers.clone(),
                },
            );
            (offers, fetched_at)
        }
    };

    // Price every product + required item at Jita.
    let mut ids: HashSet<i64> = HashSet::new();
    for o in &offers {
        ids.insert(o.type_id);
        for r in &o.required_items {
            ids.insert(r.type_id);
        }
    }
    let ids: Vec<i64> = ids.into_iter().collect();
    let prices: HashMap<i64, PriceModel> = market
        .price_models_at(resolve_location(10_000_002, None), &ids)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|m| (m.type_id, m))
        .collect();
    let sell = |id: i64| prices.get(&id).and_then(|m| m.sell_percentile).unwrap_or(0.0);

    let mut rows: Vec<OfferRow> = offers
        .into_iter()
        .filter(|o| o.lp_cost > 0)
        .map(|o| {
            let required_cost: f64 = o
                .required_items
                .iter()
                .map(|r| r.quantity as f64 * sell(r.type_id))
                .sum();
            let v = value_offer(
                o.quantity,
                sell(o.type_id),
                o.lp_cost,
                o.isk_cost,
                required_cost,
                params.isk_per_lp,
            );
            OfferRow {
                name: sde
                    .type_info(o.type_id)
                    .ok()
                    .flatten()
                    .map(|t| t.name)
                    .unwrap_or_else(|| format!("Type {}", o.type_id)),
                quantity: o.quantity,
                lp_cost: o.lp_cost,
                isk_cost: o.isk_cost,
                sell_value: v.sell_value,
                cost: v.cost,
                profit: v.profit,
                isk_per_lp: v.isk_per_lp,
            }
        })
        .collect();
    rows.sort_by(|a, b| {
        b.isk_per_lp
            .partial_cmp(&a.isk_per_lp)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(OffersResult { fetched_at, rows })
}

/// Valued components of one LP-store offer.
struct OfferValue {
    sell_value: f64,
    cost: f64,
    profit: f64,
    /// Profit per LP spent — the ranking key.
    isk_per_lp: f64,
}

/// Value an LP-store offer: what its output sells for (less ~5% sales overhead)
/// minus its total cost — LP valued at `isk_per_lp`, plus the ISK cost and the
/// market cost of any required turn-in items. Caller guarantees `lp_cost > 0`.
fn value_offer(
    quantity: i64,
    unit_sell: f64,
    lp_cost: i64,
    isk_cost: i64,
    required_cost: f64,
    isk_per_lp: f64,
) -> OfferValue {
    let sell_value = quantity as f64 * unit_sell * 0.95;
    let cost = lp_cost as f64 * isk_per_lp + isk_cost as f64 + required_cost;
    let profit = sell_value - cost;
    OfferValue {
        sell_value,
        cost,
        profit,
        isk_per_lp: profit / lp_cost as f64,
    }
}

#[cfg(test)]
mod tests {
    use super::value_offer;

    #[test]
    fn profit_nets_sell_value_against_lp_isk_and_item_costs() {
        // 10 units sell at 100 → 1000 × 0.95 = 950 gross.
        // cost = 500 LP × 1.0 + 200 ISK + 50 items = 750. profit = 200.
        let v = value_offer(10, 100.0, 500, 200, 50.0, 1.0);
        assert!((v.sell_value - 950.0).abs() < 1e-6);
        assert!((v.cost - 750.0).abs() < 1e-6);
        assert!((v.profit - 200.0).abs() < 1e-6);
        // isk_per_lp = profit / lp_cost = 200 / 500 = 0.4.
        assert!((v.isk_per_lp - 0.4).abs() < 1e-6);
    }

    #[test]
    fn a_higher_lp_valuation_lowers_profit() {
        // Raising the ISK/LP assumption raises the cost basis, shrinking profit.
        let cheap = value_offer(10, 100.0, 500, 0, 0.0, 0.0);
        let dear = value_offer(10, 100.0, 500, 0, 0.0, 1.0);
        assert!(dear.profit < cheap.profit);
    }
}
