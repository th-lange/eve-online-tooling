//! Route module — per-system activity overlay (jumps + ship/pod/npc kills in
//! the last hour), from CCP's hourly aggregates. K-space only: wormhole systems
//! are excluded from these ESI endpoints, so they never appear here.
//!
//! These feed the route map / neighbour view (#99/#101); on their own they are a
//! sortable "where's the action / where's the danger" system table.

use std::collections::{HashMap, HashSet, VecDeque};
use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::esi::{authed_get, AuthState, EsiClient};
use crate::model::AppError;
use crate::sde::{Sde, SdePaths};
use crate::storage;

/// J-space (wormhole) solar systems start at this id.
const WSPACE_MIN_SYSTEM_ID: i64 = 31_000_000;
/// Keep at most this many breadcrumb hops.
const BREADCRUMB_CAP: usize = 300;

/// Max neighbourhood BFS depth (jumps out from the centre).
const MAX_DEPTH: i64 = 5;

/// Cache TTL for the merged activity — CCP refreshes these hourly, so half an
/// hour keeps it fresh without hammering ESI on every view switch.
const ACTIVITY_TTL_SECS: u64 = 1800;

#[derive(Deserialize)]
struct EsiJumps {
    system_id: i64,
    ship_jumps: i64,
}

#[derive(Deserialize)]
struct EsiKills {
    system_id: i64,
    ship_kills: i64,
    pod_kills: i64,
    npc_kills: i64,
}

/// Last-hour activity for one solar system, joined with SDE name/security/region.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemActivity {
    pub system_id: i64,
    pub name: String,
    pub region: String,
    /// Raw SDE security status (−1.0 … 1.0).
    pub security: f64,
    pub jumps: i64,
    pub ship_kills: i64,
    pub pod_kills: i64,
    pub npc_kills: i64,
}

/// Merge the jumps + kills aggregates into a per-system map. Pure (no I/O) so it
/// can be unit-tested; a system appears if it has *either* jumps or kills.
fn merge_activity(jumps: &[EsiJumps], kills: &[EsiKills]) -> HashMap<i64, SystemActivity> {
    let mut map: HashMap<i64, SystemActivity> = HashMap::new();
    for j in jumps {
        let e = map.entry(j.system_id).or_default();
        e.system_id = j.system_id;
        e.jumps = j.ship_jumps;
    }
    for k in kills {
        let e = map.entry(k.system_id).or_default();
        e.system_id = k.system_id;
        e.ship_kills = k.ship_kills;
        e.pod_kills = k.pod_kills;
        e.npc_kills = k.npc_kills;
    }
    map
}

/// Build the system-id → activity map: serve the ~30-min cache, else fetch the
/// jumps + kills aggregates, enrich with SDE name/security/region, and cache.
/// Shared by the activity table and the neighbourhood view.
async fn activity_map(
    dir: &Path,
    esi: &EsiClient,
    refresh: bool,
) -> Result<HashMap<i64, SystemActivity>, String> {
    if !refresh {
        if let Some(cached) = storage::cache_get::<Vec<SystemActivity>>(dir, "system_activity") {
            return Ok(cached.into_iter().map(|r| (r.system_id, r)).collect());
        }
    }

    let jumps: Vec<EsiJumps> = esi
        .get_json("/latest/universe/system_jumps/", &[])
        .await
        .map_err(|e| e.to_string())?;
    let kills: Vec<EsiKills> = esi
        .get_json("/latest/universe/system_kills/", &[])
        .await
        .map_err(|e| e.to_string())?;

    let mut activity = merge_activity(&jumps, &kills);

    // Enrich with SDE name / security / region (k-space systems only).
    let sde = Sde::open(&SdePaths::new(dir.to_path_buf()).db).map_err(|e| e.to_string())?;
    let info = sde.solar_system_info().map_err(|e| e.to_string())?;
    for row in activity.values_mut() {
        if let Some((name, security, region)) = info.get(&row.system_id) {
            row.name = name.clone();
            row.security = *security;
            row.region = region.clone();
        }
    }

    let rows: Vec<SystemActivity> = activity.values().cloned().collect();
    let _ = storage::cache_put(dir, "system_activity", &rows, ACTIVITY_TTL_SECS);
    Ok(activity)
}

