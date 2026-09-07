//! Pochven graph engine — the pure algorithmic core behind the pochven
//! commands (#633): preference-weighted Dijkstra over the stargate graph,
//! jump-count aggregation, the Dreyfus–Wagner Steiner tree and its DFS walk,
//! and the scan-order / entry-map derivations built on them.
//!
//! Everything here is pure — graphs and tables in, plain data out — so it
//! unit-tests without an SDE, ESI, or Tauri handle. `commands.rs` stays a
//! thin orchestrator (resolve state, call engine, shape the response), per
//! the repo's thin-command-layer convention (mirrors `production/engine.rs`).

use std::cmp::Reverse;
use std::collections::{BinaryHeap, HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::sde::graph;

/// Highsec threshold: security ≥ 0.45 rounds to 0.5 in-game.
pub(super) const HIGHSEC: f64 = 0.45;

/// Route preference — the penalty each adds per system entered.
#[derive(Clone, Copy)]
pub(super) enum Pref {
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
pub(super) fn distances(
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
pub(super) fn stat(mut jumps: Vec<i64>) -> Stat {
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

/// A BFS result: (distance per system, predecessor per system).
type Bfs = (HashMap<i64, i64>, HashMap<i64, i64>);

/// How a `dp[mask][v]` cell was reached, for Steiner-tree reconstruction.
#[derive(Clone, Copy)]
enum Back {
    None,
    /// Grown one gate from vertex index `u` (same terminal subset).
    Edge(usize),
    /// Merge of subset `sub` and `mask ^ sub`, both meeting at `v`.
    Merge(usize),
}

/// Minimum **Steiner tree** connecting `terminals` in the unit-weight stargate
/// graph, via the **Dreyfus–Wagner** dynamic program — the smallest set of gate
/// links that ties all the terminals together (using extra "through" systems
/// where that saves jumps). Returns the tree's edges as system-id pairs.
///
/// The DP is `dp[S][v]` = min jumps of a tree spanning terminal-subset `S` and
/// touching vertex `v`; it grows by (a) merging two sub-trees that meet at `v`
/// and (b) extending along a gate (a Dijkstra relaxation). It's exponential in
/// the terminal count, so the caller caps that; we also restrict the working
/// vertex set to the union of shortest paths between terminal pairs, which keeps
/// the graph small without changing the optimum in practice.
pub(super) fn steiner_tree(adj: &HashMap<i64, Vec<i64>>, terminals: &[i64]) -> Vec<(i64, i64)> {
    let k = terminals.len();
    if k <= 1 {
        return Vec::new();
    }
    // Per-terminal BFS, then W = union of the terminal-to-terminal shortest paths.
    let bfss: Vec<Bfs> = terminals
        .iter()
        .map(|&t| graph::bfs(adj, t, None))
        .collect();
    let mut wset: HashSet<i64> = terminals.iter().copied().collect();
    for i in 0..k {
        let (di, pi) = &bfss[i];
        for (j, &tj) in terminals.iter().enumerate().skip(i + 1) {
            let _ = j;
            if di.contains_key(&tj) {
                wset.extend(graph::path_ids(pi, terminals[i], tj));
            }
        }
    }
    // Index the working vertices and build the induced adjacency.
    let verts: Vec<i64> = wset.iter().copied().collect();
    let idx: HashMap<i64, usize> = verts.iter().enumerate().map(|(i, &v)| (v, i)).collect();
    let m = verts.len();
    let mut wadj: Vec<Vec<usize>> = vec![Vec::new(); m];
    for (vi, &v) in verts.iter().enumerate() {
        for &n in adj.get(&v).into_iter().flatten() {
            if let Some(&ni) = idx.get(&n) {
                wadj[vi].push(ni);
            }
        }
    }
    let term_idx: Vec<usize> = terminals.iter().map(|&t| idx[&t]).collect();

    const INF: i64 = i64::MAX / 4;
    let full = (1usize << k) - 1;
    let mut dp = vec![vec![INF; m]; 1 << k];
    let mut back = vec![vec![Back::None; m]; 1 << k];

    // Process subsets in increasing size so a mask's sub-parts are already done.
    let mut masks: Vec<usize> = (1..=full).collect();
    masks.sort_by_key(|mm| mm.count_ones());
    for &mask in &masks {
        if mask.count_ones() == 1 {
            let t = mask.trailing_zeros() as usize;
            dp[mask][term_idx[t]] = 0;
        } else {
            // Merge step: split `mask` into two non-empty parts meeting at v.
            // Enumerate sub-masks that contain the lowest set bit (avoids dupes).
            let low = mask.isolate_lowest_one();
            let mut sub = (mask - 1) & mask;
            while sub > 0 {
                if sub & low != 0 {
                    let other = mask ^ sub;
                    // Indexes four parallel vectors, so a range loop is clearest.
                    #[allow(clippy::needless_range_loop)]
                    for v in 0..m {
                        let c = dp[sub][v].saturating_add(dp[other][v]);
                        if c < dp[mask][v] {
                            dp[mask][v] = c;
                            back[mask][v] = Back::Merge(sub);
                        }
                    }
                }
                sub = (sub - 1) & mask;
            }
        }
        // Grow step: Dijkstra (unit weights) seeded with the current dp[mask].
        let mut heap = BinaryHeap::new();
        for (v, &d) in dp[mask].iter().enumerate() {
            if d < INF {
                heap.push(Reverse((d, v)));
            }
        }
        while let Some(Reverse((d, u))) = heap.pop() {
            if d > dp[mask][u] {
                continue;
            }
            for &w in &wadj[u] {
                let nd = d + 1;
                if nd < dp[mask][w] {
                    dp[mask][w] = nd;
                    back[mask][w] = Back::Edge(u);
                    heap.push(Reverse((nd, w)));
                }
            }
        }
    }

    // Root at the cheapest vertex for the full terminal set, then unwind.
    let root = (0..m).min_by_key(|&v| dp[full][v]).unwrap_or(0);
    let mut edges: Vec<(i64, i64)> = Vec::new();
    let mut stack = vec![(full, root)];
    while let Some((mask, v)) = stack.pop() {
        match back[mask][v] {
            Back::Edge(u) => {
                edges.push((verts[u], verts[v]));
                stack.push((mask, u));
            }
            Back::Merge(sub) => {
                stack.push((sub, v));
                stack.push((mask ^ sub, v));
            }
            Back::None => {}
        }
    }
    edges
}

/// Depth-first visit order of a tree from `root`. At each node, nearer branches
/// (by `dist` from the origin) are taken first, so the numbering fans outward.
pub(super) fn tree_preorder(edges: &[(i64, i64)], root: i64, dist: &HashMap<i64, i64>) -> Vec<i64> {
    let mut tadj = graph::undirected_adjacency(edges);
    for ch in tadj.values_mut() {
        ch.sort_by_key(|c| (dist.get(c).copied().unwrap_or(i64::MAX), *c));
    }
    let mut order = Vec::new();
    let mut visited = HashSet::new();
    let mut stack = vec![root];
    while let Some(u) = stack.pop() {
        if !visited.insert(u) {
            continue;
        }
        order.push(u);
        if let Some(ch) = tadj.get(&u) {
            // Push in reverse so the nearest child is popped (visited) first.
            for &c in ch.iter().rev() {
                if !visited.contains(&c) {
                    stack.push(c);
                }
            }
        }
    }
    order
}

/// How many terminals the Steiner DP works over at most — it's exponential in
/// the terminal count, so only the nearest candidates shape the scan tree.
pub(super) const STEINER_MAX: usize = 10;

/// Scan order (1-based) for the in-range candidate exits.
///
/// A minimum **Steiner tree** (Dreyfus–Wagner) over the origin plus the
/// nearest [`STEINER_MAX`] candidates gives the smallest gate sub-network
/// tying them together; its depth-first visit order (nearer branches first) is
/// the scan order — it limits total jumps far better than numbering by raw
/// distance (which can jump you back and forth across the map). Candidates
/// beyond the Steiner cap are appended afterwards, nearest first.
///
/// `in_range` is (candidate system, jumps) sorted nearest-first; `candidates`
/// is the full candidate set (for recognising them among the tree's nodes);
/// `dist` is jumps-from-origin for the DFS's nearest-branch-first tiebreak.
pub(super) fn scan_order(
    adj: &HashMap<i64, Vec<i64>>,
    dist: &HashMap<i64, i64>,
    origin: i64,
    in_range: &[(i64, i64)],
    candidates: &HashSet<i64>,
) -> HashMap<i64, i64> {
    let mut terminals: Vec<i64> = vec![origin];
    for &(id, _) in in_range.iter().take(STEINER_MAX) {
        if id != origin {
            terminals.push(id);
        }
    }
    let tree_edges = steiner_tree(adj, &terminals);
    let visit = tree_preorder(&tree_edges, origin, dist);

    // Candidates in DFS visit order first, then any beyond the Steiner cap,
    // nearest first.
    let mut order_map: HashMap<i64, i64> = HashMap::new();
    let mut n_order = 0i64;
    for &v in &visit {
        if candidates.contains(&v) {
            n_order += 1;
            order_map.insert(v, n_order);
        }
    }
    for &(id, _) in in_range {
        order_map.entry(id).or_insert_with(|| {
            n_order += 1;
            n_order
        });
    }
    order_map
}

/// The shortest-path-tree sub-graph linking `origin` to the nearest `cap`
/// in-range candidates: (node ids, undirected edges normalised low-high).
///
/// Each candidate is reached by its OWN true shortest route from the origin
/// (from the BFS predecessor map `pred` over the full k-space graph). We
/// deliberately do NOT use the Steiner tree here — that minimises the *total*
/// network and can route a candidate the long way round (through a shared
/// branch) to save edges elsewhere, so its drawn route would show more jumps
/// than the Jumps column. Routing each candidate independently uses whatever
/// nearby systems are shortest (including ones with no Pochven link) and
/// matches Jumps. (The Steiner tree is used only to order the scan, not to
/// draw the map.)
pub(super) fn entry_map_graph(
    pred: &HashMap<i64, i64>,
    origin: i64,
    in_range: &[(i64, i64)],
    cap: usize,
) -> (HashSet<i64>, Vec<(i64, i64)>) {
    let mut node_ids: HashSet<i64> = HashSet::from([origin]);
    let mut edge_set: HashSet<(i64, i64)> = HashSet::new();
    let norm = |a: i64, b: i64| if a <= b { (a, b) } else { (b, a) };
    for &(cid, _) in in_range.iter().take(cap) {
        let path = graph::path_ids(pred, origin, cid);
        for w in path.windows(2) {
            edge_set.insert(norm(w[0], w[1]));
        }
        node_ids.extend(path);
    }
    (node_ids, edge_set.into_iter().collect())
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
    fn steiner_tree_uses_a_shared_hub() {
        // Three terminals each one gate from a common hub (4); the minimum
        // Steiner tree is the 3-spoke star through the hub (cost 3), not the
        // pairwise shortest paths (which would double up edges).
        let adj = HashMap::from([(1, vec![4]), (2, vec![4]), (3, vec![4]), (4, vec![1, 2, 3])]);
        let edges = steiner_tree(&adj, &[1, 2, 3]);
        assert_eq!(edges.len(), 3);
        let nodes: HashSet<i64> = edges.iter().flat_map(|&(a, b)| [a, b]).collect();
        assert!(nodes.contains(&4)); // the shared hub is a Steiner point
                                     // DFS from terminal 1 visits every tree node, root first.
        let dist = HashMap::from([(1, 0), (4, 1), (2, 2), (3, 2)]);
        let order = tree_preorder(&edges, 1, &dist);
        assert_eq!(order.first(), Some(&1));
        assert_eq!(order.len(), 4);
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

    #[test]
    fn scan_order_numbers_candidates_along_the_tree() {
        // Star: origin 1 — hub 4 — candidates 2 and 3 hang off the hub.
        //   1 - 4, 4 - 2, 4 - 3
        // The Steiner tree over {1, 2, 3} runs through hub 4; the DFS from the
        // origin numbers 2 before 3 (equal distance, id tiebreak), and the
        // non-candidate hub gets no number.
        let adj = HashMap::from([(1, vec![4]), (2, vec![4]), (3, vec![4]), (4, vec![1, 2, 3])]);
        let dist = HashMap::from([(1, 0), (4, 1), (2, 2), (3, 2)]);
        let in_range = vec![(2, 2), (3, 2)];
        let candidates: HashSet<i64> = HashSet::from([2, 3]);

        let order = scan_order(&adj, &dist, 1, &in_range, &candidates);

        assert_eq!(order.get(&2), Some(&1));
        assert_eq!(order.get(&3), Some(&2));
        assert_eq!(order.get(&4), None); // hub is a through-system, not a stop
        assert_eq!(order.get(&1), None); // origin isn't a candidate here
    }

    #[test]
    fn scan_order_appends_beyond_cap_candidates_nearest_first() {
        // A long chain 1-2-3-...; give more candidates than STEINER_MAX so the
        // overflow ones are numbered after the tree walk, nearest first.
        let n = (STEINER_MAX + 3) as i64;
        let mut adj: HashMap<i64, Vec<i64>> = HashMap::new();
        for i in 1..=n {
            let mut nb = Vec::new();
            if i > 1 {
                nb.push(i - 1);
            }
            if i < n {
                nb.push(i + 1);
            }
            adj.insert(i, nb);
        }
        let dist: HashMap<i64, i64> = (1..=n).map(|i| (i, i - 1)).collect();
        // Candidates: every system except the origin, nearest first.
        let in_range: Vec<(i64, i64)> = (2..=n).map(|i| (i, i - 1)).collect();
        let candidates: HashSet<i64> = (2..=n).collect();

        let order = scan_order(&adj, &dist, 1, &in_range, &candidates);

        // Every candidate got a number, 1-based and dense.
        assert_eq!(order.len(), in_range.len());
        let mut nums: Vec<i64> = order.values().copied().collect();
        nums.sort_unstable();
        assert_eq!(nums, (1..=in_range.len() as i64).collect::<Vec<_>>());
        // On a chain the scan order is exactly the walk down it — including the
        // beyond-cap tail, appended nearest first.
        for i in 2..=n {
            assert_eq!(order.get(&i), Some(&(i - 1)));
        }
    }

    #[test]
    fn entry_map_graph_unions_shortest_paths() {
        // 1 - 2 - 3 and 1 - 4: candidates 3 and 4; pred from a BFS at 1.
        let adj = HashMap::from([(1, vec![2, 4]), (2, vec![1, 3]), (3, vec![2]), (4, vec![1])]);
        let (_, pred) = graph::bfs(&adj, 1, None);
        let in_range = vec![(4, 1), (3, 2)];

        let (nodes, edges) = entry_map_graph(&pred, 1, &in_range, 30);

        assert_eq!(nodes, HashSet::from([1, 2, 3, 4]));
        let edges: HashSet<(i64, i64)> = edges.into_iter().collect();
        assert_eq!(edges, HashSet::from([(1, 2), (2, 3), (1, 4)]));

        // The cap keeps only the nearest candidates' paths.
        let (nodes, edges) = entry_map_graph(&pred, 1, &in_range, 1);
        assert_eq!(nodes, HashSet::from([1, 4]));
        assert_eq!(edges, vec![(1, 4)]);
    }
}
