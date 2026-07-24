// Pure node/edge building for the neighbourhood graph — a non-component file
// so it can be unit-tested and react-refresh hot-reloads the page cleanly.

import type {
  SystemGraphEdge,
  SystemGraphNode,
} from "../../components/SystemGraph";
import { kindFromSecurity } from "../../components/systemGraphLayout";
import type { Neighbourhood } from "../../lib/api";

/** Graph nodes for the neighbourhood: the centre highlighted (distance 0),
 * each system carrying its sec status, jumps-from-centre and last-hour kill
 * heat (linking to zKillboard). */
export function buildNeighbourhoodNodes(
  hood: Neighbourhood,
): SystemGraphNode[] {
  return hood.nodes.map((n) => ({
    id: String(n.systemId),
    label: n.name || `#${n.systemId}`,
    kind: kindFromSecurity(n.security),
    sub:
      n.distance === 0
        ? `${n.security.toFixed(1)} · centre`
        : `${n.security.toFixed(1)} · ${n.distance}j`,
    stats: { kills: n.shipKills, podKills: n.podKills, zkillId: n.systemId },
    current: n.distance === 0,
  }));
}

/** Stargate edges between neighbourhood systems (backend-deduped pairs). */
export function buildNeighbourhoodEdges(
  hood: Neighbourhood,
): SystemGraphEdge[] {
  return hood.edges.map(([a, b]) => ({
    source: String(a),
    target: String(b),
    variant: "stargate" as const,
  }));
}
