//! Accounting module — wallet journal + market transactions (durably merged so
//! history outlives ESI's window), and a FIFO realized-profit tracker.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::esi::{authed_get_paged_pub, AuthState};
use crate::sde::{Sde, SdePaths};
use crate::storage;

fn first_character(app: &AppHandle) -> Result<i64, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    storage::load_roster(&dir)
        .into_iter()
        .next()
        .map(|c| c.character_id)
        .ok_or_else(|| "Log in a character first".to_string())
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
pub struct WalletView {
    pub balance: f64,
    pub income_total: f64,
    pub expense_total: f64,
    pub entry_count: i64,
    pub transaction_count: i64,
    pub pivots: Vec<PivotRow>,
}

/// Sync the wallet journal + transactions for the first character, incrementally
/// merging into the durable store (so history accumulates beyond ESI's window),
/// and return an income/expense summary pivoted by ref type.
#[tauri::command]
pub async fn wallet_sync(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
) -> Result<WalletView, String> {
    let character_id = first_character(&app)?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
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

    Ok(WalletView {
        balance,
        income_total,
        expense_total,
        entry_count: journal.len() as i64,
        transaction_count: transactions.len() as i64,
        pivots,
    })
}

// --- FIFO profit tracker (#54) ---

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfitRow {
    pub name: String,
    pub units_sold: i64,
    pub revenue: f64,
    pub cost: f64,
    pub profit: f64,
    /// Units sold without a matching buy in the data (cost basis 0).
    pub unmatched_units: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfitView {
    pub rows: Vec<ProfitRow>,
    pub total_profit: f64,
}

/// FIFO realized profit from the stored market transactions: each sale consumes
/// the oldest unconsumed buy lots of that type. Unmatched sales (bought before
/// tracking, or looted) get a zero cost basis and are flagged.
#[tauri::command]
pub fn profit_fifo(app: AppHandle) -> Result<ProfitView, String> {
    let character_id = first_character(&app)?;
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let sde = Sde::open(&SdePaths::new(dir.clone()).db).map_err(|e| e.to_string())?;
    let mut transactions: Vec<Transaction> =
        storage::load_data(&dir, &format!("transactions_{character_id}")).unwrap_or_default();
    transactions.sort_by(|a, b| a.date.cmp(&b.date));

    // Per type: a FIFO queue of buy lots (qty, unit cost).
    let mut lots: HashMap<i64, std::collections::VecDeque<(i64, f64)>> = HashMap::new();
    let mut agg: HashMap<i64, ProfitRow> = HashMap::new();
    let mut total_profit = 0.0;

    for t in &transactions {
        if t.is_buy {
            lots.entry(t.type_id)
                .or_default()
                .push_back((t.quantity, t.unit_price));
        } else {
            let row = agg.entry(t.type_id).or_insert_with(|| ProfitRow {
                name: String::new(),
                units_sold: 0,
                revenue: 0.0,
                cost: 0.0,
                profit: 0.0,
                unmatched_units: 0,
            });
            let revenue = t.unit_price * t.quantity as f64;
            row.units_sold += t.quantity;
            row.revenue += revenue;
            // Consume buy lots FIFO.
            let queue = lots.entry(t.type_id).or_default();
            let mut need = t.quantity;
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
    }

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
    rows.sort_by(|a, b| b.profit.partial_cmp(&a.profit).unwrap_or(std::cmp::Ordering::Equal));

    Ok(ProfitView {
        rows,
        total_profit,
    })
}