/// Per-system jumps + kills over the last hour, enriched with SDE names. Cached
/// (~30 min) to match CCP's hourly refresh; `refresh = true` bypasses the cache.
#[tauri::command]
pub async fn system_activity(
    app: AppHandle,
    esi: State<'_, EsiClient>,
    refresh: bool,
) -> Result<Vec<SystemActivity>, String> {
    let dir = crate::storage::app_data_dir(&app)?;
    let mut rows: Vec<SystemActivity> = activity_map(&dir, &esi, refresh)
        .await?
        .into_values()
        .collect();
    // Default ordering: busiest first (the UI re-sorts).
    rows.sort_by_key(|r| std::cmp::Reverse(r.jumps));
    Ok(rows)
}

/// Search solar systems by name (for the neighbourhood picker).
#[tauri::command]
pub fn system_search(app: AppHandle, query: String) -> Result<Vec<SystemMatch>, String> {
    if query.trim().len() < 2 {
        return Ok(Vec::new());
    }
    let sde = crate::sde::open_from_app(&app)?;
    Ok(sde
        .search_systems(&query, 20)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|(id, name)| SystemMatch { id, name })
        .collect())
}

/// A node in the neighbourhood: a system + its distance (jumps) from the centre,
/// flattened with its last-hour activity.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NeighbourNode {
    /// Jumps from the centre (0 = the centre system itself).
    pub distance: i64,
    #[serde(flatten)]
    pub activity: SystemActivity,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemMatch {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Neighbourhood {
    pub center: i64,
    pub nodes: Vec<NeighbourNode>,
    /// Stargate edges `[a, b]` between systems in the neighbourhood (deduped).
    pub edges: Vec<[i64; 2]>,
}

/// The stargate neighbourhood around a system out to `depth` jumps, each node
/// carrying its last-hour jumps/kills heat. The "fog-of-war" view; until the
/// location scope lands (#99) the centre is chosen by search rather than auto.
#[tauri::command]
pub async fn system_neighbourhood(
    app: AppHandle,
    esi: State<'_, EsiClient>,
    system_id: i64,
    depth: i64,
) -> Result<Neighbourhood, String> {
    let (dir, sde) = crate::sde::dir_and_sde(&app)?;
    let depth = depth.clamp(1, MAX_DEPTH);

    // BFS over stargate edges, recording distance and deduped edges.
    let mut distance: HashMap<i64, i64> = HashMap::from([(system_id, 0)]);
    let mut frontier = vec![system_id];
    let mut edges: HashSet<(i64, i64)> = HashSet::new();
    for level in 1..=depth {
        let mut next = Vec::new();
        for (a, b) in sde
            .stargate_edges_from(&frontier)
            .map_err(|e| e.to_string())?
        {
            edges.insert(if a <= b { (a, b) } else { (b, a) });
            if let std::collections::hash_map::Entry::Vacant(e) = distance.entry(b) {
                e.insert(level);
                next.push(b);
            }
        }
        frontier = next;
        if frontier.is_empty() {
            break;
        }
    }

    // Heat + names for every system in the neighbourhood.
    let activity = activity_map(&dir, &esi, false).await.unwrap_or_default();
    let info = sde.solar_system_info().map_err(|e| e.to_string())?;
    let mut nodes: Vec<NeighbourNode> = distance
        .iter()
        .map(|(&sid, &dist)| {
            let mut act = activity.get(&sid).cloned().unwrap_or_default();
            act.system_id = sid;
            if act.name.is_empty() {
                if let Some((name, security, region)) = info.get(&sid) {
                    act.name = name.clone();
                    act.security = *security;
                    act.region = region.clone();
                }
            }
            NeighbourNode {
                distance: dist,
                activity: act,
            }
        })
        .collect();
    // Centre first, then by distance, then busiest.
    nodes.sort_by(|a, b| {
        a.distance
            .cmp(&b.distance)
            .then_with(|| b.activity.jumps.cmp(&a.activity.jumps))
    });

    Ok(Neighbourhood {
        center: system_id,
        nodes,
        edges: edges.into_iter().map(|(a, b)| [a, b]).collect(),
    })
}

// --- Travel breadcrumb (#99) ---

#[derive(Deserialize)]
struct EsiLocation {
    solar_system_id: i64,
}

/// One hop on the travel trail (k-space or wormhole).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BreadcrumbEntry {
    pub system_id: i64,
    pub name: String,
    pub security: f64,
    pub region: String,
    /// True for a wormhole (J-space) system.
    pub wspace: bool,
    /// Unix seconds this system was first recorded on this leg.
    pub entered_at: u64,
    /// Gate jumps from the previous trail entry: 1 = direct gate, >1 = systems
    /// were skipped between location polls, -1 = no gate path (wormhole /
    /// filament / clone jump), 0 = unknown (trail start, or an entry recorded
    /// before this field existed).
    #[serde(default)]
    pub gap_jumps: i64,
}

