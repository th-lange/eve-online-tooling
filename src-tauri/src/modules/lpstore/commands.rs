//! LP-store browser + calculator — rank an NPC corp's loyalty-store offers by
//! ISK/LP yield. Offers are public; the character's LP balances need a scope.

use std::collections::HashSet;
use std::path::Path;

use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::esi::{authed_get, resolve_names, AuthState, EsiClient, EsiError};
use crate::market::{jita_location, MarketService};
use crate::model::AppError;
use crate::storage;

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
) -> Result<Vec<LpBalance>, AppError> {
    let (_, character_id) = storage::dir_and_primary_character(&app)?;
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
    out.sort_by_key(|o| std::cmp::Reverse(o.points));
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
    esi: State<'_, EsiClient>,
    params: LpParams,
) -> Result<OffersResult, String> {
    let (dir, sde) = crate::sde::dir_and_sde(&app)?;

    // Offers change rarely — serve them from the local cache unless refreshing.
    let (offers, fetched_at) = corp_offers(&esi, &dir, params.corporation_id, params.refresh)
        .await
        .map_err(|e| e.to_string())?;

    // Price every product + required item at Jita.
    let mut ids: HashSet<i64> = HashSet::new();
    for o in &offers {
        ids.insert(o.type_id);
        for r in &o.required_items {
            ids.insert(r.type_id);
        }
    }
    let ids: Vec<i64> = ids.into_iter().collect();
    let prices = market
        .price_map_at(jita_location(), &ids)
        .await
        .map_err(|e| e.to_string())?;
    let sell = |id: i64| prices.sell_or_zero(id);
    let names = sde.type_name_map(&ids).map_err(|e| e.to_string())?;

    let mut rows: Vec<OfferRow> = offers
        .into_iter()
        .filter(|o| o.lp_cost > 0)
        .map(|o| offer_row(&o, names.get(o.type_id), &sell, params.isk_per_lp))
        .collect();
    rows.sort_by(|a, b| {
        b.isk_per_lp
            .partial_cmp(&a.isk_per_lp)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(OffersResult { fetched_at, rows })
}

/// Offers for one corp — the local cache first (unless `refresh`), else ESI,
/// persisting the pull. Returns the offers with their pull time (Unix secs).
async fn corp_offers(
    esi: &EsiClient,
    dir: &Path,
    corporation_id: i64,
    refresh: bool,
) -> Result<(Vec<EsiOffer>, u64), EsiError> {
    let key = format!("lp_offers_{corporation_id}");
    if !refresh {
        if let Some(c) = storage::load_data::<CachedOffers>(dir, &key) {
            return Ok((c.offers, c.fetched_at));
        }
    }
    let offers: Vec<EsiOffer> = esi
        .get_paged(
            &format!("/latest/loyalty/stores/{corporation_id}/offers/"),
            &[],
        )
        .await?;
    let fetched_at = crate::util::time::now_secs();
    let _ = storage::save_data(
        dir,
        &key,
        &CachedOffers {
            fetched_at,
            offers: offers.clone(),
        },
    );
    Ok((offers, fetched_at))
}

/// One valued [`OfferRow`] for an offer (caller filters `lp_cost > 0` first).
fn offer_row(o: &EsiOffer, name: String, sell: &impl Fn(i64) -> f64, isk_per_lp: f64) -> OfferRow {
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
        isk_per_lp,
    );
    OfferRow {
        name,
        quantity: o.quantity,
        lp_cost: o.lp_cost,
        isk_cost: o.isk_cost,
        sell_value: v.sell_value,
        cost: v.cost,
        profit: v.profit,
        isk_per_lp: v.isk_per_lp,
    }
}

// --- Item search (which corps offer it) ---

/// Corps scanned concurrently; payloads are small (a cold scan of all ~283
/// corps measured ~2s at this width), well under the ESI error budget.
const SCAN_CONCURRENCY: usize = 8;
/// Cap on SDE name matches a search expands to — keeps "Scourge" bounded.
const SEARCH_TYPE_CAP: i64 = 50;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LpSearchParams {
    /// Item-name query, matched like every other type picker (each term a
    /// case-insensitive substring).
    pub query: String,
    #[serde(default = "default_isk_per_lp")]
    pub isk_per_lp: f64,
    /// Re-pull every corp's offers from ESI (ignore the local caches).
    #[serde(default)]
    pub refresh: bool,
}

/// One LP-store offer for a matching item, tagged with the corp selling it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LpSearchRow {
    pub corporation_id: i64,
    pub corporation: String,
    #[serde(flatten)]
    pub offer: OfferRow,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LpSearchResult {
    /// Unix secs of the oldest per-corp pull used — the staleness bound.
    pub oldest_fetched_at: u64,
    /// Corps skipped this scan because their offers couldn't be fetched
    /// (transient ESI errors) — the result may be missing their offers.
    pub failed_corporations: usize,
    pub rows: Vec<LpSearchRow>,
}

/// Search every NPC corp's LP store for offers of an item: which corps sell
/// it, for how much LP/ISK/turn-ins, valued at Jita like [`lp_offers`].
/// Offers are public — no login needed. Per-corp pulls are cached on disk
/// (shared with [`lp_offers`]), so only the first scan hits every corp.
#[tauri::command]
pub async fn lp_search(
    app: AppHandle,
    market: State<'_, MarketService>,
    esi: State<'_, EsiClient>,
    params: LpSearchParams,
) -> Result<LpSearchResult, String> {
    let (dir, sde) = crate::sde::dir_and_sde(&app)?;
    if params.query.trim().is_empty() {
        return Err("Enter an item name to search for.".into());
    }
    let matches = sde
        .search_types(&params.query, SEARCH_TYPE_CAP)
        .map_err(|e| e.to_string())?;
    if matches.is_empty() {
        return Err(format!("No item matches \"{}\".", params.query.trim()));
    }
    let matching: HashSet<i64> = matches.into_iter().map(|(id, _)| id).collect();

    /// One corp's scan: `(corp_id, corp_name, offers, fetched_at)`; `None`
    /// when the pull failed transiently.
    type CorpScan = Option<(i64, String, Vec<EsiOffer>, u64)>;

    // Walk every NPC corp's store, serving cached pulls where possible. A 404
    // means "this corp has no loyalty store" — cache that as an empty store so
    // re-scans skip it; other errors are transient, so count and retry next time.
    let corps = sde.npc_corporations().map_err(|e| e.to_string())?;
    let scans: Vec<CorpScan> = stream::iter(corps)
        .map(|(corp_id, corp_name)| {
            let esi = esi.inner().clone();
            let dir = dir.clone();
            let refresh = params.refresh;
            async move {
                match corp_offers(&esi, &dir, corp_id, refresh).await {
                    Ok((offers, fetched_at)) => Some((corp_id, corp_name, offers, fetched_at)),
                    Err(EsiError::Http(e))
                        if e.status() == Some(reqwest::StatusCode::NOT_FOUND) =>
                    {
                        let fetched_at = crate::util::time::now_secs();
                        let _ = storage::save_data(
                            &dir,
                            &format!("lp_offers_{corp_id}"),
                            &CachedOffers {
                                fetched_at,
                                offers: Vec::new(),
                            },
                        );
                        Some((corp_id, corp_name, Vec::new(), fetched_at))
                    }
                    Err(_) => None,
                }
            }
        })
        .buffer_unordered(SCAN_CONCURRENCY)
        .collect()
        .await;
    let failed_corporations = scans.iter().filter(|s| s.is_none()).count();

    // Keep only matching offers, then price their products + turn-ins at Jita.
    let hits: Vec<(i64, String, Vec<EsiOffer>)> = scans
        .iter()
        .flatten()
        .map(|(id, name, offers, _)| {
            let offers: Vec<EsiOffer> = offers
                .iter()
                .filter(|o| o.lp_cost > 0 && matching.contains(&o.type_id))
                .cloned()
                .collect();
            (*id, name.clone(), offers)
        })
        .filter(|(_, _, offers)| !offers.is_empty())
        .collect();
    let oldest_fetched_at = scans
        .iter()
        .flatten()
        .map(|(_, _, _, fetched_at)| *fetched_at)
        .min()
        .unwrap_or_else(crate::util::time::now_secs);

    let mut ids: HashSet<i64> = HashSet::new();
    for (_, _, offers) in &hits {
        for o in offers {
            ids.insert(o.type_id);
            for r in &o.required_items {
                ids.insert(r.type_id);
            }
        }
    }
    let ids: Vec<i64> = ids.into_iter().collect();
    let prices = market
        .price_map_at(jita_location(), &ids)
        .await
        .map_err(|e| e.to_string())?;
    let sell = |id: i64| prices.sell_or_zero(id);
    let names = sde.type_name_map(&ids).map_err(|e| e.to_string())?;

    let mut rows: Vec<LpSearchRow> = hits
        .into_iter()
        .flat_map(|(corp_id, corp_name, offers)| {
            offers
                .into_iter()
                .map(|o| LpSearchRow {
                    corporation_id: corp_id,
                    corporation: corp_name.clone(),
                    offer: offer_row(&o, names.get(o.type_id), &sell, params.isk_per_lp),
                })
                .collect::<Vec<_>>()
        })
        .collect();
    // Cheapest LP cost first — "who offers it for how much"; ties by best net.
    rows.sort_by(|a, b| {
        a.offer.lp_cost.cmp(&b.offer.lp_cost).then(
            b.offer
                .isk_per_lp
                .partial_cmp(&a.offer.isk_per_lp)
                .unwrap_or(std::cmp::Ordering::Equal),
        )
    });
    Ok(LpSearchResult {
        oldest_fetched_at,
        failed_corporations,
        rows,
    })
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
    use super::{offer_row, value_offer, EsiOffer, EsiRequired};

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

    #[test]
    fn offer_row_prices_turn_in_items_into_the_cost() {
        let o = EsiOffer {
            type_id: 1,
            quantity: 2,
            lp_cost: 100,
            isk_cost: 50,
            required_items: vec![EsiRequired {
                type_id: 7,
                quantity: 3,
            }],
        };
        let sell = |id: i64| if id == 1 { 1000.0 } else { 10.0 };
        let row = offer_row(&o, "Thing".into(), &sell, 1.0);
        assert_eq!(row.name, "Thing");
        // sell_value = 2 × 1000 × 0.95 = 1900.
        assert!((row.sell_value - 1900.0).abs() < 1e-6);
        // cost = 100 LP × 1.0 + 50 ISK + 3 × 10 turn-ins = 180.
        assert!((row.cost - 180.0).abs() < 1e-6);
        assert!((row.profit - 1720.0).abs() < 1e-6);
    }
}
