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

use crate::esi::{authed_get, resolve_names, AuthState, ESI_BASE, USER_AGENT};
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
#[derive(Deserialize, Default)]
struct UniverseIds {
    #[serde(default)]
    characters: Vec<IdName>,
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
#[derive(Deserialize)]
struct EsiStanding {
    from_id: i64,
    standing: f64,
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

    // 1. names → character ids (public POST /universe/ids/). Non-character
    //    matches (corp/alliance names someone pasted) are ignored.
    let ids: UniverseIds = http
        .post(format!("{ESI_BASE}/latest/universe/ids/"))
        .json(&names)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let resolved: HashMap<String, i64> =
        ids.characters.iter().map(|c| (c.name.clone(), c.id)).collect();
    let unresolved: Vec<String> = names
        .iter()
        .filter(|n| !resolved.contains_key(*n))
        .cloned()
        .collect();
    let char_ids: Vec<i64> = ids.characters.iter().map(|c| c.id).collect();

    // 2. character ids → corp/alliance/faction (public POST /characters/affiliation/).
    let affiliations: Vec<Affiliation> = if char_ids.is_empty() {
        Vec::new()
    } else {
        http.post(format!("{ESI_BASE}/latest/characters/affiliation/"))
            .json(&char_ids)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?
    };

    // 3. resolve corp/alliance ids → names (POST /universe/names/).
    let mut org_ids: Vec<i64> = Vec::new();
    for a in &affiliations {
        org_ids.push(a.corporation_id);
        if let Some(al) = a.alliance_id {
            org_ids.push(al);
        }
    }
    org_ids.extend(char_ids.iter().copied());
    let org_names = resolve_names(&auth_state, &org_ids).await;

    // 4. the logged-in character's standings, keyed by entity id.
    let standings = load_standings(&app, &auth_state).await;

    let aff_by_id: HashMap<i64, &Affiliation> =
        affiliations.iter().map(|a| (a.character_id, a)).collect();

    let mut pilots: Vec<LocalPilot> = Vec::new();
    let (mut reds, mut neutrals, mut blues) = (0i64, 0i64, 0i64);
    for c in &ids.characters {
        let aff = aff_by_id.get(&c.id);
        let corporation = aff
            .and_then(|a| org_names.get(&a.corporation_id).cloned())
            .unwrap_or_default();
        let alliance = aff
            .and_then(|a| a.alliance_id)
            .and_then(|al| org_names.get(&al).cloned());
        // Standing: most specific entry wins (corp → alliance → faction).
        let standing = aff.and_then(|a| {
            standings
                .get(&a.corporation_id)
                .or_else(|| a.alliance_id.and_then(|al| standings.get(&al)))
                .or_else(|| a.faction_id.and_then(|f| standings.get(&f)))
                .copied()
        });
        let threat = threat_of(standing);
        match threat {
            "red" => reds += 1,
            "blue" => blues += 1,
            _ => neutrals += 1,
        }
        pilots.push(LocalPilot {
            character_id: c.id,
            name: org_names.get(&c.id).cloned().unwrap_or_else(|| c.name.clone()),
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

/// The logged-in character's standings as an entity-id → standing map. Returns
/// empty (everyone neutral) if no character is logged in or the fetch fails.
async fn load_standings(app: &AppHandle, auth_state: &AuthState) -> HashMap<i64, f64> {
    let Ok(dir) = app.path().app_data_dir() else {
        return HashMap::new();
    };
    let Some(character_id) = storage::active_character(&dir)
    else {
        return HashMap::new();
    };
    let standings: Result<Vec<EsiStanding>, _> = authed_get(
        auth_state,
        character_id,
        &format!("/latest/characters/{character_id}/standings/"),
    )
    .await;
    standings
        .map(|rows| rows.into_iter().map(|s| (s.from_id, s.standing)).collect())
        .unwrap_or_default()
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
struct ZkillRaw {
    #[serde(default)]
    danger_ratio: i64,
    #[serde(default)]
    gang_ratio: i64,
    #[serde(default)]
    ships_destroyed: i64,
    #[serde(default)]
    ships_lost: i64,
    #[serde(default)]
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
                let raw: Option<ZkillRaw> = async {
                    client.get(&url).send().await.ok()?.json().await.ok()
                }
                .await;
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
        let _ = storage::cache_put(&dir, &format!("zkill_{}", s.character_id), s, ZKILL_TTL_SECS);
    }
    out.extend(fetched);
    Ok(out)
}

/// Read an EVE chatlog file, decoding UTF-16LE (the format EVE writes) or UTF-8.
fn read_chatlog(path: &std::path::Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        // UTF-16LE with BOM.
        let u16s: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        Some(String::from_utf16_lossy(&u16s))
    } else {
        Some(String::from_utf8_lossy(&bytes).into_owned())
    }
}

/// Distinct sender names from chatlog content. Message lines look like
/// `[ 2026.06.25 12:00:00 ] Sender Name > text`. The member list isn't logged,
/// so this only yields pilots who actually spoke. Pure (testable).
fn parse_chat_senders(content: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for line in content.lines() {
        let Some((_, after)) = line.split_once("] ") else { continue };
        let Some((sender, _msg)) = after.split_once(" > ") else { continue };
        let s = sender.trim();
        if s.is_empty() || s == "EVE System" {
            continue;
        }
        if seen.insert(s.to_string()) {
            out.push(s.to_string());
        }
    }
    out
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
        return Ok(LocalLogResult { senders: Vec::new(), file: String::new() });
    };
    let content = read_chatlog(&path).unwrap_or_default();
    Ok(LocalLogResult {
        senders: parse_chat_senders(&content),
        file: path.file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default(),
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
    fn parses_chat_senders_from_log() {
        let log = "---------------------------------------------------------------\n\
                   [ 2026.06.25 12:00:00 ] EVE System > Channel changed to Local : Jita\n\
                   [ 2026.06.25 12:01:02 ] Alice Pilot > hi\n\
                   [ 2026.06.25 12:01:30 ] Bob Pilot > o7\n\
                   [ 2026.06.25 12:02:00 ] Alice Pilot > again\n";
        // Distinct real speakers, EVE System filtered out, deduped, ordered.
        assert_eq!(parse_chat_senders(log), vec!["Alice Pilot", "Bob Pilot"]);
    }

    #[test]
    fn classifies_standing_bands() {
        assert_eq!(threat_of(Some(5.0)), "blue");
        assert_eq!(threat_of(Some(-2.5)), "red");
        assert_eq!(threat_of(Some(0.0)), "neutral");
        assert_eq!(threat_of(None), "neutral");
    }
}
