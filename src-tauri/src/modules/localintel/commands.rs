//! Local Intel — paste the in-game Local member list, classify every pilot by
//! corp/alliance and your standing toward them (blue / neutral / red).
//!
//! EVE never writes the Local *member list* to a log, and ESI has no "who's in
//! my system" endpoint, so the data comes from the player copying the member
//! list (a manual, EULA-safe action). We resolve names → ids → corp/alliance
//! via public ESI, then classify against the logged-in character's standings.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use futures_util::stream::{self, StreamExt};

use crate::esi::{
    authed_get, authed_get_paged_pub, corporation_id, resolve_character_ids, resolve_names,
    AuthState, ESI_BASE, USER_AGENT,
};
use crate::storage;

/// Cap on pasted names per scan (Local tops out well below this).
const NAME_CAP: usize = 256;

/// One classified pilot in the pasted Local list.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPilot {
    pub character_id: i64,
    pub name: String,
    pub corporation_id: i64,
    pub corporation: String,
    pub alliance_id: Option<i64>,
    pub alliance: Option<String>,
    /// Your standing toward the most-specific entity that has one (corp →
    /// alliance → faction), or null if you have none.
    pub standing: Option<f64>,
    /// "blue" (standing > 0) / "red" (< 0) / "neutral" (0 or unknown).
    pub threat: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalScanResult {
    pub pilots: Vec<LocalPilot>,
    pub reds: i64,
    pub neutrals: i64,
    pub blues: i64,
    /// Pasted names that couldn't be resolved to a character.
    pub unresolved: Vec<String>,
}

/// Parse the in-game Local member-list copy: one character name per line. Trims,
/// drops blanks, dedupes (preserving order), and caps the count.
fn parse_names(text: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .filter(|l| seen.insert(l.to_string()))
        .take(NAME_CAP)
        .map(str::to_string)
        .collect()
}

/// Classify a standing into a threat band. `None`/0.0 = neutral.
fn threat_of(standing: Option<f64>) -> &'static str {
    match standing {
        Some(s) if s > 0.0 => "blue",
        Some(s) if s < 0.0 => "red",
        _ => "neutral",
    }
}

#[derive(Deserialize)]
struct IdName {
    id: i64,
    name: String,
}
#[derive(Deserialize)]
struct Affiliation {
    character_id: i64,
    corporation_id: i64,
    #[serde(default)]
    alliance_id: Option<i64>,
    #[serde(default)]
    faction_id: Option<i64>,
}
/// One contact (`/{characters|corporations|alliances}/{id}/contacts/`): a
/// blue/red mark on a character, corp, alliance or faction. `contact_id` is the
/// entity id. Same shape across the personal/corp/alliance endpoints.
#[derive(Deserialize)]
struct Contact {
    contact_id: i64,
    standing: f64,
}
/// A cached character affiliation (corp/alliance/faction) + when it was fetched.
#[derive(Serialize, Deserialize, Clone)]
struct CachedAff {
    corporation_id: i64,
    alliance_id: Option<i64>,
    faction_id: Option<i64>,
    /// Unix epoch (secs) of the fetch, for the affiliation TTL.
    ts: u64,
}

// Cache keys (under the app data dir) + TTLs. name↔id never change, so those
// caches are durable; affiliations (corp moves) and standings (contact edits)
// can change, so they carry a TTL.
const CACHE_NAMES: &str = "esi_names"; // entity id → name
const CACHE_AFFILIATIONS: &str = "esi_affiliations"; // character id → CachedAff
const AFFILIATION_TTL: u64 = 60 * 60; // 1 hour
const STANDINGS_TTL: u64 = 30 * 60; // 30 minutes

fn now_epoch() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}

/// The logged-in character's standings, cached for [`STANDINGS_TTL`] so repeated
/// scans don't re-pull the (3-call) contacts set every time.
async fn cached_standings(app: &AppHandle, auth_state: &AuthState) -> HashMap<i64, f64> {
    let Ok(dir) = app.path().app_data_dir() else {
        return load_standings(app, auth_state).await;
    };
    let Some(character_id) = storage::primary_character(&dir) else {
        return HashMap::new();
    };
    let key = format!("localintel_standings_{character_id}");
    if let Some(cached) = storage::cache_get::<HashMap<i64, f64>>(&dir, &key) {
        return cached;
    }
    let fresh = load_standings(app, auth_state).await;
    let _ = storage::cache_put(&dir, &key, &fresh, STANDINGS_TTL);
    fresh
}

