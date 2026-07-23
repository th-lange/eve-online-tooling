//! PVP profiles — general zKillboard stats per pasted pilot (slice #532).

use std::collections::{HashMap, HashSet};

use futures_util::stream::{self, StreamExt};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::esi::{fetch_killmail, resolve_character_ids, AuthState};
use crate::modules::fitting::{simulate_fit, Fit, FitItem, FitStats, ModuleState, SlotKind};
use crate::sde::Sde;
use crate::storage;
use crate::zkill::{self, ZkillStatsRaw};

/// Cap on pasted names per lookup.
const NAME_CAP: usize = 128;

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

/// Pods and shuttles aren't real PvP hulls — drop them from every hull list.
/// Matches by name (English, as zKill/SDE return it): covers "Capsule",
/// the Genolution capsule variants, and every faction shuttle.
fn is_junk_hull(name: &str) -> bool {
    name.contains("Capsule") || name.contains("Shuttle")
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
                .filter(|s| s.ship_type_id > 0 && !is_junk_hull(&s.ship_name))
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
        active: r.active(),
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
    let dir = crate::storage::app_data_dir(&app)?;
    let lower = |n: &str| n.to_lowercase();

    let id_cache = resolve_character_ids(http, Some(&dir), &names).await;

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

    let ids: Vec<i64> = resolved.iter().map(|(id, _)| *id).collect();
    let mut raw_by_id: HashMap<i64, ZkillStatsRaw> = zkill::stats_for_characters(&dir, &ids)
        .await?
        .into_iter()
        .collect();

    // Reassemble in pasted order (dropping pilots whose zKill fetch failed).
    let pilots: Vec<PvpStats> = resolved
        .into_iter()
        .filter_map(|(id, name)| raw_by_id.remove(&id).map(|r| stats_from_raw(id, name, r)))
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

/// The parts of an ESI killmail we use (cached verbatim — killmails never change).
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Killmail {
    killmail_id: i64,
    #[serde(default)]
    killmail_time: String,
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
    /// ISO-8601 timestamp of the representative (most-recent) loss — when the
    /// pilot last flew this hull.
    pub last_lost: String,
    pub modules: Vec<FitModule>,
    /// All-V dogma analysis of this fit (`None` if the engine couldn't run).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub analysis: Option<FitAnalysis>,
}

/// One weapon's engagement envelope from the dogma engine.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WeaponLine {
    pub name: String,
    /// Optimal range (m); for missiles this is flight range (falloff 0).
    pub optimal: f64,
    pub falloff: f64,
}

/// Dogma-engine read of a reconstructed fit, at all-V (skills unknown), so
/// ranges and damage are an upper-bound estimate.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FitAnalysis {
    pub ehp: f64,
    pub dps_total: f64,
    pub dps_turret: f64,
    pub dps_missile: f64,
    pub dps_drone: f64,
    /// Max warp scramble/disruption range (m) across the fit's tackle, if any.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scram_range: Option<f64>,
    pub weapons: Vec<WeaponLine>,
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

/// The fit slot + 0-based index within it for an inventory `flag`, or `None`
/// for non-fit items. Unlike [`slot_of`], this keeps each physical slot distinct
/// (so the engine sees 8 separate highs, not one aggregate).
fn slot_index(flag: i64) -> Option<(SlotKind, i32)> {
    match flag {
        27..=34 => Some((SlotKind::High, (flag - 27) as i32)),
        19..=26 => Some((SlotKind::Mid, (flag - 19) as i32)),
        11..=18 => Some((SlotKind::Low, (flag - 11) as i32)),
        92..=99 => Some((SlotKind::Rig, (flag - 92) as i32)),
        125..=132 => Some((SlotKind::Subsystem, (flag - 125) as i32)),
        87 => Some((SlotKind::Drone, 0)),
        _ => None,
    }
}

