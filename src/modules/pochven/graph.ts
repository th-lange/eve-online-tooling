// Pure graph math for the Pochven module: the scan map is a tree rooted at the
// searcher's origin, and everything here is derived from that shape. Kept free
// of React so the routing behaviour is unit-testable (see graph.test.ts).

/** Canonical undirected edge key: "min-max" of the two system ids. */
export function edgeKey(a: number, b: number): string {
  return a < b ? `${a}-${b}` : `${b}-${a}`;
}

export interface ScanTree {
  /** Child system → its parent on the path back to the origin. */
  parent: Map<number, number>;
  /** System → the candidate systems in the subtree below it (inclusive). */
  subtreeCands: Map<number, Set<number>>;
}

/**
 * Root the scan map at the origin: BFS parents plus, per system, which
 * candidates lie beyond it (its subtree). An edge into a subtree is "the way
 * to reach" every candidate inside it — that drives the route colours.
 */
export function buildScanTree(
  edges: readonly (readonly [number, number])[],
  originId: number,
  candIds: ReadonlySet<number>,
): ScanTree {
  const adj = new Map<number, number[]>();
  const add = (a: number, b: number) => {
    const l = adj.get(a);
    if (l) l.push(b);
    else adj.set(a, [b]);
  };
  for (const [a, b] of edges) {
    add(a, b);
    add(b, a);
  }
  const parent = new Map<number, number>();
  const bfsOrder: number[] = [];
  const seen = new Set<number>([originId]);
  const queue: number[] = [originId];
  while (queue.length) {
    const u = queue.shift()!;
    bfsOrder.push(u);
    for (const v of adj.get(u) ?? []) {
      if (!seen.has(v)) {
        seen.add(v);
        parent.set(v, u);
        queue.push(v);
      }
    }
  }
  // Children accumulate bottom-up (reverse BFS order visits leaves first).
  const subtreeCands = new Map<number, Set<number>>();
  for (let i = bfsOrder.length - 1; i >= 0; i--) {
    const u = bfsOrder[i];
    const s = new Set<number>();
    if (candIds.has(u)) s.add(u);
    for (const v of adj.get(u) ?? [])
      if (parent.get(v) === u)
        for (const x of subtreeCands.get(v) ?? []) s.add(x);
    subtreeCands.set(u, s);
  }
  return { parent, subtreeCands };
}

/** Path from `x` up to the origin (inclusive both ends). */
function toRoot(
  parent: ReadonlyMap<number, number>,
  originId: number,
  x: number,
): number[] {
  const path = [x];
  let cur = x;
  while (cur !== originId && parent.has(cur)) {
    cur = parent.get(cur)!;
    path.push(cur);
  }
  return path;
}

/** Tree path between two systems, via their lowest common ancestor. */
export function treePath(
  parent: ReadonlyMap<number, number>,
  originId: number,
  a: number,
  b: number,
): number[] {
  const A = toRoot(parent, originId, a);
  const bPath = toRoot(parent, originId, b);
  const bIndex = new Map(bPath.map((n, i) => [n, i]));
  const lcaAt = A.findIndex((n) => bIndex.has(n));
  if (lcaAt < 0) return [];
  const down = bPath.slice(0, bIndex.get(A[lcaAt])!).reverse();
  return [...A.slice(0, lcaAt + 1), ...down];
}

/**
 * The map subset to draw when the user narrows to certain target systems: the
 * union of root-paths from the origin to each active candidate.
 */
export function keptSets(
  activeCandIds: ReadonlySet<number>,
  parent: ReadonlyMap<number, number>,
  originId: number,
): { nodes: Set<number>; edges: Set<string> } {
  const nodes = new Set<number>([originId]);
  const edges = new Set<string>();
  for (const cid of activeCandIds) {
    let cur = cid;
    nodes.add(cur);
    while (cur !== originId && parent.has(cur)) {
      const p = parent.get(cur)!;
      edges.add(edgeKey(cur, p));
      nodes.add(p);
      cur = p;
    }
  }
  return { nodes, edges };
}

/**
 * The green route = the *next* jump(s) to make. Normally the leg from the
 * player's position (the last candidate they've ticked, else the origin) to the
 * next unticked candidate. When a candidate is selected, instead that
 * candidate's previous- and next-jump legs, so any step of the tour can be
 * inspected. Returns edge keys (see [`edgeKey`]).
 */
