//! Pochven live routing (#414).
//!
//! For each Pochven system we know its **C729 exit candidates** — the k-space
//! systems where its wormhole spawns (curated in `candidates.rs`). This command
//! computes, per Pochven system, the jump distance from those exits to each
//! major trade hub under three route preferences — reproducing the source
//! sheet's `avg / median / max / min · secure / shortest / insecure` logic, but
//! **computed live** over the SDE stargate graph (no ESI, no stale numbers).

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap};

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

#[cfg(test)]
mod tests {
    use super::*;

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
