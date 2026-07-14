//! PVP profiles — general zKillboard stats per pasted pilot (slice #532).

use std::collections::{HashMap, HashSet};

use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::esi::{resolve_character_ids, AuthState, ESI_BASE};
use crate::sde::{Sde, SdePaths};
use crate::storage;

/// Cap on pasted names per lookup.
const NAME_CAP: usize = 128;
/// zKill etiquette: low concurrency behind our contact User-Agent.
const ZKILL_CONCURRENCY: usize = 4;
/// Killboard stats change slowly — cache each pilot for 6h.
const ZKILL_TTL_SECS: u64 = 21_600;

/// How many top hulls to surface per pilot (the UI shows the first 5 or 10).
const MAX_HULLS: usize = 10;

/// One hull the pilot uses, with how many kills they got in it.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HullUsage {
    pub type_id: i64,
    pub name: String,
    pub kills: i64,
}

/// General PvP stats for one pilot, from zKillboard `/stats/`.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PvpStats {
    pub character_id: i64,
    pub name: String,
    pub ships_destroyed: i64,
    pub ships_lost: i64,
    pub isk_destroyed: f64,
    pub isk_lost: f64,
    /// Kills made solo (vs in a gang).
    pub solo_kills: i64,
    pub solo_losses: i64,
    /// 0–100: share of engagements that were kills (higher = more dangerous).
    pub danger_ratio: i64,
    /// 0–100: share of kills made in a gang (vs solo).
    pub gang_ratio: i64,
    /// True when there's PvP activity in the last months (recently active).
    pub active: bool,
    /// The hulls the pilot flies most, by kills (from zKill `topLists`), up to
    /// `MAX_HULLS`, highest kills first. Per-hull *loss* counts aren't in the
    /// stats doc — they arrive with the loss killmails in a later slice.
    pub hulls: Vec<HullUsage>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PvpProfilesResult {
    pub pilots: Vec<PvpStats>,
    /// Pasted names that didn't resolve to a character.
    pub unresolved: Vec<String>,
}

/// zKill `/stats/` document (defensive: pilots with no kills omit fields).
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct ZkillStatsRaw {
    #[serde(default)]
    ships_destroyed: i64,
    #[serde(default)]
    ships_lost: i64,
    #[serde(default)]
    isk_destroyed: f64,
    #[serde(default)]
    isk_lost: f64,
    #[serde(default)]
    solo_kills: i64,
    #[serde(default)]
    solo_losses: i64,
    #[serde(default)]
    danger_ratio: i64,
    #[serde(default)]
    gang_ratio: i64,
    /// Present (with counts) only for pilots with recent PvP.
    #[serde(default, rename = "activepvp")]
    activepvp: Option<serde_json::Value>,
    #[serde(default)]
    top_lists: Vec<TopListRaw>,
}

/// A row in a zKill `topLists` entry. Only the `shipType` list carries
/// `shipTypeID`/`shipName`; rows in the other lists leave them defaulted.
/// zKill uses `shipTypeID` (capital ID) and `shipName`, so the fields are
/// renamed explicitly rather than via `camelCase` (which yields `shipTypeId`).
#[derive(Deserialize, Default)]
struct ShipRow {
    #[serde(default, rename = "shipTypeID")]
    ship_type_id: i64,
    #[serde(default, rename = "shipName")]
    ship_name: String,
    #[serde(default)]
    kills: i64,
}

#[derive(Deserialize, Default)]
struct TopListRaw {
    #[serde(default, rename = "type")]
    kind: String,
    #[serde(default)]
    values: Vec<ShipRow>,
}

/// Pasted names: one per line, trimmed, blanks dropped, deduped (order kept,
/// case-insensitive), capped.
fn parse_names(text: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .filter(|l| seen.insert(l.to_lowercase()))
        .take(NAME_CAP)
        .map(str::to_string)
        .collect()
}