/// Build the dogma-engine input from a killmail's items: one `FitItem` per
/// physical slot, pairing a loaded charge (category 8) to the weapon sharing its
/// slot flag, and expanding drone stacks. `cat_of` gives a type's category id.
fn build_engine_fit(hull: i64, items: &[KmItem], cat_of: &dyn Fn(i64) -> i64) -> Fit {
    use std::collections::BTreeMap;
    let mut by_flag: BTreeMap<i64, Vec<&KmItem>> = BTreeMap::new();
    for it in items {
        if slot_index(it.flag).is_some() {
            by_flag.entry(it.flag).or_default().push(it);
        }
    }
    let mut fit_items: Vec<FitItem> = Vec::new();
    let mut drone_idx = 0i32;
    for (flag, group) in &by_flag {
        let Some((kind, index)) = slot_index(*flag) else {
            continue;
        };
        if kind == SlotKind::Drone {
            for it in group {
                fit_items.push(FitItem {
                    type_id: it.item_type_id,
                    slot: SlotKind::Drone,
                    index: drone_idx,
                    state: ModuleState::Active,
                    charge_type_id: None,
                    quantity: (it.quantity_destroyed + it.quantity_dropped).max(1) as i32,
                    active_drones: None,
                });
                drone_idx += 1;
            }
            continue;
        }
        // A single slot: one module, optionally with its loaded charge (cat 8).
        let mut module: Option<i64> = None;
        let mut charge: Option<i64> = None;
        for it in group {
            if cat_of(it.item_type_id) == 8 {
                charge = Some(it.item_type_id);
            } else if module.is_none() {
                module = Some(it.item_type_id);
            }
        }
        if let Some(m) = module {
            fit_items.push(FitItem {
                type_id: m,
                slot: kind,
                index,
                state: ModuleState::Active,
                charge_type_id: charge,
                quantity: 1,
                active_drones: None,
            });
        }
    }
    Fit {
        id: String::new(),
        name: String::new(),
        ship_type_id: hull,
        items: fit_items,
        projected: Vec::new(),
    }
}

/// Warp scramble/disruption range = dogma attribute 103 (`warpScrambleRange`),
/// a static module attribute skills don't change.
const ATTR_WARP_SCRAMBLE_RANGE: i64 = 103;

/// Assemble the PVP fit analysis from the engine's [`FitStats`] plus the scram
/// range (read from raw attributes — the engine doesn't surface tackle range).
fn analysis_from_stats(
    stats: &FitStats,
    attrs: &HashMap<i64, Vec<(i64, f64)>>,
    fit: &Fit,
    name_of: &dyn Fn(i64) -> String,
) -> FitAnalysis {
    let scram_range = fit
        .items
        .iter()
        .filter_map(|it| {
            attrs.get(&it.type_id).and_then(|a| {
                a.iter()
                    .find(|(id, _)| *id == ATTR_WARP_SCRAMBLE_RANGE)
                    .map(|(_, v)| *v)
            })
        })
        .filter(|v| *v > 0.0)
        .fold(None, |acc: Option<f64>, v| {
            Some(acc.map_or(v, |m| m.max(v)))
        });
    let weapons = stats
        .weapon_ranges
        .iter()
        .map(|w| WeaponLine {
            name: name_of(w.type_id),
            optimal: w.optimal,
            falloff: w.falloff,
        })
        .collect();
    let dps = stats.dps.as_ref();
    FitAnalysis {
        ehp: stats.tank.as_ref().map(|t| t.ehp).unwrap_or(0.0),
        dps_total: dps.map(|d| d.total).unwrap_or(0.0),
        dps_turret: dps.map(|d| d.turret).unwrap_or(0.0),
        dps_missile: dps.map(|d| d.missile).unwrap_or(0.0),
        dps_drone: dps.map(|d| d.drone).unwrap_or(0.0),
        scram_range,
        weapons,
    }
}

/// Reconstruct one killmail into a displayable + analysed lost fit: names,
/// module list by slot, and the all-V dogma analysis. `lost_count` is how many
/// times the hull was seen (or a community sample size, for typical fits).
fn build_lost_fit(sde: &Sde, km: &Killmail, lost_count: i64) -> LostFit {
    let mut ids: Vec<i64> = vec![km.victim.ship_type_id];
    for it in &km.victim.items {
        if slot_of(it.flag).is_some() {
            ids.push(it.item_type_id);
        }
    }
    let names = sde.type_name_map(&ids).unwrap_or_default();
    let name_of = |id: i64| names.get(id);
    let attrs = sde.types_attributes_raw(&ids).unwrap_or_default();
    let cats = sde.types_categories(&ids).unwrap_or_default();
    let cat_of = |id: i64| cats.get(&id).copied().unwrap_or(0);

    let modules = modules_of(&km.victim.items)
        .into_iter()
        .map(|(tid, slot, qty)| FitModule {
            type_id: tid,
            name: name_of(tid),
            slot: slot.to_string(),
            quantity: qty,
        })
        .collect();
    let fit = build_engine_fit(km.victim.ship_type_id, &km.victim.items, &cat_of);
    let analysis = simulate_fit(sde, &fit, &|_| 5.0, None, None, None, None)
        .ok()
        .map(|s| analysis_from_stats(&s, &attrs, &fit, &name_of));
    LostFit {
        hull_type_id: km.victim.ship_type_id,
        hull_name: name_of(km.victim.ship_type_id),
        lost_count,
        killmail_id: km.killmail_id,
        last_lost: km.killmail_time.clone(),
        modules,
        analysis,
    }
}

