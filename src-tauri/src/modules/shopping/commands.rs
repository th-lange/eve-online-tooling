//! Tauri commands backing the Shopping Lists module.
//!
//! The whole feature is one JSON document (`shopping_lists`) holding every list
//! and its items. Items are stored as `(type_id, quantity)`; display names are
//! resolved from the SDE only when read out, so they stay correct across SDE
//! updates (same approach as [`crate::lists`]).

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::sde::{Sde, SdePaths};
use crate::storage;

/// Storage document name (a JSON file in `<app data>/data/`).
const STORE_KEY: &str = "shopping_lists";

/// Built-in lists the UI seeds and the user can't delete.
const BUILTIN: [(&str, &str); 2] = [("default", "Default"), ("production", "Production")];

// --- Stored shape -----------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct Store {
    lists: Vec<StoredList>,
    /// Progress marker for the chat-capture listener (see `shopping_chat_sync`).
    #[serde(default)]
    chat: ChatState,
}

/// Where the chat listener left off, so we only ingest new messages.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ChatState {
    channel: String,
    /// The chatlog file currently being followed.
    file: String,
    /// Number of message lines already processed from `file`.
    count: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredList {
    id: String,
    name: String,
    #[serde(default)]
    items: Vec<StoredEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredEntry {
    #[serde(rename = "typeId", alias = "type_id")]
    type_id: i64,
    quantity: i64,
}

// --- Resolved shape returned to the frontend --------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShoppingItem {
    pub type_id: i64,
    pub name: String,
    pub quantity: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShoppingList {
    pub id: String,
    pub name: String,
    /// Built-in lists (`default`, `production`) can't be deleted.
    pub removable: bool,
    pub items: Vec<ShoppingItem>,
}

// --- Store helpers ----------------------------------------------------------

fn is_builtin(id: &str) -> bool {
    BUILTIN.iter().any(|(bid, _)| *bid == id)
}

/// Load the store, guaranteeing the two built-in lists exist (prepended in a
/// stable order) so a fresh install / corrupt file still yields them.
fn load(dir: &std::path::Path) -> Store {
    let mut store: Store = storage::load_data(dir, STORE_KEY).unwrap_or_default();
    for (idx, (id, name)) in BUILTIN.iter().enumerate() {
        if !store.lists.iter().any(|l| l.id == *id) {
            store.lists.insert(
                idx.min(store.lists.len()),
                StoredList {
                    id: (*id).to_string(),
                    name: (*name).to_string(),
                    items: Vec::new(),
                },
            );
        }
    }
    store
}

fn save(dir: &std::path::Path, store: &Store) -> Result<(), String> {
    storage::save_data(dir, STORE_KEY, store)
}

fn list_mut<'a>(store: &'a mut Store, id: &str) -> Result<&'a mut StoredList, String> {
    store
        .lists
        .iter_mut()
        .find(|l| l.id == id)
        .ok_or_else(|| format!("no such list: {id}"))
}

/// Resolve a stored list's item names from the SDE.
fn resolve(sde: &Sde, list: &StoredList) -> ShoppingList {
    let items = list
        .items
        .iter()
        .map(|e| {
            let name = sde
                .type_info(e.type_id)
                .ok()
                .flatten()
                .map(|t| t.name)
                .unwrap_or_else(|| format!("Type {}", e.type_id));
            ShoppingItem {
                type_id: e.type_id,
                name,
                quantity: e.quantity,
            }
        })
        .collect();
    ShoppingList {
        id: list.id.clone(),
        name: list.name.clone(),
        removable: !is_builtin(&list.id),
        items,
    }
}

fn dir_and_sde(app: &AppHandle) -> Result<(std::path::PathBuf, Sde), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let sde = Sde::open(&SdePaths::new(dir.clone()).db).map_err(|e| e.to_string())?;
    Ok((dir, sde))
}

// --- Commands ---------------------------------------------------------------

/// Every shopping list with its items (names resolved from the SDE).
#[tauri::command]
pub fn shopping_lists(app: AppHandle) -> Result<Vec<ShoppingList>, String> {
    let (dir, sde) = dir_and_sde(&app)?;
    let store = load(&dir);
    Ok(store.lists.iter().map(|l| resolve(&sde, l)).collect())
}