/// Map one raw zKill stats doc onto our surface for `character_id`/`name`.
fn stats_from_raw(character_id: i64, name: String, r: ZkillStatsRaw) -> PvpStats {
    // The `shipType` top-list is the hulls the pilot flew to get kills, already
    // sorted by kills desc; take the top few.
    let hulls = r
        .top_lists
        .iter()
        .find(|t| t.kind == "shipType")
        .map(|t| {
            t.values
                .iter()
                .filter(|s| s.ship_type_id > 0)
                .take(MAX_HULLS)
                .map(|s| HullUsage {
                    type_id: s.ship_type_id,
                    name: s.ship_name.clone(),
                    kills: s.kills,
                })
                .collect()
        })
        .unwrap_or_default();
    PvpStats {
        character_id,
        name,
        ships_destroyed: r.ships_destroyed,
        ships_lost: r.ships_lost,
        isk_destroyed: r.isk_destroyed,
        isk_lost: r.isk_lost,
        solo_kills: r.solo_kills,
        solo_losses: r.solo_losses,
        danger_ratio: r.danger_ratio,
        gang_ratio: r.gang_ratio,
        active: r.activepvp.is_some(),
        hulls,
    }
}

/// Paste pilot names → resolve → per-pilot general zKill stats. Results keep the
/// pasted order; a per-pilot zKill failure drops only that pilot. Stats are
/// cached ~6h; names that don't resolve come back in `unresolved`.
#[tauri::command]
pub async fn pvp_profiles(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
    text: String,
) -> Result<PvpProfilesResult, String> {
    let names = parse_names(&text);
    if names.is_empty() {
        return Ok(PvpProfilesResult {
            pilots: Vec::new(),
            unresolved: Vec::new(),
        });
    }
    let http = auth_state.http();
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let lower = |n: &str| n.to_lowercase();

    let id_cache = resolve_character_ids(&http, Some(&dir), &names).await;

    // Resolved (id, name) in pasted order, deduped by id; plus the misses.
    let mut seen = HashSet::new();
    let resolved: Vec<(i64, String)> = names
        .iter()
        .filter_map(|n| id_cache.get(&lower(n)).map(|&id| (id, n.clone())))
        .filter(|(id, _)| seen.insert(*id))
        .collect();
    let unresolved: Vec<String> = names
        .iter()
        .filter(|n| !id_cache.contains_key(&lower(n)))
        .cloned()
        .collect();

    let name_by_id: HashMap<i64, String> =
        resolved.iter().map(|(id, n)| (*id, n.clone())).collect();

    // Cache hits first; the rest fetched concurrently, low concurrency.
    let mut by_id: HashMap<i64, PvpStats> = HashMap::new();
    let mut to_fetch: Vec<i64> = Vec::new();
    for (id, name) in &resolved {
        match storage::cache_get::<PvpStats>(&dir, &format!("pvp_stats_{id}")) {
            Some(mut s) => {
                s.name = name.clone();
                by_id.insert(*id, s);
            }
            None => to_fetch.push(*id),
        }
    }

    let client = http.clone();
    let fetched: Vec<PvpStats> = stream::iter(to_fetch)
        .map(|id| {
            let client = client.clone();
            let name = name_by_id.get(&id).cloned().unwrap_or_default();
            async move {
                let url = format!("https://zkillboard.com/api/stats/characterID/{id}/");
                let raw: Option<ZkillStatsRaw> =
                    async { client.get(&url).send().await.ok()?.json().await.ok() }.await;
                raw.map(|r| stats_from_raw(id, name, r))
            }
        })
        .buffer_unordered(ZKILL_CONCURRENCY)
        .filter_map(|x| async move { x })
        .collect()
        .await;

    for s in &fetched {
        let _ = storage::cache_put(
            &dir,
            &format!("pvp_stats_{}", s.character_id),
            s,
            ZKILL_TTL_SECS,
        );
        by_id.insert(s.character_id, s.clone());
    }

    // Reassemble in pasted order (dropping pilots whose zKill fetch failed).
    let pilots: Vec<PvpStats> = resolved
        .iter()
        .filter_map(|(id, _)| by_id.get(id).cloned())
        .collect();

    Ok(PvpProfilesResult { pilots, unresolved })
}