/// Corporation public info — we only need its alliance membership.
#[derive(Deserialize)]
struct CorpInfo {
    #[serde(default)]
    alliance_id: Option<i64>,
}

/// Resolve a pasted Local member list to classified pilots. Name→id and
/// affiliation use public ESI POST endpoints; standings use the logged-in
/// character (`esi-characters.read_standings.v1`, already granted).
#[tauri::command]
pub async fn local_scan(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
    text: String,
) -> Result<LocalScanResult, String> {
    let names = parse_names(&text);
    if names.is_empty() {
        return Ok(LocalScanResult {
            pilots: Vec::new(),
            reds: 0,
            neutrals: 0,
            blues: 0,
            unresolved: Vec::new(),
        });
    }
    let http = auth_state.http();
    let dir = app.path().app_data_dir().ok();
    let lower = |n: &str| n.to_lowercase();

    // 1. names → character ids — shared resolver, cached forever (a name→id
    //    mapping never changes).
    let id_cache = resolve_character_ids(http, dir.as_deref(), &names).await;
    // Resolved pilots (deduped by id), and the names we still couldn't resolve.
    let mut seen = HashSet::new();
    let characters: Vec<IdName> = names
        .iter()
        .filter_map(|n| {
            id_cache.get(&lower(n)).map(|&id| IdName {
                id,
                name: n.clone(),
            })
        })
        .filter(|c| seen.insert(c.id))
        .collect();
    let unresolved: Vec<String> = names
        .iter()
        .filter(|n| !id_cache.contains_key(&lower(n)))
        .cloned()
        .collect();
    let char_ids: Vec<i64> = characters.iter().map(|c| c.id).collect();

    // 2. character ids → corp/alliance/faction — cached with a 1h TTL (corp moves
    //    are infrequent); only stale/unknown ids hit /characters/affiliation/.
    let now = now_epoch();
    let mut aff_cache: HashMap<i64, CachedAff> = dir
        .as_ref()
        .and_then(|d| storage::load_data(d, CACHE_AFFILIATIONS))
        .unwrap_or_default();
    let stale: Vec<i64> = char_ids
        .iter()
        .copied()
        .filter(|id| {
            aff_cache
                .get(id)
                .is_none_or(|c| now.saturating_sub(c.ts) >= AFFILIATION_TTL)
        })
        .collect();
    if !stale.is_empty() {
        if let Ok(rows) = (async {
            http.post(format!("{ESI_BASE}/latest/characters/affiliation/"))
                .json(&stale)
                .send()
                .await
                .ok()?
                .error_for_status()
                .ok()?
                .json::<Vec<Affiliation>>()
                .await
                .ok()
        })
        .await
        .ok_or(())
        {
            for a in rows {
                aff_cache.insert(
                    a.character_id,
                    CachedAff {
                        corporation_id: a.corporation_id,
                        alliance_id: a.alliance_id,
                        faction_id: a.faction_id,
                        ts: now,
                    },
                );
            }
            if let Some(d) = &dir {
                let _ = storage::save_data(d, CACHE_AFFILIATIONS, &aff_cache);
            }
        }
    }
    let affiliations: Vec<Affiliation> = char_ids
        .iter()
        .filter_map(|id| {
            aff_cache.get(id).map(|c| Affiliation {
                character_id: *id,
                corporation_id: c.corporation_id,
                alliance_id: c.alliance_id,
                faction_id: c.faction_id,
            })
        })
        .collect();

    // 3. resolve corp/alliance/char ids → names — cached durably (names never
    //    change), so only ids we've never resolved hit /universe/names/.
    let mut org_ids: Vec<i64> = Vec::new();
    for a in &affiliations {
        org_ids.push(a.corporation_id);
        if let Some(al) = a.alliance_id {
            org_ids.push(al);
        }
    }
    org_ids.extend(char_ids.iter().copied());
    let mut name_cache: HashMap<i64, String> = dir
        .as_ref()
        .and_then(|d| storage::load_data(d, CACHE_NAMES))
        .unwrap_or_default();
    let missing_names: Vec<i64> = org_ids
        .iter()
        .copied()
        .filter(|id| !name_cache.contains_key(id))
        .collect();
    if !missing_names.is_empty() {
        let fresh = resolve_names(&auth_state, &missing_names).await;
        if !fresh.is_empty() {
            name_cache.extend(fresh);
            if let Some(d) = &dir {
                let _ = storage::save_data(d, CACHE_NAMES, &name_cache);
            }
        }
    }
    let org_names = &name_cache;

    // 4. the logged-in character's standings, keyed by entity id (cached 30m).
    let standings = cached_standings(&app, &auth_state).await;

    let aff_by_id: HashMap<i64, &Affiliation> =
        affiliations.iter().map(|a| (a.character_id, a)).collect();

    let mut pilots: Vec<LocalPilot> = Vec::new();
    let (mut reds, mut neutrals, mut blues) = (0i64, 0i64, 0i64);
    for c in &characters {
        let aff = aff_by_id.get(&c.id);
        let corporation = aff
            .and_then(|a| org_names.get(&a.corporation_id).cloned())
            .unwrap_or_default();
        let alliance = aff
            .and_then(|a| a.alliance_id)
            .and_then(|al| org_names.get(&al).cloned());
        // Standing: most specific entry wins — a personal contact on the pilot
        // themselves, then corp → alliance → faction.
        // Most specific player standing wins: the pilot, then their corp, then
        // their alliance. NPC *faction* standings are deliberately NOT applied —
        // your standing toward an empire faction (e.g. −10 from missions) must
        // not flag every faction-warfare militia player as hostile.
        let standing = standings.get(&c.id).copied().or_else(|| {
            aff.and_then(|a| {
                standings
                    .get(&a.corporation_id)
                    .or_else(|| a.alliance_id.and_then(|al| standings.get(&al)))
                    .copied()
            })
        });
        let threat = threat_of(standing);
        match threat {
            "red" => reds += 1,
            "blue" => blues += 1,
            _ => neutrals += 1,
        }
        pilots.push(LocalPilot {
            character_id: c.id,
            name: org_names
                .get(&c.id)
                .cloned()
                .unwrap_or_else(|| c.name.clone()),
            corporation_id: aff.map(|a| a.corporation_id).unwrap_or(0),
            corporation,
            alliance_id: aff.and_then(|a| a.alliance_id),
            alliance,
            standing,
            threat: threat.to_string(),
        });
    }
    // Reds first, then neutrals, then blues; by name within a band.
    pilots.sort_by(|a, b| {
        threat_rank(&a.threat)
            .cmp(&threat_rank(&b.threat))
            .then_with(|| a.name.cmp(&b.name))
    });

    Ok(LocalScanResult {
        pilots,
        reds,
        neutrals,
        blues,
        unresolved,
    })
}

