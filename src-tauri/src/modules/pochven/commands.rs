//! Pochven live routing (#414).
//!
//! For each Pochven system we know its **C729 exit candidates** — the k-space
//! systems where its wormhole spawns (curated in `candidates.rs`). This command
//! computes, per Pochven system, the jump distance from those exits to each
//! major trade hub under three route preferences — reproducing the source
//! sheet's `avg / median / max / min · secure / shortest / insecure` logic, but
//! **computed live** over the SDE stargate graph (no ESI, no stale numbers).

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use super::candidates::{HUBS, POCHVEN_CANDIDATES};
use super::engine;
// Re-exported so the response structs' field type keeps its public path.
pub use super::engine::Stat;
use crate::sde::graph;
use crate::storage;

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct HubRoutes {
    pub hub: String,
    pub shortest: Stat,
    pub secure: Stat,
    pub insecure: Stat,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct PochvenRoute {
    pub system: String,
    pub candidates: i64,
    pub hubs: Vec<HubRoutes>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PochvenRoutes {
    pub hubs: Vec<String>,
    pub systems: Vec<PochvenRoute>,
}

/// Per-Pochven-system jump distances to the trade hubs (secure / shortest /
/// insecure; avg / median / min / max over that system's C729 exit candidates).
/// Computed over the SDE stargate graph and cached ~24h.
#[tauri::command]
pub async fn pochven_routes(app: AppHandle) -> Result<PochvenRoutes, String> {
    // 15 Dijkstra passes over the full k-space graph plus full-table SDE loads
    // — pure CPU with zero awaits, so run the whole body on the blocking pool
    // instead of a tokio worker thread (#611, same pattern as `scripts_run`).
    tokio::task::spawn_blocking(move || pochven_routes_blocking(&app))
        .await
        .map_err(|e| e.to_string())?
}

/// The CPU-bound body of [`pochven_routes`], run on the blocking pool.
fn pochven_routes_blocking(app: &AppHandle) -> Result<PochvenRoutes, String> {
    let (dir, sde) = crate::sde::dir_and_sde(app)?;
    if let Some(cached) = storage::cache_get::<PochvenRoutes>(&dir, "pochven_routes") {
        return Ok(cached);
    }

    // k-space stargate adjacency (undirected) + security per system.
    let adj = sde.stargate_adjacency().map_err(|e| e.to_string())?;
    let sec: HashMap<i64, f64> = sde
        .solar_system_info()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|(id, (_, s, _))| (id, s))
        .collect();

    // One distance map per (hub, preference) — 5 × 3 Dijkstra passes.
    let prefs = [
        engine::Pref::Shortest,
        engine::Pref::Secure,
        engine::Pref::Insecure,
    ];
    let hub_dist: Vec<[HashMap<i64, i64>; 3]> = HUBS
        .iter()
        .map(|&(_, hub_id)| {
            [
                engine::distances(&adj, &sec, hub_id, prefs[0]),
                engine::distances(&adj, &sec, hub_id, prefs[1]),
                engine::distances(&adj, &sec, hub_id, prefs[2]),
            ]
        })
        .collect();

    let systems = POCHVEN_CANDIDATES
        .iter()
        .map(|&(name, _poch_id, cands)| {
            let hubs = HUBS
                .iter()
                .enumerate()
                .map(|(hi, &(hub_name, _))| {
                    // Jumps from each candidate exit to this hub, per preference.
                    let collect = |pi: usize| {
                        cands
                            .iter()
                            .filter_map(|c| hub_dist[hi][pi].get(c).copied())
                            .collect::<Vec<_>>()
                    };
                    HubRoutes {
                        hub: hub_name.to_string(),
                        shortest: engine::stat(collect(0)),
                        secure: engine::stat(collect(1)),
                        insecure: engine::stat(collect(2)),
                    }
                })
                .collect();
            PochvenRoute {
                system: name.to_string(),
                candidates: cands.len() as i64,
                hubs,
            }
        })
        .collect();

    let result = PochvenRoutes {
        hubs: HUBS.iter().map(|&(n, _)| n.to_string()).collect(),
        systems,
    };
    let _ = storage::cache_put(&dir, "pochven_routes", &result, 86_400);
    Ok(result)
}

// --- Entry search: nearest C729 candidates + a route to the closest ---

/// Ship + pod kills per system (last hour), from public ESI (the shared
/// `esi::system_kills` wrapper). Cached ~5 min on success; best-effort on
/// failure (an empty map for this call only — never cached, so the next call
/// retries instead of showing "0 kills" for the TTL).
async fn system_kills(dir: &std::path::Path, esi: &crate::esi::EsiClient) -> HashMap<i64, i64> {
    if let Some(c) = storage::cache_get::<HashMap<i64, i64>>(dir, "pochven_kills") {
        return c;
    }
    store_kills(dir, crate::esi::system_kills(esi).await)
}

/// Fold fetched kill rows into a per-system map and cache the result — but
/// **only when the fetch succeeded**. The old code `unwrap_or_default()`ed the
/// error and cached the empty fallback, so one transient ESI hiccup showed
/// "0 kills everywhere" for the full 5-minute TTL even though a retry would
/// have worked. On `Err` we now return an empty, *uncached* map: the kill
/// overlay is decorative (the entry search still works without it), and the
/// next call hits ESI again. Split out of `system_kills` so this rule is
/// unit-testable without a network; generic over the error type (`E`) because
/// the tests don't need to construct a real ESI error to exercise it.
fn store_kills<E>(
    dir: &std::path::Path,
    fetched: Result<Vec<crate::esi::SystemKills>, E>,
) -> HashMap<i64, i64> {
    match fetched {
        Ok(rows) => {
            let map: HashMap<i64, i64> = rows
                .into_iter()
                .map(|k| (k.system_id, k.ship_kills + k.pod_kills))
                .collect();
            let _ = storage::cache_put(dir, "pochven_kills", &map, 300);
            map
        }
        Err(_) => HashMap::new(),
    }
}

/// One C729 candidate exit near the searcher.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryCandidate {
    pub system: String,
    pub region: String,
    /// Security status of the candidate system.
    pub security: f64,
    /// Ship + pod kills in the last hour (ESI hourly aggregate).
    pub kills: i64,
    /// Jumps from the searcher's current system.
    pub jumps: i64,
    /// Scan order (1-based): the depth-first visit order of the Steiner tree.
    pub order: i64,
    /// Pochven system(s) this candidate's C729 leads into.
    pub leads_to: Vec<String>,
}

