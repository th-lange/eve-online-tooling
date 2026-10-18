//! Public-contract deal finder — value item-exchange contracts' contents vs
//! Jita and rank by ROI. Public ESI (no auth).

use std::collections::{HashMap, HashSet};

use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::esi::EsiClient;
use crate::market::{jita_location, MarketService};

/// How many item-exchange contracts to fetch items for (each is one ESI call).
const CONTRACT_CAP: usize = 150;
const ITEM_FETCH_CONCURRENCY: usize = 12;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ContractParams {
    pub region_id: i64,
    #[serde(default)]
    pub min_roi: f64,
    /// Sales tax fraction applied to the resale (e.g. 0.045). Default 4.5%.
    #[serde(default = "default_sales_tax")]
    pub sales_tax: f64,
    /// Broker fee fraction applied to the resale (e.g. 0.03). Default 3%.
    #[serde(default = "default_broker_fee")]
    pub broker_fee: f64,
}

fn default_sales_tax() -> f64 {
    0.045
}
fn default_broker_fee() -> f64 {
    0.03
}

#[derive(Deserialize)]
struct EsiContract {
    contract_id: i64,
    #[serde(rename = "type")]
    kind: String,
    #[serde(default)]
    price: f64,
    #[serde(default)]
    title: String,
}
#[derive(Deserialize)]
struct EsiContractItem {
    type_id: i64,
    quantity: i64,
    is_included: bool,
    #[serde(default)]
    is_blueprint_copy: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContractRow {
    pub contract_id: i64,
    pub title: String,
    pub price: f64,
    /// Jita sell value of the items you'd receive (gross, before resale fees).
    pub contents_value: f64,
    /// Profit after sales tax + broker fee on the resale: `contents·(1−fees) − cost`.
    pub profit: f64,
    pub roi: f64,
    pub item_count: i64,
    /// True if any content is a BPC (unpriceable) — value is understated.
    pub has_bpc: bool,
}

/// Rank a region's public item-exchange contracts by flip ROI (contents valued
/// at Jita sell vs the contract price).
#[tauri::command]
pub async fn contracts_scan(
    market: State<'_, MarketService>,
    esi: State<'_, EsiClient>,
    params: ContractParams,
) -> Result<Vec<ContractRow>, String> {
    let esi = esi.inner().clone();

    let contracts: Vec<EsiContract> = esi
        .get_paged(
            &format!("/latest/contracts/public/{}/", params.region_id),
            &[],
        )
        .await
        .map_err(|e| e.to_string())?;

    // Item-exchange contracts with a price, capped (one item-fetch each).
    let candidates: Vec<EsiContract> = contracts
        .into_iter()
        .filter(|c| c.kind == "item_exchange" && c.price > 0.0)
        .take(CONTRACT_CAP)
        .collect();

    // Fetch each contract's items concurrently.
    let ids_to_fetch: Vec<i64> = candidates.iter().map(|c| c.contract_id).collect();
    let items: HashMap<i64, Vec<EsiContractItem>> = stream::iter(ids_to_fetch)
        .map(|id| {
            let esi = esi.clone();
            async move {
                let r: Result<Vec<EsiContractItem>, _> = esi
                    .get_json(&format!("/latest/contracts/public/items/{id}/"), &[])
                    .await;
                match r {
                    Ok(list) => Some((id, list)),
                    Err(e) => {
                        // Don't value this contract on missing data — a failed
                        // item fetch (404/500/timeout) would otherwise collapse
                        // to an empty Vec and show as a (wrong) zero-content
                        // contract rather than being excluded (#1031).
                        eprintln!(
                            "contracts_scan: item fetch failed for contract {id}: {e} — excluding it from results"
                        );
                        None
                    }
                }
            }
        })
        .buffer_unordered(ITEM_FETCH_CONCURRENCY)
        .filter_map(|x| async move { x })
        .collect::<HashMap<i64, Vec<EsiContractItem>>>()
        .await;

    // Price every referenced type at Jita.
    let mut ids: HashSet<i64> = HashSet::new();
    for list in items.values() {
        for it in list {
            ids.insert(it.type_id);
        }
    }
    let ids: Vec<i64> = ids.into_iter().collect();
    let prices = market
        .price_map_at(jita_location(), &ids)
        .await
        .map_err(|e| e.to_string())?;
    let sell = |type_id: i64| prices.sell_or_zero(type_id);

    let rows = build_rows(
        candidates,
        &items,
        &sell,
        params.sales_tax,
        params.broker_fee,
        params.min_roi,
    );
    Ok(rows)
}

/// Value and rank priced `candidates` by ROI, highest first. Contracts whose
/// item fetch failed (absent from `items`, see #1031) are excluded entirely
/// rather than valued at zero content — a missing item list is incomplete
/// data, not an empty contract, and showing a plausible-looking profit for it
/// would be actively misleading.
fn build_rows(
    candidates: Vec<EsiContract>,
    items: &HashMap<i64, Vec<EsiContractItem>>,
    sell: &impl Fn(i64) -> f64,
    sales_tax: f64,
    broker_fee: f64,
    min_roi: f64,
) -> Vec<ContractRow> {
    let mut rows: Vec<ContractRow> = candidates
        .into_iter()
        .filter_map(|c| {
            let list = items.get(&c.contract_id)?;
            let mut contents_value = 0.0;
            let mut requested = 0.0;
            let mut has_bpc = false;
            for it in list {
                if it.is_blueprint_copy {
                    has_bpc = true;
                    continue;
                }
                let v = it.quantity as f64 * sell(it.type_id);
                if it.is_included {
                    contents_value += v;
                } else {
                    requested += v;
                }
            }
            // Net the resale: you pay sales tax + broker fee to sell the items
            // you receive, so the realistic proceeds are below raw Jita sell.
            let fee_factor = (1.0 - sales_tax - broker_fee).max(0.0);
            let cost = c.price + requested;
            let (profit, roi) = flip_return(contents_value, fee_factor, cost);
            if roi < min_roi {
                return None;
            }
            Some(ContractRow {
                contract_id: c.contract_id,
                title: if c.title.is_empty() {
                    "(no title)".into()
                } else {
                    c.title
                },
                price: c.price,
                contents_value,
                profit,
                roi,
                item_count: list.len() as i64,
                has_bpc,
            })
        })
        .collect();
    rows.sort_by(|a, b| {
        b.roi
            .partial_cmp(&a.roi)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    rows
}

/// Resale return on a contract flip. Proceeds are the contents' market value
/// after sell-side fees (`fee_factor` = 1 − sales_tax − broker_fee); `cost` is
/// the contract price plus any requested (turn-in) items. Returns
/// `(profit, roi)`, with roi = 0 when there's no cost basis.
fn flip_return(contents_value: f64, fee_factor: f64, cost: f64) -> (f64, f64) {
    let profit = contents_value * fee_factor - cost;
    let roi = if cost > 0.0 { profit / cost } else { 0.0 };
    (profit, roi)
}

#[cfg(test)]
mod tests {
    use super::{build_rows, flip_return, EsiContract, EsiContractItem};
    use std::collections::HashMap;

    #[test]
    fn profit_is_fee_adjusted_contents_minus_cost() {
        // 1000 contents at a 5% total fee → 950 proceeds; cost 800 → profit 150.
        let (profit, roi) = flip_return(1000.0, 0.95, 800.0);
        assert!((profit - 150.0).abs() < 1e-6);
        assert!((roi - 150.0 / 800.0).abs() < 1e-6);
    }

    #[test]
    fn zero_cost_yields_zero_roi_not_infinity() {
        let (profit, roi) = flip_return(500.0, 1.0, 0.0);
        assert!((profit - 500.0).abs() < 1e-6);
        assert_eq!(roi, 0.0);
    }

    #[test]
    fn a_contract_with_a_failed_item_fetch_is_excluded_not_zero_valued() {
        // Contract 1's item fetch succeeded; contract 2's failed (absent from
        // `items` — simulating a 404/500/timeout during the concurrent fetch).
        let candidates = vec![
            EsiContract {
                contract_id: 1,
                kind: "item_exchange".into(),
                price: 100.0,
                title: "Good".into(),
            },
            EsiContract {
                contract_id: 2,
                kind: "item_exchange".into(),
                price: 100.0,
                title: "Broken".into(),
            },
        ];
        let mut items = HashMap::new();
        items.insert(
            1,
            vec![EsiContractItem {
                type_id: 34,
                quantity: 1000,
                is_included: true,
                is_blueprint_copy: false,
            }],
        );
        // Contract 2 intentionally has no entry in `items`.
        let sell = |_: i64| 1.0;
        let rows = build_rows(candidates, &items, &sell, 0.0, 0.0, 0.0);
        // Only the contract with a successful item fetch is valued/returned —
        // contract 2 is excluded entirely rather than shown as a zero-content,
        // misleadingly-profitable flip.
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].contract_id, 1);
    }

    #[test]
    fn fees_can_turn_a_thin_flip_negative() {
        // Contents barely above cost, but fees eat the margin.
        let (profit, _) = flip_return(1000.0, 0.90, 950.0);
        assert!(profit < 0.0);
    }
}
