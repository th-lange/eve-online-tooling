import { describe, expect, it } from "vitest";
import {
  buildScanTree,
  computeGreenEdges,
  edgeKey,
  homeTriangleLayout,
  keptSets,
  treePath,
} from "./graph";

// Test tree, rooted at 1:
//        1
//       / \
//      2   3
//     /     \
//    4       5
//            |
//            6
// Candidates: 4, 5, 6.
const EDGES: [number, number][] = [
  [1, 2],
  [1, 3],
  [2, 4],
  [3, 5],
  [5, 6],
];
const CANDS = new Set([4, 5, 6]);

describe("buildScanTree", () => {
  it("computes BFS parents back to the origin", () => {
    const { parent } = buildScanTree(EDGES, 1, CANDS);
    expect(parent.get(4)).toBe(2);
    expect(parent.get(2)).toBe(1);
    expect(parent.get(6)).toBe(5);
    expect(parent.has(1)).toBe(false);
  });

  it("collects each subtree's candidates (inclusive)", () => {
    const { subtreeCands } = buildScanTree(EDGES, 1, CANDS);
    expect(subtreeCands.get(2)).toEqual(new Set([4]));
    expect(subtreeCands.get(3)).toEqual(new Set([5, 6]));
    expect(subtreeCands.get(5)).toEqual(new Set([5, 6]));
    expect(subtreeCands.get(1)).toEqual(new Set([4, 5, 6]));
  });
});

describe("treePath", () => {
  const { parent } = buildScanTree(EDGES, 1, CANDS);

  it("routes between branches via the lowest common ancestor", () => {
    expect(treePath(parent, 1, 4, 6)).toEqual([4, 2, 1, 3, 5, 6]);
  });

  it("routes straight down within one branch", () => {
    expect(treePath(parent, 1, 3, 6)).toEqual([3, 5, 6]);
  });

  it("is a point for a === b", () => {
    expect(treePath(parent, 1, 4, 4)).toEqual([4]);
  });
});

describe("keptSets", () => {
  const { parent } = buildScanTree(EDGES, 1, CANDS);

  it("keeps only the root-paths to active candidates", () => {
    const kept = keptSets(new Set([4]), parent, 1);
    expect(kept.nodes).toEqual(new Set([1, 2, 4]));
    expect(kept.edges).toEqual(new Set([edgeKey(4, 2), edgeKey(2, 1)]));
  });

  it("unions paths for several candidates", () => {
    const kept = keptSets(new Set([4, 6]), parent, 1);
    expect(kept.nodes).toEqual(new Set([1, 2, 4, 3, 5, 6]));
    expect(kept.edges.size).toBe(5);
  });
});

describe("computeGreenEdges", () => {
  const { parent } = buildScanTree(EDGES, 1, CANDS);
  const base = {
    parent,
    originId: 1,
    orderedCands: [4, 5, 6],
    candIds: CANDS,
  };

  it("with nothing ticked, greens the origin → first candidate leg", () => {
    const green = computeGreenEdges({
      ...base,
      visited: new Set<number>(),
      selected: [],
    });
    expect(green).toEqual(new Set([edgeKey(1, 2), edgeKey(2, 4)]));
  });

  it("after ticking, greens from the last ticked to the next unticked", () => {
    const green = computeGreenEdges({
      ...base,
      visited: new Set([4]),
      selected: [],
    });
    // 4 → 5 crosses the LCA at 1.
    expect(green).toEqual(
      new Set([edgeKey(4, 2), edgeKey(2, 1), edgeKey(1, 3), edgeKey(3, 5)]),
    );
  });

  it("all ticked → nothing green", () => {
    const green = computeGreenEdges({
      ...base,
      visited: new Set([4, 5, 6]),
      selected: [],
    });
    expect(green.size).toBe(0);
  });

  it("selecting a candidate greens its prev and next legs", () => {
    const green = computeGreenEdges({
      ...base,
      visited: new Set<number>(),
      selected: [5],
    });
    // prev leg 4→5 (via 2,1,3) plus next leg 5→6.
    expect(green.has(edgeKey(4, 2))).toBe(true);
    expect(green.has(edgeKey(1, 3))).toBe(true);
    expect(green.has(edgeKey(5, 6))).toBe(true);
  });

  it("ignores selection of a non-candidate (travel) system", () => {
    const green = computeGreenEdges({
      ...base,
      visited: new Set<number>(),
      selected: [3],
    });
    expect(green).toEqual(new Set([edgeKey(1, 2), edgeKey(2, 4)]));
  });
});

describe("homeTriangleLayout", () => {
  // Minimal 6-system "Pochven": the three homes plus one system between each
  // pair of homes (K-A, A-N, N-K).
  const systems = [
    { systemId: 10, name: "Kino" },
    { systemId: 20, name: "Archee" },
    { systemId: 30, name: "Niarja" },
    { systemId: 12, name: "MidKA" },
    { systemId: 23, name: "MidAN" },
    { systemId: 31, name: "MidNK" },
  ];
  const edges: [number, number][] = [
    [10, 12],
    [12, 20],
    [20, 23],
    [23, 30],
    [30, 31],
    [31, 10],
  ];

  it("pins the homes at three distinct corners", () => {
    const pos = homeTriangleLayout(systems, edges);
    const corners = [pos.get(10)!, pos.get(20)!, pos.get(30)!];
    expect(new Set(corners.map((p) => `${p.x},${p.y}`)).size).toBe(3);
  });

  it("places each mid system on the segment between its two nearest homes", () => {
    const pos = homeTriangleLayout(systems, edges);
    const kino = pos.get(10)!;
    const archee = pos.get(20)!;
    const mid = pos.get(12)!; // between Kino and Archee
    // Collinear: cross product of (mid-kino) × (archee-kino) ≈ 0.
    const cross =
      (mid.x - kino.x) * (archee.y - kino.y) -
      (mid.y - kino.y) * (archee.x - kino.x);
    expect(Math.abs(cross)).toBeLessThan(1e-6);
  });
});
