//! Pochven live routing (#414).
//!
//! For each Pochven system we know its **C729 exit candidates** — the k-space
//! systems where its wormhole spawns (curated in `candidates.rs`). This command
//! computes, per Pochven system, the jump distance from those exits to each
//! major trade hub under three route preferences — reproducing the source
//! sheet's `avg / median / max / min · secure / shortest / insecure` logic, but
//! **computed live** over the SDE stargate graph (no ESI, no stale numbers).

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet, VecDeque};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use super::candidates::{HUBS, POCHVEN_CANDIDATES};
use crate::sde::{Sde, SdePaths};
use crate::storage;

/// Highsec threshold: security ≥ 0.45 rounds to 0.5 in-game.
const HIGHSEC: f64 = 0.45;

/// Route preference — the penalty each adds per system entered.
#[derive(Clone, Copy)]
enum Pref {
    Shortest,
    Secure,
    Insecure,
}
impl Pref {
    /// Cost of *entering* a system of the given security under this preference.
    fn penalty(self, sec: f64) -> i64 {
        match self {
            Pref::Shortest => 0,
            Pref::Secure => (sec < HIGHSEC) as i64, // avoid low/null
            Pref::Insecure => (sec >= HIGHSEC) as i64, // avoid highsec
        }
    }
}