/// Security band → node colour class (matches the SystemGraph kinds).
fn sec_kind(sec: f64) -> &'static str {
    if sec >= 0.45 {
        "hisec"
    } else if sec > 0.0 {
        "lowsec"
    } else {
        "nullsec"
    }
}

/// A node in the entry-scan map.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MapNode {
    pub system_id: i64,
    pub name: String,
    /// "origin" | "travel" (grey pass-through) | hisec/lowsec/nullsec (candidate).
    pub kind: String,
    pub candidate: bool,
    pub origin: bool,
    pub jumps: i64,
    /// Scan order (1-based) for candidates; 0 for travel/origin.
    pub order: i64,
    pub leads_to: Vec<String>,
}

/// A small stargate graph: the union of the paths to the nearest candidates.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryMap {
    pub nodes: Vec<MapNode>,
    pub edges: Vec<[i64; 2]>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntrySearch {
    pub from: String,
    /// Max jump distance the candidates were filtered to.
    pub max_jumps: i64,
    /// Pochven systems reachable via the in-range candidates.
    pub targets: Vec<String>,
    /// Jump path (system names) to the first scan target.
    pub route: Vec<String>,
    /// Candidate C729 exit systems, in scan order.
    pub candidates: Vec<EntryCandidate>,
    /// Scan map: candidate systems + the grey travel systems linking them.
    pub map: EntryMap,
}