/// Community losses to sample when guessing a hull's typical fit.
const TYPICAL_SAMPLE: usize = 25;

/// Fetch each referenced killmail from public ESI (permanent cache), in input
/// order, dropping any that fail. Low concurrency for zKill/ESI etiquette.
async fn fetch_killmails(
    http: &reqwest::Client,
    dir: &std::path::Path,
    refs: Vec<zkill::ZkillLossRef>,
) -> Vec<Killmail> {
    let client = http.clone();
    let dir = dir.to_path_buf();
    stream::iter(refs)
        .map(|r| {
            let client = client.clone();
            let dir = dir.clone();
            async move {
                let key = format!("pvp_km_{}", r.killmail_id);
                if let Some(km) = storage::cache_get::<Killmail>(&dir, &key) {
                    return Some(km);
                }
                let km: Option<Killmail> =
                    fetch_killmail(&client, r.killmail_id, &r.zkb.hash).await;
                if let Some(k) = &km {
                    let _ = storage::cache_put(&dir, &key, k, KILLMAIL_TTL_SECS);
                }
                km
            }
        })
        .buffered(zkill::ZKILL_CONCURRENCY)
        .collect::<Vec<Option<Killmail>>>()
        .await
        .into_iter()
        .flatten()
        .collect()
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
    let dir = crate::storage::app_data_dir(&app)?;
    let http = auth_state.http();

    // Recent losses, newest first.
    let losses = zkill::losses_for_character(character_id).await;

    // Fetch each killmail from public ESI (permanent cache), newest first.
    let refs: Vec<zkill::ZkillLossRef> = losses.into_iter().take(LOSS_CAP).collect();
    let kms = fetch_killmails(http, &dir, refs).await;

    // Group by hull; the first (newest) killmail of each hull is its rep fit.
    let mut order: Vec<i64> = Vec::new();
    let mut rep: HashMap<i64, Killmail> = HashMap::new();
    let mut count: HashMap<i64, i64> = HashMap::new();
    for km in kms {
        let hull = km.victim.ship_type_id;
        if hull <= 0 {
            continue;
        }
        *count.entry(hull).or_default() += 1;
        if let std::collections::hash_map::Entry::Vacant(e) = rep.entry(hull) {
            order.push(hull);
            e.insert(km);
        }
    }

    // One SDE pass (kept open — everything below is sync). Hull names first, to
    // drop pods/shuttles before ranking; per-fit detail is built per killmail.
    let sde = crate::sde::open_from_app(&app)?;
    let hull_ids: Vec<i64> = rep.keys().copied().collect();
    let hull_names: HashMap<i64, String> = sde
        .type_names(&hull_ids)
        .map_err(|e| e.to_string())?
        .into_iter()
        .collect();

    // Drop pods/shuttles, rank by loss count, keep the top few.
    order.retain(|h| !is_junk_hull(hull_names.get(h).map(String::as_str).unwrap_or("")));
    order.sort_by(|a, b| count[b].cmp(&count[a]));
    order.truncate(LOST_HULL_CAP);

    let fits: Vec<LostFit> = order
        .iter()
        .map(|h| build_lost_fit(&sde, &rep[h], count[h]))
        .collect();

    Ok(fits)
}

