//! Plain `i64`-node graph utilities: undirected adjacency, breadth-first
//! search and path reconstruction. Not tied to [`Sde`](super::Sde) — callers
//! supply whatever edge list they've already fetched (stargate jumps,
//! wormhole connections, a Steiner-tree subgraph, …) so this stays a pure,
//! allocation-cheap building block shared across the route / market /
//! pochven / capability call sites that all used to hand-roll the same
//! adjacency-map-plus-BFS loop.

use std::collections::hash_map::Entry;
use std::collections::{HashMap, VecDeque};

/// Build an undirected adjacency map from an edge list: each `(a, b)` pair
/// adds `b` to `a`'s neighbours and `a` to `b`'s. Callers that need to filter
/// edges (e.g. a high-sec-only routing toggle) pre-filter the edge slice
/// before calling this — no filtering logic lives here.
pub fn undirected_adjacency(edges: &[(i64, i64)]) -> HashMap<i64, Vec<i64>> {
    let mut adj: HashMap<i64, Vec<i64>> = HashMap::new();
    for &(a, b) in edges {
        adj.entry(a).or_default().push(b);
        adj.entry(b).or_default().push(a);
    }
    adj
}

/// Breadth-first search from `start` over `adj`, returning `(distances,
/// predecessors)` keyed by system id. `start` itself has distance 0 and no
/// predecessor entry.
///
/// `max_depth`, when set, caps how far the search expands: a node reached at
/// exactly `max_depth` is recorded (with its predecessor) but not expanded
/// further, so nothing beyond `max_depth` is ever discovered.
pub fn bfs(
    adj: &HashMap<i64, Vec<i64>>,
    start: i64,
    max_depth: Option<i64>,
) -> (HashMap<i64, i64>, HashMap<i64, i64>) {
    let mut dist: HashMap<i64, i64> = HashMap::from([(start, 0)]);
    let mut pred: HashMap<i64, i64> = HashMap::new();
    let mut queue: VecDeque<i64> = VecDeque::from([start]);
    while let Some(u) = queue.pop_front() {
        let du = dist[&u];
        if max_depth.is_some_and(|cap| du >= cap) {
            continue;
        }
        for &v in adj.get(&u).into_iter().flatten() {
            if let Entry::Vacant(e) = dist.entry(v) {
                e.insert(du + 1);
                pred.insert(v, u);
                queue.push_back(v);
            }
        }
    }
    (dist, pred)
}

/// Dijkstra shortest path over an adjacency whose edges carry metadata `E`
/// (e.g. how a hop is crossed). `node_cost` prices *entering* a system — a
/// uniform `|_| 1` reproduces BFS hop counting; weighting dangerous space
/// higher gives a "prefer safer" route that only enters it when no cheaper
/// alternative exists. Returns origin→dest as `(node, Option<E>)` pairs (the
/// origin carries `None`), or `None` when unreachable.
pub fn dijkstra<E: Copy>(
    adj: &HashMap<i64, Vec<(i64, E)>>,
    origin: i64,
    dest: i64,
    node_cost: impl Fn(i64) -> u64,
) -> Option<Vec<(i64, Option<E>)>> {
    use std::cmp::Reverse;
    use std::collections::BinaryHeap;

    if origin == dest {
        return Some(vec![(origin, None)]);
    }
    let mut dist: HashMap<i64, u64> = HashMap::from([(origin, 0)]);
    let mut prev: HashMap<i64, (i64, E)> = HashMap::new();
    let mut heap: BinaryHeap<Reverse<(u64, i64)>> = BinaryHeap::from([Reverse((0, origin))]);
    while let Some(Reverse((d, u))) = heap.pop() {
        if u == dest {
            break;
        }
        if dist.get(&u).is_some_and(|&best| d > best) {
            continue; // stale heap entry
        }
        for &(v, e) in adj.get(&u).into_iter().flatten() {
            let nd = d + node_cost(v);
            if dist.get(&v).is_none_or(|&best| nd < best) {
                dist.insert(v, nd);
                prev.insert(v, (u, e));
                heap.push(Reverse((nd, v)));
            }
        }
    }
    if !prev.contains_key(&dest) {
        return None;
    }
    let mut path = Vec::new();
    let mut node = dest;
    while node != origin {
        let (p, e) = prev[&node];
        path.push((node, Some(e)));
        node = p;
    }
    path.push((origin, None));
    path.reverse();
    Some(path)
}

/// Reconstruct the jump path `from` → `to` (inclusive of both endpoints) via
/// a [`bfs`] predecessor map. Walks backwards from `to` until it hits `from`
/// (or runs out of predecessors, for a caller passing an unreachable `to`).
pub fn path_ids(pred: &HashMap<i64, i64>, from: i64, to: i64) -> Vec<i64> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bfs_shortest_path_over_undirected_edges() {
        // 1-2-3-4 chain plus a 2-4 shortcut.
        let edges = [(1, 2), (2, 3), (3, 4), (2, 4)];
        let adj = undirected_adjacency(&edges);
        let (dist, _) = bfs(&adj, 1, None);
        assert_eq!(dist.get(&1), Some(&0));
        assert_eq!(dist.get(&4), Some(&2)); // 1-2-4
        assert_eq!(dist.get(&99), None);
    }

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
        let (dist, pred) = bfs(&adj, 1, None);
        assert_eq!(dist[&4], 2); // 1-5-4
        assert_eq!(path_ids(&pred, 1, 4), vec![1, 5, 4]);
        assert_eq!(dist[&3], 2);
    }

    #[test]
    fn dijkstra_uniform_matches_hop_count_and_weights_divert() {
        // Two routes 1→4: short via 2, long via 3-5. Edges both ways.
        let mut adj: HashMap<i64, Vec<(i64, ())>> = HashMap::new();
        let mut link = |a: i64, b: i64| {
            adj.entry(a).or_default().push((b, ()));
            adj.entry(b).or_default().push((a, ()));
        };
        link(1, 2);
        link(2, 4);
        link(1, 3);
        link(3, 5);
        link(5, 4);

        // Uniform cost → the 2-hop route, like BFS.
        let p = dijkstra(&adj, 1, 4, |_| 1).unwrap();
        assert_eq!(p.iter().map(|(n, _)| *n).collect::<Vec<_>>(), vec![1, 2, 4]);

        // System 2 priced as dangerous → the longer all-safe route wins.
        let p = dijkstra(&adj, 1, 4, |n| if n == 2 { 50 } else { 1 }).unwrap();
        assert_eq!(
            p.iter().map(|(n, _)| *n).collect::<Vec<_>>(),
            vec![1, 3, 5, 4]
        );

        // Unreachable / trivial cases.
        assert!(dijkstra(&adj, 1, 99, |_| 1).is_none());
        assert_eq!(dijkstra(&adj, 7, 7, |_| 1).unwrap(), vec![(7, None)]);
    }

    #[test]
    fn bfs_respects_max_depth_cap() {
        let edges = [(1, 2), (2, 3), (3, 4)];
        let adj = undirected_adjacency(&edges);
        let (dist, _) = bfs(&adj, 1, Some(2));
        assert_eq!(dist.get(&1), Some(&0));
        assert_eq!(dist.get(&2), Some(&1));
        assert_eq!(dist.get(&3), Some(&2));
        assert_eq!(dist.get(&4), None); // beyond the depth cap
    }
}
