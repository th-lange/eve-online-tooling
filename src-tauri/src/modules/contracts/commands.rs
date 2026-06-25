//! Public-contract deal finder — value item-exchange contracts' contents vs
//! Jita and rank by ROI. Public ESI (no auth).

use std::collections::{HashMap, HashSet};

use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::esi::EsiClient;
use crate::market::{resolve_location, MarketService, PriceModel};

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
    params: ContractParams,
) -> Result<Vec<ContractRow>, String> {
    let esi = EsiClient::new();

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
                (id, r.unwrap_or_default())
            }
        })
        .buffer_unordered(ITEM_FETCH_CONCURRENCY)
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
    let prices: HashMap<i64, PriceModel> = market
        .price_models_at(resolve_location(10_000_002, None), &ids)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|m| (m.type_id, m))
        .collect();
    let sell = |type_id: i64| prices.get(&type_id).and_then(|m| m.sell_percentile).unwrap_or(0.0);

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
            let fee_factor = (1.0 - params.sales_tax - params.broker_fee).max(0.0);
            let proceeds = contents_value * fee_factor;
            let cost = c.price + requested;
            let profit = proceeds - cost;
            let roi = if cost > 0.0 { profit / cost } else { 0.0 };
            if roi < params.min_roi {
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
    rows.sort_by(|a, b| b.roi.partial_cmp(&a.roi).unwrap_or(std::cmp::Ordering::Equal));
    Ok(rows)
}