// --- Slice 3 (#534): the pilot's lost fits, reconstructed from killmails. ---

/// Recent losses to pull per pilot before grouping by hull.
const LOSS_CAP: usize = 60;
/// Distinct lost hulls to surface per pilot.
const LOST_HULL_CAP: usize = 10;
/// Killmails are immutable, so cache them effectively forever (~10y).
const KILLMAIL_TTL_SECS: u64 = 60 * 60 * 24 * 3650;

/// A zKill loss-list entry: a killmail id + the hash needed to fetch it.
#[derive(Deserialize)]
struct ZkillRef {
    killmail_id: i64,
    zkb: ZkillZkb,
}
#[derive(Deserialize)]
struct ZkillZkb {
    hash: String,
}

/// The parts of an ESI killmail we use (cached verbatim — killmails never change).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Killmail {
    killmail_id: i64,
    victim: Victim,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Victim {
    #[serde(default)]
    ship_type_id: i64,
    #[serde(default)]
    items: Vec<KmItem>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
struct KmItem {
    item_type_id: i64,
    flag: i64,
    #[serde(default)]
    quantity_destroyed: i64,
    #[serde(default)]
    quantity_dropped: i64,
}

/// One fitted module on a lost fit, with the slot it sat in.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FitModule {
    pub type_id: i64,
    pub name: String,
    /// "high" | "mid" | "low" | "rig" | "subsystem" | "drone".
    pub slot: String,
    pub quantity: i64,
}

/// A hull the pilot has lost, with a representative (most-recent) fit.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LostFit {
    pub hull_type_id: i64,
    pub hull_name: String,
    pub lost_count: i64,
    pub killmail_id: i64,
    pub modules: Vec<FitModule>,
}

/// The fit slot an EVE inventory `flag` denotes, or `None` for non-fit items
/// (cargo, implants, …). Hi/Mid/Lo are the 8-slot ranges; rigs, subsystems and
/// the drone bay follow.
fn slot_of(flag: i64) -> Option<&'static str> {
    match flag {
        27..=34 => Some("high"),
        19..=26 => Some("mid"),
        11..=18 => Some("low"),
        92..=99 => Some("rig"),
        125..=132 => Some("subsystem"),
        87 => Some("drone"),
        _ => None,
    }
}

