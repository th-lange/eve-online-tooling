//! Tauri commands backing the Shopping Lists module.
//!
//! The whole feature is one JSON document (`shopping_lists`) holding every list
//! and its items. Items are stored as `(type_id, quantity)`; display names are
//! resolved from the SDE only when read out, so they stay correct across SDE
//! updates (same approach as [`crate::lists`]).

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::sde::Sde;
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
///
/// EVE writes a *separate* log file per client/session for a channel (and
/// rotates them daily), so a multiboxer or anyone who reopens the channel ends
/// up with several `<channel>_*` files receiving messages at once. We therefore
/// follow *every* recent file for the channel and track our progress per file.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ChatState {
    channel: String,
    /// Keys (`[ ts ] Sender`) of messages already ingested, so the same channel
    /// message logged by several of the user's clients is imported only once,
    /// and re-polls don't re-add it. Pruned to the current window each poll.
    #[serde(default)]
    seen: std::collections::BTreeSet<String>,
    /// Cooldown guard for chat capture: last-accepted message time (unix secs)
    /// per `sender \u{1f} type_id`, so the same sender re-posting the same item
    /// within `CHAT_DEDUP_COOLDOWN_SECS` is dropped as a duplicate. Persisted so
    /// the window spans polls; pruned to the follow window and cleared on a
    /// channel change.
    #[serde(default)]
    cooldown: std::collections::BTreeMap<String, i64>,
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
    let ids: Vec<i64> = list.items.iter().map(|e| e.type_id).collect();
    let names = sde.type_name_map(&ids).unwrap_or_default();
    let items = list
        .items
        .iter()
        .map(|e| ShoppingItem {
            type_id: e.type_id,
            name: names.get(e.type_id),
            quantity: e.quantity,
        })
        .collect();
    ShoppingList {
        id: list.id.clone(),
        name: list.name.clone(),
        removable: !is_builtin(&list.id),
        items,
    }
}

// --- Commands ---------------------------------------------------------------

/// Every shopping list with its items (names resolved from the SDE).
#[tauri::command]
pub fn shopping_lists(app: AppHandle) -> Result<Vec<ShoppingList>, String> {
    let (dir, sde) = crate::sde::dir_and_sde(&app)?;
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
    let (dir, sde) = crate::sde::dir_and_sde(&app)?;
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
    let (dir, _sde) = crate::sde::dir_and_sde(&app)?;
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
    let (dir, _sde) = crate::sde::dir_and_sde(&app)?;
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
    let (dir, _sde) = crate::sde::dir_and_sde(&app)?;
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
    let (dir, sde) = crate::sde::dir_and_sde(&app)?;
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
    let (dir, _sde) = crate::sde::dir_and_sde(&app)?;
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
    let (dir, _sde) = crate::sde::dir_and_sde(&app)?;
    let mut store = load(&dir);
    list_mut(&mut store, &id)?
        .items
        .retain(|e| e.type_id != type_id);
    save(&dir, &store)
}