/// Undirected stargate adjacency for gate-distance checks.
fn gate_adjacency(sde: &Sde) -> Result<HashMap<i64, Vec<i64>>, String> {
    let mut adj: HashMap<i64, Vec<i64>> = HashMap::new();
    for (a, b) in sde.all_stargate_edges().map_err(|e| e.to_string())? {
        adj.entry(a).or_default().push(b);
        adj.entry(b).or_default().push(a);
    }
    Ok(adj)
}

/// Gate distance between two systems (BFS over `adj`), or -1 when unreachable
/// by gates. Capped: anything beyond `cap` also reports -1, so a runaway search
/// on disconnected inputs stays cheap.
fn gate_distance_over(adj: &HashMap<i64, Vec<i64>>, from: i64, to: i64, cap: i64) -> i64 {
    if from == to {
        return 0;
    }
    let mut dist: HashMap<i64, i64> = HashMap::from([(from, 0)]);
    let mut queue = std::collections::VecDeque::from([from]);
    while let Some(u) = queue.pop_front() {
        let du = dist[&u];
        if du >= cap {
            continue;
        }
        for &v in adj.get(&u).into_iter().flatten() {
            if v == to {
                return du + 1;
            }
            if let std::collections::hash_map::Entry::Vacant(e) = dist.entry(v) {
                e.insert(du + 1);
                queue.push_back(v);
            }
        }
    }
    -1
}

/// [`gate_distance_over`] with a one-shot adjacency build. Returns 0
/// ("unknown") on SDE trouble rather than inventing a gap.
fn gate_distance(sde: &Sde, from: i64, to: i64, cap: i64) -> i64 {
    match gate_adjacency(sde) {
        Ok(adj) => gate_distance_over(&adj, from, to, cap),
        Err(_) => 0,
    }
}

fn breadcrumb_key(app: &AppHandle) -> Result<(std::path::PathBuf, i64, String), AppError> {
    let (dir, character_id) = storage::dir_and_primary_character(app)?;
    let key = format!("route_breadcrumb_{character_id}");
    Ok((dir, character_id, key))
}