export function computeGreenEdges(args: {
  parent: ReadonlyMap<number, number>;
  originId: number;
  /** Active candidates in scan (visit) order. */
  orderedCands: readonly number[];
  visited: ReadonlySet<number>;
  /** Currently selected node ids (map selection). */
  selected: readonly number[];
  candIds: ReadonlySet<number>;
}): Set<string> {
  const { parent, originId, orderedCands, visited, selected, candIds } = args;
  const legEdges = (a: number, b: number, into: Set<string>) => {
    const nodes = treePath(parent, originId, a, b);
    for (let i = 0; i + 1 < nodes.length; i++)
      into.add(edgeKey(nodes[i], nodes[i + 1]));
  };

  const set = new Set<string>();
  const selCand = selected.find((id) => candIds.has(id));
  if (selCand != null) {
    const i = orderedCands.indexOf(selCand);
    const prev = i > 0 ? orderedCands[i - 1] : originId;
    legEdges(prev, selCand, set);
    if (i >= 0 && i < orderedCands.length - 1)
      legEdges(selCand, orderedCands[i + 1], set);
    return set;
  }
  const visitedInOrder = orderedCands.filter((id) => visited.has(id));
  const pos = visitedInOrder.length
    ? visitedInOrder[visitedInOrder.length - 1]
    : originId;
  const nextTarget = orderedCands.find((id) => !visited.has(id));
  if (nextTarget != null) legEdges(pos, nextTarget, set);
  return set;
}

/**
 * Reference-map layout: the three clade home systems pinned at triangle
 * corners, every other system aligned on the straight line between the two
 * homes it is gate-nearest to, evenly spaced along that line.
 * Returns positions keyed by system id (unknown systems fall to the centre).
 */
export function homeTriangleLayout(
  systems: readonly { systemId: number; name: string }[],
  edges: readonly (readonly [number, number])[],
): Map<number, { x: number; y: number }> {
  const W = 1120;
  const H = 760;
  const CORNERS: Record<string, [number, number]> = {
    Kino: [W / 2, 40], // Perun — top
    Archee: [50, H - 30], // Veles — bottom-left
    Niarja: [W - 50, H - 30], // Svarog — bottom-right
  };
  const homes = ["Kino", "Archee", "Niarja"] as const;
  const idOf = new Map(systems.map((s) => [s.name, s.systemId]));

  // Gate adjacency + BFS distance from each home.
  const adj = new Map<number, number[]>();
  const add = (a: number, b: number) => {
    const l = adj.get(a);
    if (l) l.push(b);
    else adj.set(a, [b]);
  };
  for (const [a, b] of edges) {
    add(a, b);
    add(b, a);
  }
  const bfs = (start: number) => {
    const dist = new Map<number, number>([[start, 0]]);
    const q = [start];
    while (q.length) {
      const u = q.shift()!;
      for (const v of adj.get(u) ?? [])
        if (!dist.has(v)) {
          dist.set(v, dist.get(u)! + 1);
          q.push(v);
        }
    }
    return dist;
  };
  const distByHome: Record<string, Map<number, number>> = {};
  homes.forEach((h) => {
    distByHome[h] = bfs(idOf.get(h) ?? -1);
  });
  const distTo = (h: string, id: number) => distByHome[h].get(id) ?? 999;

  // Assign each non-home system to the edge between its two nearest homes.
  const onEdge = new Map<string, number[]>();
  for (const s of systems) {
    if (CORNERS[s.name]) continue;
    const near = [...homes].sort(
      (a, b) => distTo(a, s.systemId) - distTo(b, s.systemId),
    );
    const key = [near[0], near[1]].sort().join("|");
    const arr = onEdge.get(key);
    if (arr) arr.push(s.systemId);
    else onEdge.set(key, [s.systemId]);
  }
  const pos = new Map<number, { x: number; y: number }>();
  for (const s of systems) {
    if (CORNERS[s.name])
      pos.set(s.systemId, { x: CORNERS[s.name][0], y: CORNERS[s.name][1] });
  }
  for (const [key, ids] of onEdge) {
    const [a, b] = key.split("|");
    const pa = CORNERS[a];
    const pb = CORNERS[b];
    // Order along the line by distance ratio to the two endpoints…
    ids.sort(
      (i, j) =>
        distTo(a, i) / (distTo(a, i) + distTo(b, i)) -
        distTo(a, j) / (distTo(a, j) + distTo(b, j)),
    );
    // …then place at even fractions so spacing equals the line / (n+1).
    ids.forEach((id, i) => {
      const f = (i + 1) / (ids.length + 1);
      pos.set(id, {
        x: pa[0] + (pb[0] - pa[0]) * f,
        y: pa[1] + (pb[1] - pa[1]) * f,
      });
    });
  }
  return pos;
}