/// A typical (community) fit for a hull: sample recent zKill losses of the ship
/// type, reconstruct the most-recent one and analyse it (all-V). For hulls a
/// pilot flies but we've never seen them lose — clearly a community fit, not
/// theirs. `None` when the hull has no recent public losses.
#[tauri::command]
pub async fn pvp_typical_fit(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
    hull_type_id: i64,
) -> Result<Option<LostFit>, String> {
    let dir = crate::storage::app_data_dir(&app)?;
    let http = auth_state.http();

    // Recent community losses of this hull, newest first.
    let losses = zkill::losses_for_ship_type(hull_type_id).await;

    let refs: Vec<zkill::ZkillLossRef> = losses.into_iter().take(TYPICAL_SAMPLE).collect();
    let sampled = refs.len() as i64;
    let kms = fetch_killmails(http, &dir, refs).await;

    // The most-recent sampled loss that is actually this hull and carries a fit.
    let Some(km) = kms
        .into_iter()
        .find(|k| k.victim.ship_type_id == hull_type_id && !k.victim.items.is_empty())
    else {
        return Ok(None);
    };

    let sde = crate::sde::open_from_app(&app)?;
    Ok(Some(build_lost_fit(&sde, &km, sampled)))
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
    fn flown_hulls_drop_pods_shuttles_and_idless_rows() {
        // zKill returns the shipType list sorted by kills desc, alongside other
        // lists we ignore. Capsules, shuttles and id-less rows all drop.
        let raw: ZkillStatsRaw = serde_json::from_str(
            r#"{
                "topLists": [
                    { "type": "solarSystem", "values": [ { "solarSystemID": 1, "kills": 99 } ] },
                    { "type": "shipType", "values": [
                        { "shipTypeID": 670, "shipName": "Capsule", "kills": 90 },
                        { "shipTypeID": 587, "shipName": "Rifter", "kills": 50 },
                        { "shipTypeID": 11129, "shipName": "Gallente Shuttle", "kills": 12 },
                        { "shipTypeID": 621, "shipName": "Caracal", "kills": 8 },
                        { "shipName": "Ghost", "kills": 5 }
                    ] }
                ]
            }"#,
        )
        .unwrap();
        let s = stats_from_raw(1, "Ace".into(), raw);
        // Capsule + Shuttle + id-less rows gone; real hulls kept in order.
        assert_eq!(
            s.hulls.iter().map(|h| h.name.as_str()).collect::<Vec<_>>(),
            vec!["Rifter", "Caracal"]
        );
        assert_eq!(s.hulls[0].kills, 50);
    }

    #[test]
    fn is_junk_hull_matches_pods_and_shuttles() {
        assert!(is_junk_hull("Capsule"));
        assert!(is_junk_hull("Capsule - Genolution 'Auroral' 197-variant"));
        assert!(is_junk_hull("Gallente Shuttle"));
        assert!(!is_junk_hull("Rifter"));
        assert!(!is_junk_hull("Ares"));
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

    #[test]
    fn engine_fit_pairs_charges_indexes_slots_and_expands_drones() {
        let items = vec![
            KmItem {
                item_type_id: 100,
                flag: 27,
                quantity_destroyed: 1,
                quantity_dropped: 0,
            },
            KmItem {
                item_type_id: 200,
                flag: 27,
                quantity_destroyed: 0,
                quantity_dropped: 50,
            },
            KmItem {
                item_type_id: 300,
                flag: 11,
                quantity_destroyed: 1,
                quantity_dropped: 0,
            },
            KmItem {
                item_type_id: 400,
                flag: 87,
                quantity_destroyed: 3,
                quantity_dropped: 2,
            },
            KmItem {
                item_type_id: 999,
                flag: 5,
                quantity_destroyed: 0,
                quantity_dropped: 1,
            },
        ];
        // Type 200 is the loaded charge (category 8); everything else a module.
        let cat_of = |id: i64| if id == 200 { 8 } else { 0 };
        let fit = build_engine_fit(587, &items, &cat_of);
        assert_eq!(fit.ship_type_id, 587);
        // Launcher in hi0 with the missiles paired as its charge.
        let hi = fit.items.iter().find(|i| i.slot == SlotKind::High).unwrap();
        assert_eq!(hi.type_id, 100);
        assert_eq!(hi.index, 0);
        assert_eq!(hi.charge_type_id, Some(200));
        // Low module kept; drone stack expanded to a single 5-count entry.
        assert!(fit
            .items
            .iter()
            .any(|i| i.slot == SlotKind::Low && i.type_id == 300));
        let drones: Vec<_> = fit
            .items
            .iter()
            .filter(|i| i.slot == SlotKind::Drone)
            .collect();
        assert_eq!(drones.len(), 1);
        assert_eq!(drones[0].quantity, 5);
        // Cargo (flag 5) never enters the fit.
        assert!(!fit.items.iter().any(|i| i.type_id == 999));
    }

    #[test]
    fn analysis_reads_scram_range_from_attributes() {
        let fit = Fit {
            id: String::new(),
            name: String::new(),
            ship_type_id: 587,
            items: vec![FitItem {
                type_id: 5,
                slot: SlotKind::Mid,
                index: 0,
                state: ModuleState::Active,
                charge_type_id: None,
                quantity: 1,
                active_drones: None,
            }],
            projected: vec![],
        };
        // A warp scrambler: dogma attr 103 = 9000m point range.
        let mut attrs: HashMap<i64, Vec<(i64, f64)>> = HashMap::new();
        attrs.insert(5, vec![(103, 9000.0)]);
        let name_of = |_id: i64| "x".to_string();
        let a = analysis_from_stats(&FitStats::default(), &attrs, &fit, &name_of);
        assert_eq!(a.scram_range, Some(9000.0));
        assert_eq!(a.ehp, 0.0);
        assert!(a.weapons.is_empty());
    }
}