/// Aggregate a killmail's items into fitted modules `(type_id, slot, quantity)`,
/// summing identical (type, slot) entries (a drone stack, or several of one
/// module) and dropping non-fit items. Ordered hi→mid→low→rig→subsystem→drone.
fn modules_of(items: &[KmItem]) -> Vec<(i64, &'static str, i64)> {
    let mut agg: HashMap<(i64, &'static str), i64> = HashMap::new();
    for it in items {
        if let Some(slot) = slot_of(it.flag) {
            let qty = (it.quantity_destroyed + it.quantity_dropped).max(1);
            *agg.entry((it.item_type_id, slot)).or_default() += qty;
        }
    }
    let rank = |s: &str| match s {
        "high" => 0,
        "mid" => 1,
        "low" => 2,
        "rig" => 3,
        "subsystem" => 4,
        "drone" => 5,
        _ => 6,
    };
    let mut out: Vec<(i64, &'static str, i64)> =
        agg.into_iter().map(|((t, s), q)| (t, s, q)).collect();
    out.sort_by(|a, b| rank(a.1).cmp(&rank(b.1)).then(a.0.cmp(&b.0)));
    out
}

/// One pilot's lost fits: pull recent losses from zKill, fetch each killmail
/// from public ESI (cached permanently), group by hull, and return a
/// representative (most-recent) fit per hull with its modules by slot — ranked
/// by how often the hull was lost. Fetched lazily (only when a card is
/// expanded) so pasting many pilots stays cheap.
#[tauri::command]
pub async fn pvp_pilot_fits(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
    character_id: i64,
) -> Result<Vec<LostFit>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let http = auth_state.http();

    // Recent losses, newest first.
    let losses: Vec<ZkillRef> = async {
        http.get(format!(
            "https://zkillboard.com/api/losses/characterID/{character_id}/"
        ))
        .send()
        .await
        .ok()?
        .json()
        .await
        .ok()
    }
    .await
    .unwrap_or_default();

    // Fetch each killmail from public ESI (permanent cache), preserving order.
    let refs: Vec<ZkillRef> = losses.into_iter().take(LOSS_CAP).collect();
    let client = http.clone();
    let kms: Vec<Option<Killmail>> = stream::iter(refs)
        .map(|r| {
            let client = client.clone();
            let dir = dir.clone();
            async move {
                let key = format!("pvp_km_{}", r.killmail_id);
                if let Some(km) = storage::cache_get::<Killmail>(&dir, &key) {
                    return Some(km);
                }
                let url = format!(
                    "{ESI_BASE}/latest/killmails/{}/{}/",
                    r.killmail_id, r.zkb.hash
                );
                let km: Option<Killmail> =
                    async { client.get(&url).send().await.ok()?.json().await.ok() }.await;
                if let Some(k) = &km {
                    let _ = storage::cache_put(&dir, &key, k, KILLMAIL_TTL_SECS);
                }
                km
            }
        })
        .buffered(ZKILL_CONCURRENCY)
        .collect()
        .await;

    // Group by hull; the first (newest) killmail of each hull is its rep fit.
    let mut order: Vec<i64> = Vec::new();
    let mut rep: HashMap<i64, Killmail> = HashMap::new();
    let mut count: HashMap<i64, i64> = HashMap::new();
    for km in kms.into_iter().flatten() {
        let hull = km.victim.ship_type_id;
        if hull <= 0 {
            continue;
        }
        *count.entry(hull).or_default() += 1;
        if !rep.contains_key(&hull) {
            order.push(hull);
            rep.insert(hull, km);
        }
    }

    // Rank hulls by loss count (desc), keep the top few.
    order.sort_by(|a, b| count[b].cmp(&count[a]));
    order.truncate(LOST_HULL_CAP);

    // Resolve hull + module names in one SDE pass (opened after every await —
    // the handle isn't Send).
    let mut ids: HashSet<i64> = HashSet::new();
    for h in &order {
        ids.insert(*h);
        for it in &rep[h].victim.items {
            if slot_of(it.flag).is_some() {
                ids.insert(it.item_type_id);
            }
        }
    }
    let names: HashMap<i64, String> = {
        let ids: Vec<i64> = ids.into_iter().collect();
        let sde = Sde::open(&SdePaths::new(dir.clone()).db).map_err(|e| e.to_string())?;
        sde.type_names(&ids)
            .map_err(|e| e.to_string())?
            .into_iter()
            .collect()
    };
    let name_of = |id: i64| {
        names
            .get(&id)
            .cloned()
            .unwrap_or_else(|| format!("Type {id}"))
    };

    let fits: Vec<LostFit> = order
        .iter()
        .map(|h| {
            let km = &rep[h];
            let modules = modules_of(&km.victim.items)
                .into_iter()
                .map(|(tid, slot, qty)| FitModule {
                    type_id: tid,
                    name: name_of(tid),
                    slot: slot.to_string(),
                    quantity: qty,
                })
                .collect();
            LostFit {
                hull_type_id: *h,
                hull_name: name_of(*h),
                lost_count: count[h],
                killmail_id: km.killmail_id,
                modules,
            }
        })
        .collect();

    Ok(fits)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_names_trims_dedupes_and_caps() {
        let names = parse_names("  Alice \n\nBob\nalice\n Bob \n");
        // Case-insensitive dedup, order preserved, blanks dropped.
        assert_eq!(names, vec!["Alice".to_string(), "Bob".to_string()]);
    }

    #[test]
    fn raw_stats_map_to_surface_and_activepvp_sets_active() {
        let raw: ZkillStatsRaw = serde_json::from_str(
            r#"{
                "shipsDestroyed": 120, "shipsLost": 8,
                "iskDestroyed": 5.0e10, "iskLost": 2.0e9,
                "soloKills": 30, "soloLosses": 2,
                "dangerRatio": 88, "gangRatio": 40,
                "activepvp": { "ships": { "count": 3 } }
            }"#,
        )
        .unwrap();
        let s = stats_from_raw(42, "Hunter".into(), raw);
        assert_eq!(s.character_id, 42);
        assert_eq!(s.ships_destroyed, 120);
        assert_eq!(s.solo_kills, 30);
        assert_eq!(s.danger_ratio, 88);
        assert!(s.active);
    }

    #[test]
    fn missing_fields_default_and_no_activepvp_is_inactive() {
        // A pilot with no PvP: zKill omits the fields entirely.
        let raw: ZkillStatsRaw = serde_json::from_str("{}").unwrap();
        let s = stats_from_raw(7, "Carebear".into(), raw);
        assert_eq!(s.ships_destroyed, 0);
        assert_eq!(s.isk_destroyed, 0.0);
        assert!(!s.active);
    }

    #[test]
    fn top_ship_list_becomes_flown_hulls_capped_and_ordered() {
        // zKill returns the shipType top-list already sorted by kills desc,
        // alongside other lists we ignore. Rows without a shipTypeID are skipped.
        let raw: ZkillStatsRaw = serde_json::from_str(
            r#"{
                "topLists": [
                    { "type": "solarSystem", "values": [ { "solarSystemID": 1, "kills": 99 } ] },
                    { "type": "shipType", "values": [
                        { "shipTypeID": 670, "shipName": "Capsule", "kills": 50 },
                        { "shipTypeID": 11567, "shipName": "Avatar", "kills": 20 },
                        { "shipName": "Ghost", "kills": 5 }
                    ] }
                ]
            }"#,
        )
        .unwrap();
        let s = stats_from_raw(1, "Ace".into(), raw);
        // The zero-typeId row is dropped; order preserved.
        assert_eq!(s.hulls.len(), 2);
        assert_eq!(s.hulls[0].type_id, 670);
        assert_eq!(s.hulls[0].name, "Capsule");
        assert_eq!(s.hulls[0].kills, 50);
        assert_eq!(s.hulls[1].name, "Avatar");
    }

    #[test]
    fn no_top_lists_yields_no_hulls() {
        let raw: ZkillStatsRaw = serde_json::from_str("{}").unwrap();
        assert!(stats_from_raw(1, "x".into(), raw).hulls.is_empty());
    }

    #[test]
    fn slot_mapping_covers_fit_slots_only() {
        assert_eq!(slot_of(28), Some("high"));
        assert_eq!(slot_of(20), Some("mid"));
        assert_eq!(slot_of(12), Some("low"));
        assert_eq!(slot_of(93), Some("rig"));
        assert_eq!(slot_of(125), Some("subsystem"));
        assert_eq!(slot_of(87), Some("drone"));
        assert_eq!(slot_of(5), None); // cargo is not part of the fit
    }

    #[test]
    fn modules_reconstruct_by_slot_and_aggregate_stacks() {
        let km: Killmail = serde_json::from_str(
            r#"{
                "killmail_id": 1,
                "victim": {
                    "ship_type_id": 587,
                    "items": [
                        { "item_type_id": 100, "flag": 27, "quantity_destroyed": 1 },
                        { "item_type_id": 200, "flag": 19, "quantity_dropped": 1 },
                        { "item_type_id": 300, "flag": 87, "quantity_destroyed": 3, "quantity_dropped": 2 },
                        { "item_type_id": 999, "flag": 5, "quantity_dropped": 100 }
                    ]
                }
            }"#,
        )
        .unwrap();
        let mods = modules_of(&km.victim.items);
        // Cargo (flag 5) dropped; the drone stack sums to 5; order hi, mid, drone.
        assert_eq!(mods.len(), 3);
        assert_eq!(mods[0], (100, "high", 1));
        assert_eq!(mods[1], (200, "mid", 1));
        assert_eq!(mods[2], (300, "drone", 5));
    }
}
