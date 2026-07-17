//! Accounting module — wallet journal + market transactions (durably merged so
//! history outlives ESI's window), and a FIFO realized-profit tracker.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::esi::{authed_get_paged_pub, AuthState};
use crate::market::{jita_location, MarketService, PriceMap};
use crate::model::AppError;
use crate::storage;

fn first_character(app: &AppHandle) -> Result<i64, AppError> {
    let dir = crate::storage::app_data_dir(app)?;
    storage::primary_character(&dir).ok_or_else(AppError::auth_required)
}

// --- Stored shapes (durable, accumulated) ---

#[derive(Debug, Clone, Serialize, Deserialize)]
struct JournalEntry {
    id: i64,
    #[serde(default)]
    date: String,
    #[serde(default)]
    ref_type: String,
    #[serde(default)]
    amount: f64,
    #[serde(default)]
    balance: f64,
    #[serde(default)]
    description: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct Transaction {
    transaction_id: i64,
    #[serde(default)]
    date: String,
    type_id: i64,
    quantity: i64,
    unit_price: f64,
    is_buy: bool,
}

/// Merge new rows into the stored set, keyed by `id`; returns the merged Vec.
fn merge_by<T: Clone, F: Fn(&T) -> i64>(stored: Vec<T>, incoming: Vec<T>, key: F) -> Vec<T> {
    let mut seen: HashSet<i64> = stored.iter().map(&key).collect();
    let mut out = stored;
    for row in incoming {
        if seen.insert(key(&row)) {
            out.push(row);
        }
    }
    out
}

// --- Wallet journal + transactions (#53) ---

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PivotRow {
    pub ref_type: String,
    pub income: f64,
    pub expense: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecentEntry {
    pub date: String,
    pub ref_type: String,
    pub amount: f64,
    pub balance: f64,
    pub description: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WalletView {
    pub balance: f64,
    pub income_total: f64,
    pub expense_total: f64,
    pub entry_count: i64,
    pub transaction_count: i64,
    pub pivots: Vec<PivotRow>,
    /// The 200 most recent journal entries (with date/time).
    pub recent: Vec<RecentEntry>,
}

/// Sync the wallet journal + transactions for the first character, incrementally
/// merging into the durable store (so history accumulates beyond ESI's window),
/// and return an income/expense summary pivoted by ref type.
#[tauri::command]
pub async fn wallet_sync(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
) -> Result<WalletView, AppError> {
    let character_id = first_character(&app)?;
    let dir = crate::storage::app_data_dir(&app)?;
    let jkey = format!("journal_{character_id}");
    let tkey = format!("transactions_{character_id}");

    let new_journal: Vec<JournalEntry> = authed_get_paged_pub(
        &auth_state,
        character_id,
        &format!("/latest/characters/{character_id}/wallet/journal/"),
    )
    .await
    .map_err(|e| e.to_string())?;
    let new_tx: Vec<Transaction> = authed_get_paged_pub(
        &auth_state,
        character_id,
        &format!("/latest/characters/{character_id}/wallet/transactions/"),
    )
    .await
    .map_err(|e| e.to_string())?;

    let journal = merge_by(
        storage::load_data(&dir, &jkey).unwrap_or_default(),
        new_journal,
        |e: &JournalEntry| e.id,
    );
    let transactions = merge_by(
        storage::load_data(&dir, &tkey).unwrap_or_default(),
        new_tx,
        |t: &Transaction| t.transaction_id,
    );
    let _ = storage::save_data(&dir, &jkey, &journal);
    let _ = storage::save_data(&dir, &tkey, &transactions);

    // Latest balance (entries aren't guaranteed sorted; take max date).
    let balance = journal
        .iter()
        .max_by(|a, b| a.date.cmp(&b.date))
        .map(|e| e.balance)
        .unwrap_or(0.0);
    let mut pivot: HashMap<String, (f64, f64)> = HashMap::new();
    let (mut income_total, mut expense_total) = (0.0, 0.0);
    for e in &journal {
        let slot = pivot.entry(e.ref_type.clone()).or_default();
        if e.amount >= 0.0 {
            slot.0 += e.amount;
            income_total += e.amount;
        } else {
            slot.1 += -e.amount;
            expense_total += -e.amount;
        }
    }
    let mut pivots: Vec<PivotRow> = pivot
        .into_iter()
        .map(|(ref_type, (income, expense))| PivotRow {
            ref_type,
            income,
            expense,
        })
        .collect();
    pivots.sort_by(|a, b| {
        (b.income + b.expense)
            .partial_cmp(&(a.income + a.expense))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // Most recent entries (newest first), with date/time.
    let mut sorted = journal.clone();
    sorted.sort_by(|a, b| b.date.cmp(&a.date));
    let recent = sorted
        .into_iter()
        .take(200)
        .map(|e| RecentEntry {
            date: e.date,
            ref_type: e.ref_type,
            amount: e.amount,
            balance: e.balance,
            description: e.description,
        })
        .collect();

    Ok(WalletView {
        balance,
        income_total,
        expense_total,
        entry_count: journal.len() as i64,
        transaction_count: transactions.len() as i64,
        pivots,
        recent,
    })
}

// --- Transaction ledger (per-fill buy/sell history) ---

/// One market transaction (a single buy or sell fill) for display.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerRow {
    pub date: String,
    pub name: String,
    pub type_id: i64,
    pub is_buy: bool,
    pub quantity: i64,
    pub unit_price: f64,
    /// quantity × unit price (ISK moved on this fill).
    pub total: f64,
}

/// The transaction ledger: buy/sell fills (newest first) plus running totals.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LedgerView {
    pub rows: Vec<LedgerRow>,
    pub total_buy: f64,
    pub total_sell: f64,
}

/// Per-fill market transaction history for the active character. Refreshes from
/// ESI and merges into the same durable store used by `wallet_sync`/`profit_fifo`
/// (so the ledger stays current even if the Accounting page is never opened),
/// then resolves item names via the SDE. Rows are newest-first.
#[tauri::command]
pub async fn transaction_ledger(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
) -> Result<LedgerView, AppError> {
    let character_id = first_character(&app)?;
    let (dir, sde) = crate::sde::dir_and_sde(&app)?;
    let tkey = format!("transactions_{character_id}");

    let new_tx: Vec<Transaction> = authed_get_paged_pub(
        &auth_state,
        character_id,
        &format!("/latest/characters/{character_id}/wallet/transactions/"),
    )
    .await
    .map_err(|e| e.to_string())?;
    let transactions = merge_by(
        storage::load_data(&dir, &tkey).unwrap_or_default(),
        new_tx,
        |t: &Transaction| t.transaction_id,
    );
    let _ = storage::save_data(&dir, &tkey, &transactions);

    // Resolve item names from the SDE in one batch.
    let type_ids: Vec<i64> = transactions.iter().map(|t| t.type_id).collect();
    let names: HashMap<i64, String> = sde
        .type_names(&type_ids)
        .map_err(|e| e.to_string())?
        .into_iter()
        .collect();

    let (mut total_buy, mut total_sell) = (0.0, 0.0);
    let mut rows: Vec<LedgerRow> = transactions
        .iter()
        .map(|t| {
            let total = t.quantity as f64 * t.unit_price;
            if t.is_buy {
                total_buy += total;
            } else {
                total_sell += total;
            }
            LedgerRow {
                date: t.date.clone(),
                name: names
                    .get(&t.type_id)
                    .cloned()
                    .unwrap_or_else(|| format!("Type {}", t.type_id)),
                type_id: t.type_id,
                is_buy: t.is_buy,
                quantity: t.quantity,
                unit_price: t.unit_price,
                total,
            }
        })
        .collect();
    rows.sort_by(|a, b| b.date.cmp(&a.date));

    Ok(LedgerView {
        rows,
        total_buy,
        total_sell,
    })
}

// --- FIFO profit tracker (#54) ---

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProfitRow {
    pub name: String,
    pub units_sold: i64,
    pub revenue: f64,
    pub cost: f64,
    pub profit: f64,
    /// Units sold without a matching buy in the data (cost basis 0).
    pub unmatched_units: i64,
    /// Date of the most recent sale of this type.
    pub last_sold: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfitView {
    pub rows: Vec<ProfitRow>,
    pub total_profit: f64,
}

/// One acquisition (buy or built) or disposal (sell), unified for the FIFO pass.
#[derive(Debug, Clone)]
struct FifoEvent {
    date: String,
    type_id: i64,
    qty: i64,
    /// Acquisitions carry a unit cost; disposals carry a unit sale price.
    unit_value: f64,
    acquire: bool,
}

/// Pure FIFO over date-sorted events: acquisitions push lots, disposals consume
/// the oldest lots and realize profit (unmatched = zero cost, flagged).
fn run_fifo(mut events: Vec<FifoEvent>) -> (HashMap<i64, ProfitRow>, f64) {
    // Date order; on a tie, acquisitions before disposals (build-then-sell same day).
    events.sort_by(|a, b| a.date.cmp(&b.date).then(b.acquire.cmp(&a.acquire)));

    let mut lots: HashMap<i64, std::collections::VecDeque<(i64, f64)>> = HashMap::new();
    let mut agg: HashMap<i64, ProfitRow> = HashMap::new();
    let mut total_profit = 0.0;

    for e in &events {
        if e.acquire {
            lots.entry(e.type_id)
                .or_default()
                .push_back((e.qty, e.unit_value));
            continue;
        }
        let row = agg.entry(e.type_id).or_default();
        let revenue = e.unit_value * e.qty as f64;
        row.units_sold += e.qty;
        row.revenue += revenue;
        row.last_sold = e.date.clone();
        let queue = lots.entry(e.type_id).or_default();
        let mut need = e.qty;
        let mut cost = 0.0;
        while need > 0 {
            match queue.front_mut() {
                Some((lot_qty, lot_cost)) => {
                    let take = need.min(*lot_qty);
                    cost += take as f64 * *lot_cost;
                    *lot_qty -= take;
                    need -= take;
                    if *lot_qty == 0 {
                        queue.pop_front();
                    }
                }
                None => {
                    row.unmatched_units += need;
                    need = 0;
                }
            }
        }
        row.cost += cost;
        let realized = revenue - cost;
        row.profit += realized;
        total_profit += realized;
    }
    (agg, total_profit)
}

/// A delivered manufacturing job, valued as an acquisition lot.
#[derive(Debug, Clone, Deserialize)]
struct StoredJobLite {
    activity_id: i64,
    blueprint_type_id: i64,
    #[serde(default)]
    product_type_id: Option<i64>,
    runs: i64,
    #[serde(default)]
    cost: Option<f64>,
    #[serde(default)]
    status: String,
    #[serde(default)]
    end_date: String,
}

/// FIFO realized profit across **buys and builds**: market buys and delivered
/// manufacturing jobs both supply cost basis; sells realize profit. Built units
/// are valued at current Jita material price + the job's install fee (an
/// estimate — current prices, ME not applied, so cost is a slight overestimate /
/// profit a slight underestimate). Unmatched sells get zero cost and are flagged.
#[tauri::command]
pub async fn profit_fifo(
    app: AppHandle,
    market: State<'_, MarketService>,
) -> Result<ProfitView, AppError> {
    let character_id = first_character(&app)?;
    let (dir, sde) = crate::sde::dir_and_sde(&app)?;

    let transactions: Vec<Transaction> =
        storage::load_data(&dir, &format!("transactions_{character_id}")).unwrap_or_default();

    // Delivered manufacturing jobs become acquisition lots (build cost basis).
    let jobs: Vec<StoredJobLite> =
        storage::load_data(&dir, &format!("industry_jobs_{character_id}")).unwrap_or_default();
    let delivered: Vec<&StoredJobLite> = jobs
        .iter()
        .filter(|j| j.activity_id == 1 && j.status == "delivered")
        .collect();

    // Price every material referenced by a delivered job at Jita (one pull).
    let mut mat_ids: HashSet<i64> = HashSet::new();
    for j in &delivered {
        if let Ok(mats) = sde.blueprint_materials(j.blueprint_type_id) {
            for m in mats {
                mat_ids.insert(m.material_type_id);
            }
        }
    }
    let prices = if mat_ids.is_empty() {
        PriceMap::default()
    } else {
        let ids: Vec<i64> = mat_ids.into_iter().collect();
        market
            .price_map_at(jita_location(), &ids)
            .await
            .map_err(|e| e.to_string())?
    };
    let mat_price = |id: i64| prices.sell_or_zero(id);

    // Build the unified event stream.
    let mut events: Vec<FifoEvent> = Vec::new();
    for t in &transactions {
        events.push(FifoEvent {
            date: t.date.clone(),
            type_id: t.type_id,
            qty: t.quantity,
            unit_value: t.unit_price,
            acquire: t.is_buy,
        });
    }
    for j in &delivered {
        let Some(product) = sde.blueprint_product(j.blueprint_type_id).ok().flatten() else {
            continue;
        };
        let output_units = product.quantity * j.runs;
        if output_units <= 0 {
            continue;
        }
        let materials = sde
            .blueprint_materials(j.blueprint_type_id)
            .unwrap_or_default();
        // Materials at base quantity × runs (ME not applied — documented estimate).
        let material_cost: f64 = materials
            .iter()
            .map(|m| (m.quantity * j.runs) as f64 * mat_price(m.material_type_id))
            .sum();
        let total_cost = material_cost + j.cost.unwrap_or(0.0);
        events.push(FifoEvent {
            date: j.end_date.clone(),
            type_id: j.product_type_id.unwrap_or(product.product_type_id),
            qty: output_units,
            unit_value: total_cost / output_units as f64,
            acquire: true,
        });
    }

    let (agg, total_profit) = run_fifo(events);

    let mut rows: Vec<ProfitRow> = agg
        .into_iter()
        .map(|(type_id, mut row)| {
            row.name = sde
                .type_info(type_id)
                .ok()
                .flatten()
                .map(|t| t.name)
                .unwrap_or_else(|| format!("Type {type_id}"));
            row
        })
        .collect();
    rows.sort_by(|a, b| {
        b.profit
            .partial_cmp(&a.profit)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    Ok(ProfitView { rows, total_profit })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ev(date: &str, type_id: i64, qty: i64, value: f64, acquire: bool) -> FifoEvent {
        FifoEvent {
            date: date.into(),
            type_id,
            qty,
            unit_value: value,
            acquire,
        }
    }

    #[test]
    fn builds_supply_cost_basis_alongside_buys() {
        // Build 10 of type 1 @ cost 50 (acquire), then sell 10 @ 100 → profit 500.
        let (agg, total) = run_fifo(vec![
            ev("2026-01-01", 1, 10, 50.0, true),
            ev("2026-01-02", 1, 10, 100.0, false),
        ]);
        assert_eq!(total, 500.0);
        let row = &agg[&1];
        assert_eq!(row.units_sold, 10);
        assert_eq!(row.cost, 500.0);
        assert_eq!(row.unmatched_units, 0);
    }

    #[test]
    fn same_day_build_then_sell_is_matched() {
        // Acquisition sorts before disposal on the same date.
        let (agg, _) = run_fifo(vec![
            ev("2026-01-01", 1, 5, 20.0, false), // sell listed first…
            ev("2026-01-01", 1, 5, 8.0, true),   // …but built same day
        ]);
        assert_eq!(agg[&1].unmatched_units, 0);
        assert_eq!(agg[&1].cost, 40.0);
    }

    #[test]
    fn unmatched_sell_flagged_zero_cost() {
        let (agg, total) = run_fifo(vec![ev("2026-01-01", 1, 3, 100.0, false)]);
        assert_eq!(agg[&1].unmatched_units, 3);
        assert_eq!(agg[&1].cost, 0.0);
        assert_eq!(total, 300.0);
    }
}