/// Create a new (removable) list from a display name, returning the resolved
/// list. The id is a slug of the name, de-duplicated with a numeric suffix.
#[tauri::command]
pub fn shopping_create_list(app: AppHandle, name: String) -> Result<ShoppingList, String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("list name can't be empty".into());
    }
    let (dir, sde) = dir_and_sde(&app)?;
    let mut store = load(&dir);

    let base: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_alphanumeric() { c } else { '-' })
        .collect();
    let base = base.trim_matches('-').to_string();
    let base = if base.is_empty() {
        "list".to_string()
    } else {
        base
    };
    let mut id = base.clone();
    let mut n = 2;
    while store.lists.iter().any(|l| l.id == id) {
        id = format!("{base}-{n}");
        n += 1;
    }

    let list = StoredList {
        id,
        name,
        items: Vec::new(),
    };
    store.lists.push(list.clone());
    save(&dir, &store)?;
    Ok(resolve(&sde, &list))
}

/// Rename a list (built-in lists included).
#[tauri::command]
pub fn shopping_rename_list(app: AppHandle, id: String, name: String) -> Result<(), String> {
    let name = name.trim().to_string();
    if name.is_empty() {
        return Err("list name can't be empty".into());
    }
    let (dir, _sde) = dir_and_sde(&app)?;
    let mut store = load(&dir);
    list_mut(&mut store, &id)?.name = name;
    save(&dir, &store)
}

/// Delete a list. Refuses the built-in `default` / `production` lists.
#[tauri::command]
pub fn shopping_delete_list(app: AppHandle, id: String) -> Result<(), String> {
    if is_builtin(&id) {
        return Err("the default and production lists can't be removed".into());
    }
    let (dir, _sde) = dir_and_sde(&app)?;
    let mut store = load(&dir);
    store.lists.retain(|l| l.id != id);
    save(&dir, &store)
}

/// Add `quantity` of a type to a list. If the item is already present its
/// quantity is increased (this is how the per-module "add to list" buttons
/// accumulate). `quantity` defaults to 1 when non-positive.
#[tauri::command]
pub fn shopping_add_item(
    app: AppHandle,
    id: String,
    type_id: i64,
    quantity: Option<i64>,
) -> Result<(), String> {
    let qty = quantity.filter(|q| *q > 0).unwrap_or(1);
    let (dir, _sde) = dir_and_sde(&app)?;
    let mut store = load(&dir);
    let list = list_mut(&mut store, &id)?;
    match list.items.iter_mut().find(|e| e.type_id == type_id) {
        Some(entry) => entry.quantity += qty,
        None => list.items.push(StoredEntry {
            type_id,
            quantity: qty,
        }),
    }
    save(&dir, &store)
}

/// One pasted line: an item name and a quantity (defaults to 1).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TextItem {
    pub name: String,
    #[serde(default = "one")]
    pub quantity: i64,
}
fn one() -> i64 {
    1
}

/// Bulk-add pasted lines (in-game **Multibuy** style — `name` or
/// `name<TAB>quantity` per line). Each name is resolved to a type via the SDE
/// (exact match, like the appraisal tool); resolved items are added — quantities
/// accumulating — and the names that couldn't be resolved are returned so the UI
/// can flag them.
#[tauri::command]
pub fn shopping_add_text(
    app: AppHandle,
    id: String,
    items: Vec<TextItem>,
) -> Result<Vec<String>, String> {
    let (dir, sde) = dir_and_sde(&app)?;
    let mut store = load(&dir);
    let mut unresolved = Vec::new();
    {
        let list = list_mut(&mut store, &id)?;
        for item in &items {
            let name = item.name.trim();
            if name.is_empty() {
                continue;
            }
            let qty = item.quantity.max(1);
            match sde.type_by_name(name).map_err(|e| e.to_string())? {
                Some((type_id, _)) => match list.items.iter_mut().find(|e| e.type_id == type_id) {
                    Some(entry) => entry.quantity += qty,
                    None => list.items.push(StoredEntry {
                        type_id,
                        quantity: qty,
                    }),
                },
                None => unresolved.push(item.name.clone()),
            }
        }
    }
    save(&dir, &store)?;
    Ok(unresolved)
}