/// Poll the character's current system and append it to the travel trail (dedup
/// consecutive same-system hits). The frontend calls this on an interval while
/// the Route view is open — there's no travel-history API, so the trail is the
/// recorded sequence. Works in w-space (the J-system id is returned). Requires
/// `esi-location.read_location.v1`.
#[tauri::command]
pub async fn route_location(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
) -> Result<Vec<BreadcrumbEntry>, AppError> {
    let (dir, character_id, key) = breadcrumb_key(&app)?;
    let loc: EsiLocation = authed_get(
        &auth_state,
        character_id,
        &format!("/latest/characters/{character_id}/location/"),
    )
    .await
    .map_err(|e| e.to_string())?;

    let mut trail: Vec<BreadcrumbEntry> = storage::load_data(&dir, &key).unwrap_or_default();
    // Only append when the system actually changed (dedupe rest-in-system polls).
    if trail.last().map(|e| e.system_id) != Some(loc.solar_system_id) {
        let sde = crate::sde::open_from_app(&app)?;
        let info = sde.solar_system_info().map_err(|e| e.to_string())?;
        let (name, security, region) = info
            .get(&loc.solar_system_id)
            .cloned()
            .unwrap_or_else(|| (format!("J{}", loc.solar_system_id), 0.0, String::new()));
        // Gate distance from the previous entry, so the travel graph can tell a
        // real gate hop (1) from a leg where polling skipped systems (>1) or
        // non-gate travel like a wormhole/filament (-1). W-space endpoints have
        // no gate graph — mark those -1 directly.
        let wspace = loc.solar_system_id >= WSPACE_MIN_SYSTEM_ID;
        let gap_jumps = match trail.last() {
            None => 0,
            Some(prev) if prev.wspace || wspace => -1,
            Some(prev) => gate_distance(&sde, prev.system_id, loc.solar_system_id, 30),
        };
        trail.push(BreadcrumbEntry {
            system_id: loc.solar_system_id,
            name,
            security,
            region,
            wspace,
            entered_at: crate::util::time::now_secs(),
            gap_jumps,
        });
        if trail.len() > BREADCRUMB_CAP {
            let excess = trail.len() - BREADCRUMB_CAP;
            trail.drain(0..excess);
        }
        let _ = storage::save_data(&dir, &key, &trail);
    }
    Ok(trail)
}

/// The stored travel trail without polling ESI. Entries recorded before
/// `gap_jumps` existed are backfilled here (and persisted), so old trails also
/// render honestly — solid lines only where the hop really was one gate.
#[tauri::command]
pub fn route_breadcrumb(app: AppHandle) -> Result<Vec<BreadcrumbEntry>, AppError> {
    let (dir, _id, key) = breadcrumb_key(&app)?;
    let mut trail: Vec<BreadcrumbEntry> = storage::load_data(&dir, &key).unwrap_or_default();
    if trail.iter().skip(1).any(|e| e.gap_jumps == 0) {
        if let Ok(sde) = crate::sde::open_from_app(&app) {
            if let Ok(adj) = gate_adjacency(&sde) {
                for i in 1..trail.len() {
                    if trail[i].gap_jumps != 0 {
                        continue;
                    }
                    let prev = trail[i - 1].clone();
                    let cur = &mut trail[i];
                    cur.gap_jumps = if prev.wspace || cur.wspace {
                        -1
                    } else {
                        gate_distance_over(&adj, prev.system_id, cur.system_id, 30)
                    };
                }
                let _ = storage::save_data(&dir, &key, &trail);
            }
        }
    }
    Ok(trail)
}

/// Clear the travel trail.
#[tauri::command]
pub fn route_clear_breadcrumb(app: AppHandle) -> Result<(), AppError> {
    let (dir, _id, key) = breadcrumb_key(&app)?;
    storage::save_data(&dir, &key, &Vec::<BreadcrumbEntry>::new()).map_err(AppError::from)
}

// --- Nearest wormhole (#298) ---

/// Nearest target from `origin` over an unweighted adjacency (BFS): returns the
/// first target system reached and its distance in jumps, or `None` if none is
/// reachable. Pure (testable).
fn nearest_of(
    adj: &HashMap<i64, Vec<i64>>,
    origin: i64,
    targets: &HashSet<i64>,
) -> Option<(i64, i64)> {
    if targets.contains(&origin) {
        return Some((origin, 0));
    }
    let mut visited: HashSet<i64> = HashSet::from([origin]);
    let mut queue: VecDeque<(i64, i64)> = VecDeque::from([(origin, 0)]);
    while let Some((cur, dist)) = queue.pop_front() {
        for &next in adj.get(&cur).into_iter().flatten() {
            if visited.insert(next) {
                if targets.contains(&next) {
                    return Some((next, dist + 1));
                }
                queue.push_back((next, dist + 1));
            }
        }
    }
    None
}