/// Jump distance from `start` to every reachable system, minimising
/// (Σ preference penalty, jumps) lexicographically. Returns system → jumps.
fn distances(
    adj: &HashMap<i64, Vec<i64>>,
    sec: &HashMap<i64, f64>,
    start: i64,
    pref: Pref,
) -> HashMap<i64, i64> {
    // best[node] = (penalty, jumps)
    let mut best: HashMap<i64, (i64, i64)> = HashMap::from([(start, (0, 0))]);
    let mut heap: BinaryHeap<Reverse<(i64, i64, i64)>> = BinaryHeap::new();
    heap.push(Reverse((0, 0, start)));
    while let Some(Reverse((pen, jmp, u))) = heap.pop() {
        if best.get(&u).is_some_and(|&(bp, bj)| (pen, jmp) > (bp, bj)) {
            continue;
        }
        for &v in adj.get(&u).into_iter().flatten() {
            let np = pen + pref.penalty(*sec.get(&v).unwrap_or(&0.0));
            let nj = jmp + 1;
            let better = best.get(&v).is_none_or(|&(bp, bj)| (np, nj) < (bp, bj));
            if better {
                best.insert(v, (np, nj));
                heap.push(Reverse((np, nj, v)));
            }
        }
    }
    best.into_iter().map(|(k, (_, j))| (k, j)).collect()
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Stat {
    pub avg: f64,
    pub median: f64,
    pub min: i64,
    pub max: i64,
}

/// Aggregate a set of per-candidate jump counts.
fn stat(mut jumps: Vec<i64>) -> Stat {
    jumps.sort_unstable();
    let n = jumps.len();
    if n == 0 {
        return Stat {
            avg: 0.0,
            median: 0.0,
            min: 0,
            max: 0,
        };
    }
    let avg = jumps.iter().sum::<i64>() as f64 / n as f64;
    let median = if n % 2 == 1 {
        jumps[n / 2] as f64
    } else {
        (jumps[n / 2 - 1] + jumps[n / 2]) as f64 / 2.0
    };
    Stat {
        avg,
        median,
        min: jumps[0],
        max: jumps[n - 1],
    }
}

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
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    if let Some(cached) = storage::cache_get::<PochvenRoutes>(&dir, "pochven_routes") {
        return Ok(cached);
    }

    let sde = Sde::open(&SdePaths::new(dir.clone()).db).map_err(|e| e.to_string())?;

    // k-space stargate adjacency (undirected) + security per system.
    let mut adj: HashMap<i64, Vec<i64>> = HashMap::new();
    for (a, b) in sde.all_stargate_edges().map_err(|e| e.to_string())? {
        adj.entry(a).or_default().push(b);
        adj.entry(b).or_default().push(a);
    }
    let sec: HashMap<i64, f64> = sde
        .solar_system_info()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|(id, (_, s, _))| (id, s))
        .collect();

    // One distance map per (hub, preference) — 5 × 3 Dijkstra passes.
    let prefs = [Pref::Shortest, Pref::Secure, Pref::Insecure];
    let hub_dist: Vec<[HashMap<i64, i64>; 3]> = HUBS
        .iter()
        .map(|&(_, hub_id)| {
            [
                distances(&adj, &sec, hub_id, prefs[0]),
                distances(&adj, &sec, hub_id, prefs[1]),
                distances(&adj, &sec, hub_id, prefs[2]),
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
                        shortest: stat(collect(0)),
                        secure: stat(collect(1)),
                        insecure: stat(collect(2)),
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

/// A BFS result: (distance per system, predecessor per system).
type Bfs = (HashMap<i64, i64>, HashMap<i64, i64>);

/// Raw `/universe/system_kills/` entry (public, hourly).
#[derive(Deserialize)]
struct EsiKills {
    system_id: i64,
    #[serde(default)]
    ship_kills: i64,
    #[serde(default)]
    pod_kills: i64,
}

/// Ship + pod kills per system (last hour), from public ESI. Cached ~5 min;
/// best-effort (empty on failure — the search still works).
async fn system_kills(dir: &std::path::Path) -> HashMap<i64, i64> {
    if let Some(c) = storage::cache_get::<HashMap<i64, i64>>(dir, "pochven_kills") {
        return c;
    }
    let rows: Vec<EsiKills> = crate::esi::EsiClient::new()
        .get_json("/latest/universe/system_kills/", &[])
        .await
        .unwrap_or_default();
    let map: HashMap<i64, i64> = rows
        .into_iter()
        .map(|k| (k.system_id, k.ship_kills + k.pod_kills))
        .collect();
    let _ = storage::cache_put(dir, "pochven_kills", &map, 300);
    map
}

/// Shortest-jump BFS from `start`: distance + predecessor per reachable system.
fn bfs(adj: &HashMap<i64, Vec<i64>>, start: i64) -> Bfs {
    let mut dist: HashMap<i64, i64> = HashMap::from([(start, 0)]);
    let mut pred: HashMap<i64, i64> = HashMap::new();
    let mut q = VecDeque::from([start]);
    while let Some(u) = q.pop_front() {
        let du = dist[&u];
        for &v in adj.get(&u).into_iter().flatten() {
            if let std::collections::hash_map::Entry::Vacant(e) = dist.entry(v) {
                e.insert(du + 1);
                pred.insert(v, u);
                q.push_back(v);
            }
        }
    }
    (dist, pred)
}

/// Reconstruct the jump path `from` → `to` (inclusive) via the predecessor map.
fn path_ids(pred: &HashMap<i64, i64>, from: i64, to: i64) -> Vec<i64> {
    let mut ids = vec![to];
    let mut cur = to;
    while cur != from {
        match pred.get(&cur) {
            Some(&p) => {
                ids.push(p);
                cur = p;
            }
            None => break,
        }
    }
    ids.reverse();
    ids
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
    /// Scan order (1-based) along the nearest-neighbour route.
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
    system_id: i64,
    max_jumps: Option<i64>,
) -> Result<EntrySearch, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let sde = Sde::open(&SdePaths::new(dir.clone()).db).map_err(|e| e.to_string())?;
    let kills = system_kills(&dir).await;

    let mut adj: HashMap<i64, Vec<i64>> = HashMap::new();
    for (a, b) in sde.all_stargate_edges().map_err(|e| e.to_string())? {
        adj.entry(a).or_default().push(b);
        adj.entry(b).or_default().push(a);
    }
    let (dist, pred) = bfs(&adj, system_id);
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

    // Optimise a trip that visits the in-range candidates with minimal total
    // jumps: nearest-neighbour seed, then 2-opt. Distances come from a BFS per
    // trip system (capped for tractability).
    const TRIP_CAP: usize = 40;
    let trip_ids: Vec<i64> = in_range.iter().take(TRIP_CAP).map(|&(id, _)| id).collect();
    let bfs_map: HashMap<i64, Bfs> = trip_ids.iter().map(|&id| (id, bfs(&adj, id))).collect();
    let dist_between = |a: i64, b: i64| -> i64 {
        if a == system_id {
            dist.get(&b).copied().unwrap_or(i64::MAX)
        } else {
            bfs_map
                .get(&a)
                .and_then(|(d, _)| d.get(&b))
                .copied()
                .unwrap_or(i64::MAX)
        }
    };

    // Nearest-neighbour seed order starting from the origin.
    let mut remaining = trip_ids.clone();
    let mut order_ids: Vec<i64> = Vec::new();
    let mut current = system_id;
    while !remaining.is_empty() {
        let idx = remaining
            .iter()
            .enumerate()
            .min_by_key(|&(_, &c)| dist_between(current, c))
            .map(|(i, _)| i)
            .unwrap();
        current = remaining.remove(idx);
        order_ids.push(current);
    }

    // 2-opt on the open path [origin, order_ids…] to shorten the total trip.
    if order_ids.len() >= 3 {
        let mut seq: Vec<i64> = std::iter::once(system_id)
            .chain(order_ids.iter().copied())
            .collect();
        let n = seq.len();
        let mut improved = true;
        let mut guard = 0;
        while improved && guard < 60 {
            improved = false;
            guard += 1;
            for a in 1..n {
                for b in (a + 1)..n {
                    let has_next = b + 1 < n;
                    let before = dist_between(seq[a - 1], seq[a])
                        + if has_next {
                            dist_between(seq[b], seq[b + 1])
                        } else {
                            0
                        };
                    let after = dist_between(seq[a - 1], seq[b])
                        + if has_next {
                            dist_between(seq[a], seq[b + 1])
                        } else {
                            0
                        };
                    if after < before {
                        seq[a..=b].reverse();
                        improved = true;
                    }
                }
            }
        }
        order_ids = seq[1..].to_vec();
    }

    // Scan order per candidate: trip order first, then any further in-range ones.
    let mut order_map: HashMap<i64, i64> = HashMap::new();
    for (i, &id) in order_ids.iter().enumerate() {
        order_map.insert(id, (i + 1) as i64);
    }
    let mut next_order = order_ids.len() as i64;
    for &(id, _) in in_range.iter().skip(trip_ids.len()) {
        next_order += 1;
        order_map.insert(id, next_order);
    }

    // Map = union of the trip segments (origin → c1 → c2 → …).
    let mut node_ids: HashSet<i64> = HashSet::from([system_id]);
    let mut edge_set: HashSet<(i64, i64)> = HashSet::new();
    let mut prev = system_id;
    for &cid in &order_ids {
        let pred_a = if prev == system_id {
            &pred
        } else {
            &bfs_map[&prev].1
        };
        for w in path_ids(pred_a, prev, cid).windows(2) {
            edge_set.insert((w[0], w[1]));
        }
        node_ids.extend(path_ids(pred_a, prev, cid));
        prev = cid;
    }
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
    let edges = edge_set.into_iter().map(|(a, b)| [a, b]).collect();

    // Breadcrumb to the first scan target.
    let route = order_ids
        .first()
        .map(|&first| {
            path_ids(&pred, system_id, first)
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bfs_finds_shortest_distance_and_path() {
        // 1 - 2 - 3 - 4 and a shortcut 1 - 5 - 4
        let adj = HashMap::from([
            (1, vec![2, 5]),
            (2, vec![1, 3]),
            (3, vec![2, 4]),
            (4, vec![3, 5]),
            (5, vec![1, 4]),
        ]);
        let (dist, pred) = bfs(&adj, 1);
        assert_eq!(dist[&4], 2); // 1-5-4
        assert_eq!(path_ids(&pred, 1, 4), vec![1, 5, 4]);
        assert_eq!(dist[&3], 2);
    }

    #[test]
    fn stat_aggregates() {
        let s = stat(vec![2, 4, 6, 8]);
        assert_eq!(s.min, 2);
        assert_eq!(s.max, 8);
        assert_eq!(s.avg, 5.0);
        assert_eq!(s.median, 5.0); // (4+6)/2
        assert_eq!(stat(vec![]).avg, 0.0);
        assert_eq!(stat(vec![3, 1, 2]).median, 2.0);
    }

    #[test]
    fn secure_prefers_highsec_shortest_is_fewer_or_equal_jumps() {
        // line graph: A(0.9) - B(0.2 low) - C(0.9) ; and A - D(0.9) - E(0.9) - C
        let adj = HashMap::from([
            (1, vec![2, 4]),
            (2, vec![1, 3]),
            (3, vec![2, 5]),
            (4, vec![1, 5]),
            (5, vec![4, 3]),
        ]);
        let sec = HashMap::from([(1, 0.9), (2, 0.2), (3, 0.9), (4, 0.9), (5, 0.9)]);
        // Shortest A→C = 2 jumps (via low B).
        assert_eq!(distances(&adj, &sec, 1, Pref::Shortest)[&3], 2);
        // Secure A→C avoids the low system → 3 jumps (A-D-E-C).
        assert_eq!(distances(&adj, &sec, 1, Pref::Secure)[&3], 3);
    }
}