fn threat_rank(threat: &str) -> u8 {
    match threat {
        "red" => 0,
        "neutral" => 1,
        _ => 2,
    }
}

/// The active character's standings toward **players** as an entity-id →
/// standing map, used to classify Local. Layered, **most-specific winning**:
///
///   1. **Alliance** contacts — set by your alliance leadership.
///   2. **Corp** contacts — set by your corp leadership.
///   3. Your **personal** contacts — the blue/red you set yourself (highest).
///
/// Each layer overwrites the previous for the same entity. NPC faction/agent
/// standings are intentionally excluded — they describe NPCs, not players, and
/// applying them flagged faction-warfare pilots as false −10 reds. Returns empty
/// (everyone neutral) if no character is active or every fetch fails; any layer
/// whose scope/role isn't granted (403) is simply skipped.
async fn load_standings(app: &AppHandle, auth_state: &AuthState) -> HashMap<i64, f64> {
    let Ok(dir) = app.path().app_data_dir() else {
        return HashMap::new();
    };
    let Some(character_id) = storage::primary_character(&dir) else {
        return HashMap::new();
    };

    let mut map: HashMap<i64, f64> = HashMap::new();
    let merge = |map: &mut HashMap<i64, f64>, rows: Vec<Contact>| {
        for c in rows {
            map.insert(c.contact_id, c.standing);
        }
    };

    // 1/2. Alliance then corp contacts (needs esi-alliances.read_contacts.v1 /
    // esi-corporations.read_contacts.v1 + membership/role). The character's corp
    // gives both ids; a 403 (no scope/role, or not in an alliance) is skipped.
    if let Ok(corp_id) = corporation_id(auth_state, character_id).await {
        let alliance_id = authed_get::<CorpInfo>(
            auth_state,
            character_id,
            &format!("/latest/corporations/{corp_id}/"),
        )
        .await
        .ok()
        .and_then(|c| c.alliance_id);
        if let Some(alliance_id) = alliance_id {
            if let Ok(rows) = authed_get_paged_pub::<Contact>(
                auth_state,
                character_id,
                &format!("/latest/alliances/{alliance_id}/contacts/"),
            )
            .await
            {
                merge(&mut map, rows);
            }
        }
        if let Ok(rows) = authed_get_paged_pub::<Contact>(
            auth_state,
            character_id,
            &format!("/latest/corporations/{corp_id}/contacts/"),
        )
        .await
        {
            merge(&mut map, rows);
        }
    }

    // 3. Personal contacts (needs esi-characters.read_contacts.v1) — your own
    // explicit marks win over corp/alliance.
    if let Ok(rows) = authed_get_paged_pub::<Contact>(
        auth_state,
        character_id,
        &format!("/latest/characters/{character_id}/contacts/"),
    )
    .await
    {
        merge(&mut map, rows);
    }

    map
}