/// From `system_id`, route to the nearest Pochven C729 exit candidate and list
/// the closest candidates (nearest first) to jump to and scan. Computed over the
/// SDE stargate graph.
#[tauri::command]
pub async fn pochven_search(
    app: AppHandle,
    esi: State<'_, crate::esi::EsiClient>,
    system_id: i64,
    max_jumps: Option<i64>,
) -> Result<EntrySearch, String> {
    // Fetch the (cached) kill overlay first — the only await — then run the
    // Steiner-tree DP + BFS/map building on the blocking pool instead of a
    // tokio worker thread (#611, same pattern as `scripts_run`). The SDE
    // handle is opened inside the closure because `Sde` is not `Send`.
    let dir = storage::app_data_dir(&app)?;
    let kills = system_kills(&dir, &esi).await;
    tokio::task::spawn_blocking(move || pochven_search_blocking(&dir, kills, system_id, max_jumps))
        .await
        .map_err(|e| e.to_string())?
}

/// The CPU-bound body of [`pochven_search`], run on the blocking pool.
fn pochven_search_blocking(
    dir: &std::path::Path,
    kills: HashMap<i64, i64>,
    system_id: i64,
    max_jumps: Option<i64>,
) -> Result<EntrySearch, String> {
    let sde = crate::sde::open_from_dir(dir)?;
    let adj = sde.stargate_adjacency().map_err(|e| e.to_string())?;
    let (dist, pred) = graph::bfs(&adj, system_id, None);
    let info = sde.solar_system_info().map_err(|e| e.to_string())?;
    let name = |id: i64| {
        info.get(&id)
            .map(|(n, _, _)| n.clone())
            .unwrap_or_else(|| format!("#{id}"))
    };

    // candidate k-space system -> the Pochven systems it can lead into.
    let mut leads: HashMap<i64, Vec<String>> = HashMap::new();
    for &(pname, _pid, cands) in POCHVEN_CANDIDATES {
        for &c in cands {
            leads.entry(c).or_default().push(pname.to_string());
        }
    }

    let max_jumps = max_jumps.unwrap_or(15).clamp(1, 30);

    // Reachable C729 candidates within range, nearest first.
    let mut in_range: Vec<(i64, i64)> = leads
        .keys()
        .filter_map(|&id| dist.get(&id).map(|&j| (id, j)))
        .filter(|&(_, j)| j <= max_jumps)
        .collect();
    in_range.sort_by_key(|&(id, j)| (j, id));

    // Pochven systems you could reach via those candidates.
    let mut targets: Vec<String> = in_range
        .iter()
        .flat_map(|&(id, _)| leads.get(&id).cloned().unwrap_or_default())
        .collect();
    targets.sort();
    targets.dedup();

    // Scan order: a minimum Steiner tree over the origin + nearest candidates,
    // walked depth-first — see [`engine::scan_order`] for the full rationale.
    let candidate_set: HashSet<i64> = leads.keys().copied().collect();
    let order_map = engine::scan_order(&adj, &dist, system_id, &in_range, &candidate_set);

    // Map = each candidate's own true shortest route from the origin, unioned
    // — deliberately NOT the Steiner tree (which can route a candidate the
    // long way round); see [`engine::entry_map_graph`].
    const MAP_CAP: usize = 30;
    let (node_ids, map_edges) = engine::entry_map_graph(&pred, system_id, &in_range, MAP_CAP);
    let sec_of = |id: i64| info.get(&id).map(|(_, s, _)| *s).unwrap_or(0.0);
    let nodes = node_ids
        .iter()
        .map(|&id| {
            let cand = leads.contains_key(&id);
            let origin = id == system_id;
            let mut lt = if cand {
                leads.get(&id).cloned().unwrap_or_default()
            } else {
                Vec::new()
            };
            lt.sort();
            lt.dedup();
            MapNode {
                system_id: id,
                name: name(id),
                kind: if origin {
                    "origin".into()
                } else if cand {
                    sec_kind(sec_of(id)).into()
                } else {
                    "travel".into()
                },
                candidate: cand,
                origin,
                jumps: *dist.get(&id).unwrap_or(&0),
                order: order_map.get(&id).copied().unwrap_or(0),
                leads_to: lt,
            }
        })
        .collect();
    let edges = map_edges.into_iter().map(|(a, b)| [a, b]).collect();

    // Breadcrumb to the nearest candidate.
    let route = in_range
        .first()
        .map(|&(first, _)| {
            graph::path_ids(&pred, system_id, first)
                .iter()
                .map(|&id| name(id))
                .collect()
        })
        .unwrap_or_default();

    let mut candidates: Vec<EntryCandidate> = in_range
        .iter()
        .take(60)
        .map(|&(id, j)| {
            let (sys, sec, region) = info
                .get(&id)
                .cloned()
                .unwrap_or_else(|| (format!("#{id}"), 0.0, String::new()));
            let mut lt = leads.get(&id).cloned().unwrap_or_default();
            lt.sort();
            lt.dedup();
            EntryCandidate {
                system: sys,
                region,
                security: sec,
                kills: kills.get(&id).copied().unwrap_or(0),
                jumps: j,
                order: order_map.get(&id).copied().unwrap_or(0),
                leads_to: lt,
            }
        })
        .collect();
    candidates.sort_by_key(|c| c.order);

    Ok(EntrySearch {
        from: name(system_id),
        max_jumps,
        targets,
        route,
        candidates,
        map: EntryMap { nodes, edges },
    })
}

