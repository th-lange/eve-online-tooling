import { describe, expect, it } from "vitest";
import type { BreadcrumbEntry } from "../../lib/api";
import { buildTrailEdges } from "./travelEdges";

function hop(
  systemId: number,
  over?: Partial<BreadcrumbEntry>,
): BreadcrumbEntry {
  return {
    systemId,
    name: `Sys${systemId}`,
    security: 0.5,
    region: "Region",
    wspace: false,
    enteredAt: 0,
    gapJumps: 1,
    ...over,
  };
}

describe("buildTrailEdges", () => {
  it("draws one edge when a leg is re-travelled in the opposite direction", () => {
    const edges = buildTrailEdges([hop(1), hop(2), hop(1)]);
    expect(edges).toHaveLength(1);
    expect(edges[0]).toMatchObject({ source: "1", target: "2" });
  });

  it("keeps the first traversal's styling on a re-crossing", () => {
    // Outbound 2→3 skipped polls (3 jumps, dashed); the 3→2 return with a
    // clean gap must not restyle the existing edge.
    const edges = buildTrailEdges([
      hop(1),
      hop(2),
      hop(3, { gapJumps: 3 }),
      hop(2),
    ]);
    expect(edges).toHaveLength(2);
    expect(edges[1]).toMatchObject({
      source: "2",
      target: "3",
      dashed: true,
      label: "3 jumps",
    });
  });

  it("skips self-legs and marks k↔w transitions as wormholes", () => {
    const edges = buildTrailEdges([
      hop(1),
      hop(1),
      hop(31000005, { wspace: true, gapJumps: -1 }),
    ]);
    expect(edges).toHaveLength(1);
    expect(edges[0].variant).toBe("wormhole");
  });
});