/// zKillboard etiquette: a descriptive UA (we have one) and low concurrency.
const ZKILL_CONCURRENCY: usize = 4;
/// Killboard stats change slowly — cache each character for 6h.
const ZKILL_TTL_SECS: u64 = 21_600;

/// zKillboard danger signals for one character (the fields we surface).
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ZkillStats {
    pub character_id: i64,
    /// 0–100: share of recent engagements that were kills (higher = more dangerous).
    pub danger_ratio: i64,
    /// 0–100: share of kills made in a gang (vs solo).
    pub gang_ratio: i64,
    pub ships_destroyed: i64,
    pub ships_lost: i64,
    /// True if there is PvP activity in the last months (recently active).
    pub active: bool,
}

/// Raw zKill stats document (defensive: characters with no kills omit fields).
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ZkillRaw {
    #[serde(default)]
    danger_ratio: i64,
    #[serde(default)]
    gang_ratio: i64,
    #[serde(default)]
    ships_destroyed: i64,
    #[serde(default)]
    ships_lost: i64,
    #[serde(default, rename = "activepvp")]
    active_pvp: serde_json::Value,
}

/// Enrich resolved characters with zKillboard danger stats. Per-character cached
/// (~6h); failures are skipped so the base scan (#95) still works if zKill is
/// down. Low concurrency + our contact UA respect zKill's API etiquette.
#[tauri::command]
pub async fn localintel_zkill(
    app: AppHandle,
    character_ids: Vec<i64>,
) -> Result<Vec<ZkillStats>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;

    // Serve cache hits first; only fetch the misses.
    let mut out: Vec<ZkillStats> = Vec::new();
    let mut to_fetch: Vec<i64> = Vec::new();
    for id in character_ids {
        match storage::cache_get::<ZkillStats>(&dir, &format!("zkill_{id}")) {
            Some(s) => out.push(s),
            None => to_fetch.push(id),
        }
    }

    let client = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| e.to_string())?;
    let fetched: Vec<ZkillStats> = stream::iter(to_fetch)
        .map(|id| {
            let client = client.clone();
            async move {
                let url = format!("https://zkillboard.com/api/stats/characterID/{id}/");
                let raw: Option<ZkillRaw> =
                    async { client.get(&url).send().await.ok()?.json().await.ok() }.await;
                raw.map(|r| ZkillStats {
                    character_id: id,
                    danger_ratio: r.danger_ratio,
                    gang_ratio: r.gang_ratio,
                    ships_destroyed: r.ships_destroyed,
                    ships_lost: r.ships_lost,
                    // `activepvp` is present (with kill counts) for active pilots.
                    active: r.active_pvp.as_object().is_some_and(|o| !o.is_empty()),
                })
            }
        })
        .buffer_unordered(ZKILL_CONCURRENCY)
        .filter_map(|s| async move { s })
        .collect()
        .await;

    for s in &fetched {
        let _ = storage::cache_put(
            &dir,
            &format!("zkill_{}", s.character_id),
            s,
            ZKILL_TTL_SECS,
        );
    }
    out.extend(fetched);
    Ok(out)
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalLogResult {
    /// Pilots who spoke in the newest Local log (the only names logs contain).
    pub senders: Vec<String>,
    /// The log file used, or empty if none found.
    pub file: String,
}