// --- Reference map: real Pochven topology from the SDE ---

/// A k-space system an 'Extraction' filament can drop you into from a Pochven
/// system (within 2.5 ly of it).
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExitTarget {
    pub name: String,
    pub security: f64,
    pub region: String,
    pub light_years: f64,
}

/// C729 entry-candidate counts per security band for one Pochven system.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntryBands {
    pub hisec: i64,
    pub lowsec: i64,
    pub nullsec: i64,
}

/// A k-space region a system's C729 can spawn in, with its candidate count.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpawnRegion {
    pub region: String,
    pub count: i64,
}

/// One Pochven system on the reference map, at its true galactic position.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PochvenMapSystem {
    pub system_id: i64,
    pub name: String,
    pub security: f64,
    /// Galactic map-plane coordinates (x, z) — same plane dotlan plots.
    pub x: f64,
    pub y: f64,
    /// K-space systems within 2.5 ly — where a Proximity 'Extraction' filament
    /// activated here can drop you (nearest first).
    pub exits: Vec<ExitTarget>,
    /// Entry-candidate counts per security band, from the candidate dataset +
    /// SDE securities (replaces the hand-curated frontend table).
    pub bands: EntryBands,
    /// Candidate counts per k-space spawn region, descending by count.
    pub spawn_regions: Vec<SpawnRegion>,
}

/// The 27 Pochven systems + their internal stargate links, from the SDE.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PochvenTopology {
    pub systems: Vec<PochvenMapSystem>,
    pub edges: Vec<[i64; 2]>,
}

/// The real Pochven map: each of the 27 systems at its true galactic position
/// plus the actual internal stargate links between them (both endpoints in
/// Pochven), straight from the SDE — so it matches the in-game / dotlan map.
#[tauri::command]
pub async fn pochven_map(app: AppHandle) -> Result<PochvenTopology, String> {
    // Full geo-table scan + 27×N distance calcs — pure CPU with zero awaits,
    // so run the whole body on the blocking pool instead of a tokio worker
    // thread (#611, same pattern as `scripts_run`).
    tokio::task::spawn_blocking(move || pochven_map_blocking(&app))
        .await
        .map_err(|e| e.to_string())?
}