/// Empty a list of all its items (keeps the list itself).
#[tauri::command]
pub fn shopping_clear_list(app: AppHandle, id: String) -> Result<(), String> {
    let (dir, _sde) = crate::sde::dir_and_sde(&app)?;
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
    let (dir, _sde) = crate::sde::dir_and_sde(&app)?;
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

/// Most lines we ingest from a single chat message (bounds hostile pastes).
const MAX_LINES_PER_MESSAGE: usize = 100;
/// Longest item name we try to resolve (no EVE type name comes close).
const MAX_NAME_LEN: usize = 200;
/// Quantity ceiling per line, so a stray number can't blow a list up.
const MAX_LINE_QTY: i64 = 1_000_000_000;
/// A sender re-posting the same item within this many seconds of their last
/// accepted post of it is treated as a duplicate and dropped (see
/// `apply_cooldown`). Distinct items, distinct senders, and posts spaced beyond
/// the window all still count.
const CHAT_DEDUP_COOLDOWN_SECS: i64 = 3;

/// A token that is purely a number (optional `,`/`.` thousands separators and
/// an `x` prefix/suffix like "x100"/"100x"). Mirrors the frontend paste parser
/// (`shopping/parse.ts`), so chat and paste accept the same formats.
fn is_number_token(t: &str) -> bool {
    let t = t.strip_prefix(['x', 'X']).unwrap_or(t);
    let t = t.strip_suffix(['x', 'X']).unwrap_or(t);
    !t.is_empty()
        && t.chars().any(|c| c.is_ascii_digit())
        && t.chars()
            .all(|c| c.is_ascii_digit() || c == '.' || c == ',')
}

/// Parse one chat line into `(item name, quantity)`: the name is the leading
/// run of non-numeric tokens, the quantity the first number after it (absent →
/// 1); anything after the quantity is ignored. Chat text is untrusted input, so
/// control characters are stripped and name length / quantity are capped —
/// unparseable or oversized lines yield `None` and are simply ignored (the
/// resolver only ever matches real SDE type names, exactly, via a
/// parameterised query).
fn parse_chat_line(raw: &str) -> Option<(String, i64)> {
    // Strip control characters, but keep tabs — they're a legal separator in
    // Multibuy-style pastes and the tokenizer splits on them below.
    let line: String = raw
        .chars()
        .filter(|c| !c.is_control() || *c == '\t')
        .collect();
    let tokens: Vec<&str> = line.split([' ', '\t']).filter(|t| !t.is_empty()).collect();
    let split = tokens
        .iter()
        .position(|t| is_number_token(t))
        .unwrap_or(tokens.len());
    if split == 0 {
        return None; // empty or quantity-first line — no name
    }
    let name = tokens[..split].join(" ");
    if name.len() > MAX_NAME_LEN {
        return None;
    }
    let mut qty = 1i64;
    if split < tokens.len() {
        let digits: String = tokens[split]
            .chars()
            .filter(|c| c.is_ascii_digit())
            .collect();
        if let Ok(n) = digits.parse::<i64>() {
            qty = n.clamp(1, MAX_LINE_QTY);
        }
    }
    Some((name, qty))
}

/// One resolved item line captured from chat, tagged with who posted it and
/// when — the unit the cooldown de-duplicator works on.
struct ChatItem {
    ts: i64,
    sender: String,
    type_id: i64,
    quantity: i64,
    /// Display label for the poll result (`Name` or `Name ×N`).
    label: String,
}

/// Drop a sender's repeat of the same item posted within `cooldown_secs` of
/// their previous accepted post of it; different senders, different items, and
/// posts spaced beyond the window all pass. `last_seen` maps
/// `sender \u{1f} type_id` to the last accepted time and carries across polls.
/// Input MUST be in ascending `ts` order. Pure (testable).
fn apply_cooldown(
    candidates: Vec<ChatItem>,
    last_seen: &mut std::collections::BTreeMap<String, i64>,
    cooldown_secs: i64,
) -> Vec<ChatItem> {
    let mut kept = Vec::new();
    for c in candidates {
        let pair = format!("{}\u{1f}{}", c.sender, c.type_id);
        let dup = last_seen
            .get(&pair)
            .is_some_and(|&last| (0..cooldown_secs).contains(&(c.ts - last)));
        if dup {
            continue;
        }
        last_seen.insert(pair, c.ts);
        kept.push(c);
    }
    kept
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

/// Follow an EVE chat channel's logs and add any linked/typed items to a target
/// list (`list_id`, default the built-in Chat list). Follows *all*
/// `<channel>_*.txt` in `logs_dir` modified in the last day (EVE writes one file
/// per client/session), imports each distinct message once (de-duplicated across
/// the per-client copies), and resolves each line as an item name via the SDE —
/// non-item chatter is ignored. Poll this every few seconds while listening.
/// Public — chat capture needs no login.
#[tauri::command]
pub fn shopping_chat_sync(
    app: AppHandle,
    logs_dir: String,
    channel: String,
    from_now: Option<bool>,
    list_id: Option<String>,
) -> Result<ChatSync, String> {
    let (dir, sde) = crate::sde::dir_and_sde(&app)?;
    let chan = channel.trim();
    if chan.is_empty() {
        return Err("channel name is empty".into());
    }
    // Where captured items land — defaults to the built-in Chat list.
    let target_id = list_id
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(CHAT_LIST.0)
        .to_string();

    // Every chatlog whose name starts with "<channel>_" (EVE appends
    // _<date>_<time>_<charId>.txt) that was modified in the last day — only
    // those can carry today's messages, and a new write pulls an idle file back
    // into the window on the next poll.
    let logs = std::path::Path::new(&logs_dir);
    let prefix = format!("{}_", chan.to_ascii_lowercase());
    let cutoff =
        std::time::SystemTime::now().checked_sub(std::time::Duration::from_secs(24 * 60 * 60));
    let mut recent: Vec<(std::path::PathBuf, String)> = std::fs::read_dir(logs)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .to_ascii_lowercase()
                .starts_with(&prefix)
        })
        .filter_map(|e| {
            let modified = e.metadata().ok()?.modified().ok()?;
            if cutoff.map(|c| modified < c).unwrap_or(false) {
                return None;
            }
            let name = e.file_name().to_string_lossy().into_owned();
            Some((e.path(), name))
        })
        .collect();
    recent.sort_by(|a, b| a.1.cmp(&b.1));

    let mut store = load(&dir);
    // Ensure the target list exists. The built-in Chat list is auto-created on
    // demand (it isn't seeded like default/production); any other target must
    // already exist — the UI only offers lists that do.
    if !store.lists.iter().any(|l| l.id == target_id) {
        if target_id == CHAT_LIST.0 {
            store.lists.push(StoredList {
                id: CHAT_LIST.0.to_string(),
                name: CHAT_LIST.1.to_string(),
                items: Vec::new(),
            });
        } else {
            return Err(format!("no such list: {target_id}"));
        }
    }

    // Switching channels drops progress for the old one.
    let channel_changed = store.chat.channel != chan;
    if channel_changed {
        store.chat.channel = chan.to_string();
        store.chat.seen.clear();
        store.chat.cooldown.clear();
    }

    if recent.is_empty() {
        // Remember the channel even if no file yet, so the UI can show it.
        save(&dir, &store)?;
        return Ok(ChatSync {
            added: Vec::new(),
            file: String::new(),
            found: false,
        });
    }

    // What to show as "listening to …" — one name, or a count when we follow
    // several files at once (multiboxing / rotated logs).
    let label = if recent.len() == 1 {
        recent[0].1.clone()
    } else {
        format!("{} logs", recent.len())
    };

    // The de-duplicated union of messages across all followed files. Several of
    // the user's online characters each log the *same* channel to their own
    // file, so a message shows up once per client — key on `[ ts ] Sender`
    // (identical across those copies) to import it exactly once. Distinct
    // messages (incl. the same text posted twice) keep distinct keys via their
    // timestamps. Insertion order = first file that carried each message.
    let mut union: Vec<crate::chatlog::ChatEntry> = Vec::new();
    let mut union_keys: std::collections::BTreeSet<String> = std::collections::BTreeSet::new();
    for (path, _name) in &recent {
        for entry in crate::chatlog::parse_chat_entries(
            &crate::chatlog::read_chatlog(path).unwrap_or_default(),
        ) {
            if union_keys.insert(entry.key.clone()) {
                union.push(entry);
            }
        }
    }

    // `from_now` (sent on Start) marks every current message as seen and adds
    // nothing, so we only capture messages linked from here on — important for
    // busy channels like Corp that already hold the whole day's chatter.
    if from_now == Some(true) {
        store.chat.seen = union_keys;
        save(&dir, &store)?;
        return Ok(ChatSync {
            added: Vec::new(),
            file: label,
            found: true,
        });
    }

    // Ingest messages we haven't seen before (a message opened after Start, or
    // in a client that joined later, is new here regardless of which file it
    // landed in; its MOTD is an "EVE System" line, already filtered out). Gather
    // the resolved item lines, then apply the per-sender cooldown before adding
    // — a rapid duplicate from the same sender is dropped, but different senders
    // / items and spaced re-posts still count.
    let mut candidates: Vec<ChatItem> = Vec::new();
    for entry in &union {
        if store.chat.seen.contains(&entry.key) {
            continue;
        }
        // One item per line: multi-line pastes arrive as one message with
        // embedded newlines (see chatlog.rs), and each line may carry a
        // quantity ("Tritanium 100", "Pyerite\t50", "x3" styles).
        for raw in entry.text.lines().take(MAX_LINES_PER_MESSAGE) {
            let Some((name, qty)) = parse_chat_line(raw) else {
                continue;
            };
            if let Some((type_id, _)) = sde.type_by_name(&name).map_err(|e| e.to_string())? {
                candidates.push(ChatItem {
                    ts: entry.ts,
                    sender: entry.sender.clone(),
                    type_id,
                    quantity: qty,
                    label: if qty > 1 {
                        format!("{name} ×{qty}")
                    } else {
                        name
                    },
                });
            }
        }
    }
    // Timestamp order so the cooldown accepts the first of a burst and drops the
    // rest, deterministically regardless of which client's file carried it.
    candidates.sort_by_key(|c| c.ts);

    // Prune cooldown entries older than the follow window so it stays bounded
    // (stale entries flush to disk on the next save).
    let now_secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);
    store
        .chat
        .cooldown
        .retain(|_, ts| *ts >= now_secs - 24 * 60 * 60);

    let kept = apply_cooldown(
        candidates,
        &mut store.chat.cooldown,
        CHAT_DEDUP_COOLDOWN_SECS,
    );

    let mut added = Vec::with_capacity(kept.len());
    {
        // Find (ensured above) the target list and append the kept items.
        let list = store
            .lists
            .iter_mut()
            .find(|l| l.id == target_id)
            .expect("target list ensured above");
        for c in kept {
            match list.items.iter_mut().find(|e| e.type_id == c.type_id) {
                Some(e) => e.quantity = e.quantity.saturating_add(c.quantity),
                None => list.items.push(StoredEntry {
                    type_id: c.type_id,
                    quantity: c.quantity,
                }),
            }
            added.push(c.label);
        }
    }

    // Everything currently in the window is now seen. Assigning the fresh set
    // also prunes keys whose files aged out, keeping `seen` bounded. Only
    // rewrite the store when something actually moved — the poll runs every few
    // seconds and most ticks are no-ops.
    let seen_changed = union_keys != store.chat.seen;
    store.chat.seen = union_keys;
    if channel_changed || seen_changed || !added.is_empty() {
        save(&dir, &store)?;
    }
    Ok(ChatSync {
        added,
        file: label,
        found: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_name_only_lines_as_quantity_one() {
        assert_eq!(parse_chat_line("Tritanium"), Some(("Tritanium".into(), 1)));
    }

    #[test]
    fn parses_trailing_quantities_in_multibuy_styles() {
        assert_eq!(
            parse_chat_line("Tritanium 100"),
            Some(("Tritanium".into(), 100))
        );
        assert_eq!(
            parse_chat_line("Pyerite\t1,500"),
            Some(("Pyerite".into(), 1500))
        );
        assert_eq!(
            parse_chat_line("Mexallon x25"),
            Some(("Mexallon".into(), 25))
        );
        // Trailing columns after the quantity are ignored.
        assert_eq!(
            parse_chat_line("Isogen\t10\tMineral\t1 m3"),
            Some(("Isogen".into(), 10))
        );
    }

    #[test]
    fn keeps_numbers_that_are_part_of_the_name() {
        assert_eq!(
            parse_chat_line("125mm Gatling AutoCannon I 2"),
            Some(("125mm Gatling AutoCannon I".into(), 2))
        );
    }

    #[test]
    fn rejects_untrusted_junk() {
        assert_eq!(parse_chat_line(""), None);
        assert_eq!(parse_chat_line("   "), None);
        assert_eq!(parse_chat_line("100"), None); // quantity-first, no name
                                                  // Control characters are stripped before parsing.
        assert_eq!(
            parse_chat_line("Trit\x07anium"),
            Some(("Tritanium".into(), 1))
        );
        // Absurd names/quantities are bounded.
        assert_eq!(parse_chat_line(&"a".repeat(300)), None);
        assert_eq!(
            parse_chat_line("Tritanium 99999999999999999999"),
            Some(("Tritanium".into(), 1)) // unparseable digits → default 1
        );
    }

    fn item(ts: i64, sender: &str, type_id: i64) -> ChatItem {
        ChatItem {
            ts,
            sender: sender.into(),
            type_id,
            quantity: 1,
            label: "x".into(),
        }
    }
    fn ids(kept: &[ChatItem]) -> Vec<(i64, &str, i64)> {
        kept.iter()
            .map(|c| (c.ts, c.sender.as_str(), c.type_id))
            .collect()
    }

    #[test]
    fn cooldown_drops_a_senders_rapid_repeat_of_the_same_item() {
        let mut seen = std::collections::BTreeMap::new();
        let kept = apply_cooldown(
            vec![
                item(100, "Bob", 34), // accepted
                item(102, "Bob", 34), // +2s → dropped (within cooldown)
                item(104, "Bob", 34), // +4s from accepted → accepted again
            ],
            &mut seen,
            3,
        );
        assert_eq!(ids(&kept), vec![(100, "Bob", 34), (104, "Bob", 34)]);
    }

    #[test]
    fn cooldown_is_per_sender_and_per_item() {
        let mut seen = std::collections::BTreeMap::new();
        let kept = apply_cooldown(
            vec![
                item(100, "Bob", 34),   // different sender / item combos all pass
                item(100, "Alice", 34), // other sender, same item
                item(101, "Bob", 35),   // same sender, other item
            ],
            &mut seen,
            3,
        );
        assert_eq!(
            ids(&kept),
            vec![(100, "Bob", 34), (100, "Alice", 34), (101, "Bob", 35)]
        );
    }

    #[test]
    fn cooldown_state_carries_across_calls() {
        let mut seen = std::collections::BTreeMap::new();
        apply_cooldown(vec![item(100, "Bob", 34)], &mut seen, 3);
        // Next poll: a repeat 1s later is dropped, one 5s later is kept.
        let kept = apply_cooldown(
            vec![item(101, "Bob", 34), item(105, "Bob", 34)],
            &mut seen,
            3,
        );
        assert_eq!(ids(&kept), vec![(105, "Bob", 34)]);
    }
}