/// Pull speaker names from the most recent `Local_*` chatlog in `logs_dir`
/// (e.g. `…/EVE/logs/Chatlogs`). A convenience source for the scan — EVE never
/// logs the Local member list, so this only sees pilots who chatted. The path
/// is user-configured (it lives inside the Proton/Wine prefix on Linux).
#[tauri::command]
pub fn local_log_names(logs_dir: String) -> Result<LocalLogResult, String> {
    let dir = std::path::Path::new(&logs_dir);
    if !dir.is_dir() {
        return Err(format!("not a folder: {logs_dir}"));
    }
    // Newest Local_*.txt by modified time.
    let newest = std::fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.file_name()
                .to_string_lossy()
                .to_ascii_lowercase()
                .starts_with("local_")
        })
        .filter_map(|e| Some((e.path(), e.metadata().ok()?.modified().ok()?)))
        .max_by_key(|(_, m)| *m);

    let Some((path, _)) = newest else {
        return Ok(LocalLogResult {
            senders: Vec::new(),
            file: String::new(),
        });
    };
    let content = crate::chatlog::read_chatlog(&path).unwrap_or_default();
    Ok(LocalLogResult {
        senders: crate::chatlog::parse_chat_senders(&content),
        file: path
            .file_name()
            .map(|f| f.to_string_lossy().into_owned())
            .unwrap_or_default(),
    })
}

const WATCHLIST_KEY: &str = "localintel_watchlist";

/// A watched corporation or alliance — a scan flags any pilot in it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WatchEntry {
    pub id: i64,
    pub name: String,
}

/// The current watchlist (corps/alliances to flag in a scan).
#[tauri::command]
pub fn localintel_get_watchlist(app: AppHandle) -> Result<Vec<WatchEntry>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(storage::load_data(&dir, WATCHLIST_KEY).unwrap_or_default())
}

/// Add or remove a corp/alliance from the watchlist; returns the updated list.
#[tauri::command]
pub fn localintel_set_watchlist(
    app: AppHandle,
    id: i64,
    name: String,
    add: bool,
) -> Result<Vec<WatchEntry>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut list: Vec<WatchEntry> = storage::load_data(&dir, WATCHLIST_KEY).unwrap_or_default();
    list.retain(|e| e.id != id);
    if add {
        list.push(WatchEntry { id, name });
    }
    list.sort_by(|a, b| a.name.cmp(&b.name));
    storage::save_data(&dir, WATCHLIST_KEY, &list)?;
    Ok(list)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_dedupes_and_trims_names() {
        let text = "  Alice \nBob\n\nAlice\n  \nCharlie\n";
        assert_eq!(parse_names(text), vec!["Alice", "Bob", "Charlie"]);
    }

    #[test]
    fn classifies_standing_bands() {
        assert_eq!(threat_of(Some(5.0)), "blue");
        assert_eq!(threat_of(Some(-2.5)), "red");
        assert_eq!(threat_of(Some(0.0)), "neutral");
        assert_eq!(threat_of(None), "neutral");
    }

    #[test]
    fn zkill_raw_maps_camelcase_fields_and_activepvp_sets_active() {
        let raw: ZkillRaw = serde_json::from_str(
            r#"{
                "shipsDestroyed": 120, "shipsLost": 8,
                "dangerRatio": 88, "gangRatio": 40,
                "activepvp": { "ships": { "count": 3 } }
            }"#,
        )
        .unwrap();
        assert_eq!(raw.ships_destroyed, 120);
        assert_eq!(raw.ships_lost, 8);
        assert_eq!(raw.danger_ratio, 88);
        assert_eq!(raw.gang_ratio, 40);
        assert!(raw.active_pvp.as_object().is_some_and(|o| !o.is_empty()));
    }

    #[test]
    fn zkill_raw_missing_fields_default_and_no_activepvp_is_inactive() {
        // A character with no PvP: zKill omits the fields entirely.
        let raw: ZkillRaw = serde_json::from_str("{}").unwrap();
        assert_eq!(raw.ships_destroyed, 0);
        assert_eq!(raw.danger_ratio, 0);
        assert!(raw.active_pvp.as_object().is_none_or(|o| o.is_empty()));
    }
}