/// The CPU-bound body of [`pochven_map`], run on the blocking pool.
fn pochven_map_blocking(app: &AppHandle) -> Result<PochvenTopology, String> {
    let sde = crate::sde::open_from_app(app)?;
    let poch_ids: HashSet<i64> = POCHVEN_CANDIDATES.iter().map(|&(_, id, _)| id).collect();
    let info = sde.solar_system_info().map_err(|e| e.to_string())?;
    let pos = sde.solar_system_positions().map_err(|e| e.to_string())?;
    let geo = sde.solar_system_geo().map_err(|e| e.to_string())?;

    // K-space systems (known space, i.e. regionID < 11_000_000 — excludes
    // w-space / Abyssal — and not Pochven itself) for the 2.5 ly 'Extraction'
    // filament range check.
    const LY_M: f64 = 9.460_730_472_580_8e15; // one light-year in metres
    const EXTRACTION_LY: f64 = 2.5;
    let max_m = EXTRACTION_LY * LY_M;
    const POCHVEN_REGION: i64 = 10_000_070;
    let kspace: Vec<(i64, f64, f64, f64)> = geo
        .iter()
        .filter(|(_, (region, ..))| *region < 11_000_000 && *region != POCHVEN_REGION)
        .map(|(&id, &(_, x, y, z))| (id, x, y, z))
        .collect();

    let systems = POCHVEN_CANDIDATES
        .iter()
        .map(|&(name, id, cands)| {
            let security = info.get(&id).map(|(_, s, _)| *s).unwrap_or(0.0);
            let (x, z) = pos.get(&id).copied().unwrap_or((0.0, 0.0));
            // Candidate counts per security band and per k-space region — the
            // frontend's reference table is derived from these, so the numbers
            // can't drift from the candidate dataset.
            let mut bands = EntryBands {
                hisec: 0,
                lowsec: 0,
                nullsec: 0,
            };
            let mut per_region: HashMap<&str, i64> = HashMap::new();
            for c in cands {
                let Some((_, csec, cregion)) = info.get(c) else {
                    continue;
                };
                if *csec >= engine::HIGHSEC {
                    bands.hisec += 1;
                } else if *csec > 0.0 {
                    bands.lowsec += 1;
                } else {
                    bands.nullsec += 1;
                }
                *per_region.entry(cregion.as_str()).or_default() += 1;
            }
            let mut spawn_regions: Vec<SpawnRegion> = per_region
                .into_iter()
                .map(|(region, count)| SpawnRegion {
                    region: region.to_string(),
                    count,
                })
                .collect();
            spawn_regions.sort_by(|a, b| b.count.cmp(&a.count).then(a.region.cmp(&b.region)));
            // 'Extraction' filament targets: k-space within 2.5 ly of here.
            let mut exits: Vec<ExitTarget> = Vec::new();
            if let Some(&(_, px, py, pz)) = geo.get(&id) {
                for &(kid, kx, ky, kz) in &kspace {
                    let d = ((kx - px).powi(2) + (ky - py).powi(2) + (kz - pz).powi(2)).sqrt();
                    if d <= max_m {
                        let (kname, ksec, kregion) = info
                            .get(&kid)
                            .cloned()
                            .unwrap_or_else(|| (format!("#{kid}"), 0.0, String::new()));
                        exits.push(ExitTarget {
                            name: kname,
                            security: ksec,
                            region: kregion,
                            light_years: d / LY_M,
                        });
                    }
                }
                exits.sort_by(|a, b| {
                    a.light_years
                        .partial_cmp(&b.light_years)
                        .unwrap_or(std::cmp::Ordering::Equal)
                });
            }
            PochvenMapSystem {
                system_id: id,
                name: name.to_string(),
                security,
                x,
                y: z,
                exits,
                bands,
                spawn_regions,
            }
        })
        .collect();

    // Internal gate links = stargate edges with both ends inside Pochven.
    let mut seen: HashSet<(i64, i64)> = HashSet::new();
    let mut edges = Vec::new();
    for (a, b) in sde.all_stargate_edges().map_err(|e| e.to_string())? {
        if poch_ids.contains(&a) && poch_ids.contains(&b) {
            let key = if a <= b { (a, b) } else { (b, a) };
            if seen.insert(key) {
                edges.push([key.0, key.1]);
            }
        }
    }
    Ok(PochvenTopology { systems, edges })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_kills_fetch_is_not_cached() {
        // Pin the #612 fix: an ESI error must not poison the kills cache.
        let dir = std::env::temp_dir().join(format!("pochven-kills-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        // A failed fetch yields an empty map for this call only...
        let map = store_kills(&dir, Err(()));
        assert!(map.is_empty());
        // ...and writes nothing, so the next call misses the cache and retries.
        assert_eq!(
            storage::cache_get::<HashMap<i64, i64>>(&dir, "pochven_kills"),
            None
        );
        // A successful fetch is folded (ship + pod) and cached as before.
        let rows = vec![crate::esi::SystemKills {
            system_id: 30_000_142,
            ship_kills: 3,
            pod_kills: 2,
            npc_kills: 0,
        }];
        let map = store_kills::<()>(&dir, Ok(rows));
        assert_eq!(map.get(&30_000_142), Some(&5));
        assert_eq!(
            storage::cache_get::<HashMap<i64, i64>>(&dir, "pochven_kills"),
            Some(map)
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