/// Set the exact quantity of an item. A quantity ≤ 0 removes it from the list.
#[tauri::command]
pub fn shopping_set_quantity(
    app: AppHandle,
    id: String,
    type_id: i64,
    quantity: i64,
) -> Result<(), String> {
    let (dir, _sde) = dir_and_sde(&app)?;
    let mut store = load(&dir);
    let list = list_mut(&mut store, &id)?;
    if quantity <= 0 {
        list.items.retain(|e| e.type_id != type_id);
    } else if let Some(entry) = list.items.iter_mut().find(|e| e.type_id == type_id) {
        entry.quantity = quantity;
    } else {
        list.items.push(StoredEntry { type_id, quantity });
    }
    save(&dir, &store)
}

/// Remove an item from a list (no-op if absent).
#[tauri::command]
pub fn shopping_remove_item(app: AppHandle, id: String, type_id: i64) -> Result<(), String> {
    let (dir, _sde) = dir_and_sde(&app)?;
    let mut store = load(&dir);
    list_mut(&mut store, &id)?
        .items
        .retain(|e| e.type_id != type_id);
    save(&dir, &store)
}

/// Empty a list of all its items (keeps the list itself).
#[tauri::command]
pub fn shopping_clear_list(app: AppHandle, id: String) -> Result<(), String> {
    let (dir, _sde) = dir_and_sde(&app)?;
    let mut store = load(&dir);
    list_mut(&mut store, &id)?.items.clear();
    save(&dir, &store)
}

/// Move an item between lists. Moves `quantity` if given (capped to what's
/// there), otherwise the whole entry. Quantities accumulate on the target;
/// the source entry is removed once it hits zero. No-op if `from == to`.
#[tauri::command]
pub fn shopping_move_item(
    app: AppHandle,
    from_id: String,
    to_id: String,
    type_id: i64,
    quantity: Option<i64>,
) -> Result<(), String> {
    if from_id == to_id {
        return Ok(());
    }
    let (dir, _sde) = dir_and_sde(&app)?;
    let mut store = load(&dir);

    // Take from the source.
    let moved;
    {
        let src = list_mut(&mut store, &from_id)?;
        let avail = src
            .items
            .iter()
            .find(|e| e.type_id == type_id)
            .map(|e| e.quantity)
            .unwrap_or(0);
        if avail <= 0 {
            return Ok(());
        }
        moved = quantity.filter(|q| *q > 0).unwrap_or(avail).min(avail);
        if let Some(e) = src.items.iter_mut().find(|e| e.type_id == type_id) {
            e.quantity -= moved;
        }
        src.items.retain(|e| e.quantity > 0);
    }
    // Give to the target.
    {
        let dst = list_mut(&mut store, &to_id)?;
        match dst.items.iter_mut().find(|e| e.type_id == type_id) {
            Some(e) => e.quantity += moved,
            None => dst.items.push(StoredEntry {
                type_id,
                quantity: moved,
            }),
        }
    }
    save(&dir, &store)
}

// --- Chat capture -----------------------------------------------------------

/// Built-in id/name for the list the chat listener fills.
const CHAT_LIST: (&str, &str) = ("chat", "Chat");

/// Read an EVE chatlog, decoding the UTF-16LE (BOM) it writes, else UTF-8.
fn read_chatlog(path: &std::path::Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        let u16s: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        Some(String::from_utf16_lossy(&u16s))
    } else {
        Some(String::from_utf8_lossy(&bytes).into_owned())
    }
}

/// The message text of each chat line, in order. Lines look like
/// `[ 2026.06.25 12:00:00 ] Sender > text`; system lines are skipped.
fn parse_chat_messages(content: &str) -> Vec<String> {
    content
        .lines()
        .filter_map(|line| {
            let (_, after) = line.split_once("] ")?;
            let (sender, msg) = after.split_once(" > ")?;
            if sender.trim() == "EVE System" {
                return None;
            }
            let m = msg.trim();
            (!m.is_empty()).then(|| m.to_string())
        })
        .collect()
}

/// Result of a chat-capture poll.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatSync {
    /// Item names newly added to the Chat list this poll.
    pub added: Vec<String>,
    /// The chatlog file being followed (empty if none matched the channel).
    pub file: String,
    /// Whether a matching chatlog file was found.
    pub found: bool,
}