/// The nearest public wormhole entrance, or (in w-space) the nearest scanned exit.
///
/// Honest about the constraint: ESI cannot reveal an *un-scanned* signature's
/// location, so from k-space we point at the nearest *known* public (EVE-Scout
/// Thera/Turnur) entrance rather than "the next wormhole in this system".
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NearestWormhole {
    pub found: bool,
    /// Constraint note / hint shown when nothing usable was found.
    pub message: Option<String>,
    /// True when the character is in w-space (uses the mapped-chain fallback).
    pub in_wspace: bool,
    pub current_system_id: i64,
    pub current_name: String,
    /// System to travel to: the WH entrance (k-space) or the chain exit (w-space).
    pub entrance_system_id: i64,
    pub entrance_name: String,
    pub jumps: i64,
    pub wh_type: Option<String>,
    pub max_ship_size: Option<String>,
    /// System the hole leads into (Thera/Turnur for a public entrance).
    pub into_system_id: Option<i64>,
    pub into_name: Option<String>,
    pub expires_in_hours: Option<f64>,
}

fn nearest_none(
    current_system_id: i64,
    current_name: String,
    in_wspace: bool,
    message: &str,
) -> NearestWormhole {
    NearestWormhole {
        found: false,
        message: Some(message.to_string()),
        in_wspace,
        current_system_id,
        current_name,
        entrance_system_id: 0,
        entrance_name: String::new(),
        jumps: 0,
        wh_type: None,
        max_ship_size: None,
        into_system_id: None,
        into_name: None,
        expires_in_hours: None,
    }
}

