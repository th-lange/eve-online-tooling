import { describe, expect, it } from "vitest";
import type { Neighbourhood } from "../../lib/api";
import {
  buildNeighbourhoodEdges,
  buildNeighbourhoodNodes,
} from "./neighbourhoodGraph";

const HOOD: Neighbourhood = {
  center: 30000142,
  nodes: [
    {
      systemId: 30000142,
      name: "Jita",
      region: "The Forge",
      security: 0.9,
      jumps: 1200,
      shipKills: 3,
      podKills: 1,
      npcKills: 40,
      distance: 0,
    },
    {
      systemId: 30000144,
      name: "Perimeter",
      region: "The Forge",
      security: 1.0,
      jumps: 300,
      shipKills: 0,
      podKills: 0,
      npcKills: 12,
      distance: 1,
    },
  ],
  edges: [[30000142, 30000144]],
};

describe("neighbourhood graph builders", () => {
  it("marks the centre current and labels distance on the rest", () => {
    const nodes = buildNeighbourhoodNodes(HOOD);
    expect(nodes[0]).toMatchObject({
      id: "30000142",
      current: true,
      sub: "0.9 · centre",
    });
    expect(nodes[1]).toMatchObject({
      id: "30000144",
      current: false,
      sub: "1.0 · 1j",
    });
    expect(nodes[0].stats).toEqual({
      kills: 3,
      podKills: 1,
      zkillId: 30000142,
    });
  });

  it("maps backend edge pairs onto stargate edges", () => {
    expect(buildNeighbourhoodEdges(HOOD)).toEqual([
      { source: "30000142", target: "30000144", variant: "stargate" },
    ]);
  });
});