/// Follow an EVE chat channel's log and add any linked/typed items to the Chat
/// list. Finds the newest `<channel>_*.txt` in `logs_dir`, ingests messages it
/// hasn't seen yet (tracked per file), and resolves each as an item name via the
/// SDE — non-item chatter is ignored. Poll this every few seconds while
/// listening. Public — chat capture needs no login.
#[tauri::command]
pub fn shopping_chat_sync(
    app: AppHandle,
    logs_dir: String,
    channel: String,
    from_now: Option<bool>,
) -> Result<ChatSync, String> {
    let (dir, sde) = dir_and_sde(&app)?;
    let chan = channel.trim();
    if chan.is_empty() {
        return Err("channel name is empty".into());
    }

    // Newest chatlog whose name starts with "<channel>_" (EVE appends
    // _<date>_<time>_<charId>.txt), by modified time.
    let logs = std::path::Path::new(&logs_dir);
    let prefix = format!("{}_", chan.to_ascii_lowercase());
    let newest = std::fs::read_dir(logs)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .to_ascii_lowercase()
                .starts_with(&prefix)
        })
        .filter_map(|e| Some((e.path(), e.metadata().ok()?.modified().ok()?)))
        .max_by_key(|(_, m)| *m);

    let mut store = load(&dir);
    // Ensure the Chat list exists.
    if !store.lists.iter().any(|l| l.id == CHAT_LIST.0) {
        store.lists.push(StoredList {
            id: CHAT_LIST.0.to_string(),
            name: CHAT_LIST.1.to_string(),
            items: Vec::new(),
        });
    }

    let Some((path, _)) = newest else {
        // Remember the channel even if no file yet, so the UI can show it.
        store.chat.channel = chan.to_string();
        save(&dir, &store)?;
        return Ok(ChatSync {
            added: Vec::new(),
            file: String::new(),
            found: false,
        });
    };
    let file_name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let msgs = parse_chat_messages(&read_chatlog(&path).unwrap_or_default());

    // `from_now` (sent on Start) marks everything already in the log as seen and
    // adds nothing, so we only capture messages linked from here on — important
    // for busy channels like Corp that already hold the whole day's chatter.
    if from_now == Some(true) {
        store.chat = ChatState {
            channel: chan.to_string(),
            file: file_name.clone(),
            count: msgs.len(),
        };
        save(&dir, &store)?;
        return Ok(ChatSync {
            added: Vec::new(),
            file: file_name,
            found: true,
        });
    }

    // Resume where we left off if it's the same channel + file; else start fresh.
    let start = if store.chat.channel == chan && store.chat.file == file_name {
        store.chat.count.min(msgs.len())
    } else {
        0
    };

    let mut added = Vec::new();
    {
        // Find (or create above) the chat list and append resolved items.
        let list = store
            .lists
            .iter_mut()
            .find(|l| l.id == CHAT_LIST.0)
            .expect("chat list ensured above");
        for m in msgs.iter().skip(start) {
            if let Some((type_id, _)) = sde.type_by_name(m).map_err(|e| e.to_string())? {
                match list.items.iter_mut().find(|e| e.type_id == type_id) {
                    Some(e) => e.quantity += 1,
                    None => list.items.push(StoredEntry {
                        type_id,
                        quantity: 1,
                    }),
                }
                added.push(m.clone());
            }
        }
    }
    store.chat = ChatState {
        channel: chan.to_string(),
        file: file_name.clone(),
        count: msgs.len(),
    };
    save(&dir, &store)?;
    Ok(ChatSync {
        added,
        file: file_name,
        found: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_item_messages_and_skips_system_lines() {
        let log = "\
[ 2026.06.25 12:00:00 ] EVE System > Channel MOTD: hi
[ 2026.06.25 12:00:05 ] Buyer Pilot > Tritanium
[ 2026.06.25 12:00:06 ] Buyer Pilot > Pyerite
[ 2026.06.25 12:00:07 ] Buyer Pilot >   ";
        assert_eq!(parse_chat_messages(log), vec!["Tritanium", "Pyerite"]);
    }
}