/// From the character's last-recorded system, find the nearest known public
/// wormhole entrance (EVE-Scout) reachable by stargate. In w-space, fall back to
/// the nearest scanned exit to k-space over the mapped chain. Reads the travel
/// breadcrumb for "where am I" (populate it via "My location"); no ESI auth here.
#[tauri::command]
pub async fn route_nearest_wormhole(app: AppHandle) -> Result<NearestWormhole, AppError> {
    let (dir, sde) = crate::sde::dir_and_sde(&app)?;
    let (_dir, _id, key) = breadcrumb_key(&app)?;
    let trail: Vec<BreadcrumbEntry> = storage::load_data(&dir, &key).unwrap_or_default();
    let current = match trail.last() {
        Some(e) => e.clone(),
        None => {
            return Ok(nearest_none(
                0,
                String::new(),
                false,
                "Use “My location” first so we know where you are.",
            ))
        }
    };

    let info = sde.solar_system_info().map_err(|e| e.to_string())?;
    let name_of = |id: i64| {
        info.get(&id)
            .map(|(n, _, _)| n.clone())
            .unwrap_or_else(|| format!("J{id}"))
    };

    if current.wspace {
        // w-space: no public feed applies; point at the nearest scanned k-space
        // exit over the hand-mapped chain.
        let edges = crate::modules::wormholes::store::connection_edges(&app)?;
        let mut adj: HashMap<i64, Vec<i64>> = HashMap::new();
        for (a, b, _eol) in &edges {
            adj.entry(*a).or_default().push(*b);
            adj.entry(*b).or_default().push(*a);
        }
        let exits: HashSet<i64> = adj
            .keys()
            .copied()
            .filter(|id| *id < WSPACE_MIN_SYSTEM_ID)
            .collect();
        return Ok(match nearest_of(&adj, current.system_id, &exits) {
            Some((exit, jumps)) => NearestWormhole {
                found: true,
                message: Some("Nearest scanned exit to k-space in your chain.".into()),
                in_wspace: true,
                current_system_id: current.system_id,
                current_name: current.name.clone(),
                entrance_system_id: exit,
                entrance_name: name_of(exit),
                jumps,
                wh_type: None,
                max_ship_size: None,
                into_system_id: None,
                into_name: None,
                expires_in_hours: None,
            },
            None => nearest_none(
                current.system_id,
                current.name.clone(),
                true,
                "No mapped exit to k-space — scan and add your chain first.",
            ),
        });
    }

    // k-space: nearest public Thera/Turnur entrance over stargates.
    let sigs = crate::evescout::fetch_signatures(&dir).await?;
    let mut cand: HashMap<i64, crate::evescout::TheraSignature> = HashMap::new();
    for s in sigs.into_iter().filter(|s| s.is_wormhole()) {
        // The k-space end (`in_system`) is where a traveller finds the hole.
        if s.in_system_id != 0 && s.in_system_id < WSPACE_MIN_SYSTEM_ID {
            cand.entry(s.in_system_id).or_insert(s);
        }
    }
    if cand.is_empty() {
        return Ok(nearest_none(
            current.system_id,
            current.name.clone(),
            false,
            "No public Thera/Turnur connections available right now.",
        ));
    }

    let mut adj: HashMap<i64, Vec<i64>> = HashMap::new();
    for (a, b) in sde.all_stargate_edges().map_err(|e| e.to_string())? {
        adj.entry(a).or_default().push(b);
        adj.entry(b).or_default().push(a);
    }
    let targets: HashSet<i64> = cand.keys().copied().collect();
    Ok(match nearest_of(&adj, current.system_id, &targets) {
        Some((entrance, jumps)) => {
            let s = &cand[&entrance];
            NearestWormhole {
                found: true,
                message: None,
                in_wspace: false,
                current_system_id: current.system_id,
                current_name: current.name.clone(),
                entrance_system_id: entrance,
                entrance_name: name_of(entrance),
                jumps,
                wh_type: s.wh_type.clone(),
                max_ship_size: s.max_ship_size.clone(),
                into_system_id: Some(s.out_system_id),
                into_name: Some(s.out_system_name.clone()),
                expires_in_hours: s.remaining_hours,
            }
        }
        None => nearest_none(
            current.system_id,
            current.name.clone(),
            false,
            "No stargate route to a public wormhole from here.",
        ),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nearest_of_finds_closest_target() {
        // 1-2-3-4 chain; 1-5 branch. Targets {4,5} → 5 is nearer (1 jump).
        let mut adj: HashMap<i64, Vec<i64>> = HashMap::new();
        adj.insert(1, vec![2, 5]);
        adj.insert(2, vec![1, 3]);
        adj.insert(3, vec![2, 4]);
        adj.insert(4, vec![3]);
        adj.insert(5, vec![1]);
        let targets: HashSet<i64> = HashSet::from([4, 5]);
        assert_eq!(nearest_of(&adj, 1, &targets), Some((5, 1)));

        // Origin already a target → zero jumps.
        assert_eq!(nearest_of(&adj, 4, &targets), Some((4, 0)));
        // No target reachable.
        assert_eq!(nearest_of(&adj, 1, &HashSet::from([99])), None);
    }

    #[test]
    fn merges_jumps_and_kills_by_system() {
        let jumps = [
            EsiJumps {
                system_id: 30000142,
                ship_jumps: 120,
            },
            EsiJumps {
                system_id: 30002187,
                ship_jumps: 5,
            },
        ];
        let kills = [
            EsiKills {
                system_id: 30000142,
                ship_kills: 3,
                pod_kills: 1,
                npc_kills: 50,
            },
            EsiKills {
                system_id: 30009999,
                ship_kills: 2,
                pod_kills: 0,
                npc_kills: 0,
            },
        ];
        let map = merge_activity(&jumps, &kills);

        // Jita: both jumps and kills merged onto one row.
        let jita = &map[&30000142];
        assert_eq!(jita.jumps, 120);
        assert_eq!(jita.ship_kills, 3);
        assert_eq!(jita.pod_kills, 1);
        assert_eq!(jita.npc_kills, 50);

        // Jumps-only system has zero kills; kills-only system has zero jumps.
        assert_eq!(map[&30002187].jumps, 5);
        assert_eq!(map[&30002187].ship_kills, 0);
        assert_eq!(map[&30009999].jumps, 0);
        assert_eq!(map[&30009999].ship_kills, 2);
        assert_eq!(map.len(), 3);
    }
}
