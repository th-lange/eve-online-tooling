import {
  SystemGraph,
  type SystemGraphEdge,
  type SystemGraphNode,
} from "../../components/SystemGraph";
import type { ConnectionView } from "../../lib/api";

/** Wormhole edge colour by mass status (fresh → reduced → critical). */
function massEdgeColor(mass: string): string {
  if (mass === "critical") return "#f43f5e";
  if (mass === "reduced") return "#f59e0b";
  return "#a855f7";
}

/** The two special EVE-Scout hub systems → a distinctive node colour. Thera is
 * the shattered wormhole hub; Turnur is its lowsec counterpart. */
const SPECIAL_HUBS: Record<string, string> = {
  Thera: "#2dd4bf", // teal
  Turnur: "#e879f9", // fuchsia
};

/** Interactive node-edge view of the mapped chain. Click a node to load its
 * signatures below. Complements the flat table (kept as the edit pane). */
export function ChainGraph({
  rows,
  onSelectSystem,
}: {
  rows: ConnectionView[];
  onSelectSystem: (id: number, name: string) => void;
}) {
  const nodeMap = new Map<number, SystemGraphNode>();
  const addNode = (id: number, name: string, wspace: boolean) => {
    if (!nodeMap.has(id)) {
      const special = SPECIAL_HUBS[name];
      nodeMap.set(id, {
        id: String(id),
        label: name,
        kind: wspace ? "wspace" : "unknown",
        ...(special && { fill: special, sub: "EVE-Scout hub" }),
      });
    }
  };
  rows.forEach((c) => {
    addNode(c.sourceSystemId, c.sourceName, c.sourceWspace);
    addNode(c.targetSystemId, c.targetName, c.targetWspace);
  });
  const edges: SystemGraphEdge[] = rows.map((c) => ({
    source: String(c.sourceSystemId),
    target: String(c.targetSystemId),
    variant: c.scope === "wormhole" ? "wormhole" : "stargate",
    dashed: c.eol,
    color: c.scope === "wormhole" ? massEdgeColor(c.massStatus) : undefined,
    label:
      c.scope === "wormhole" && c.massStatus !== "fresh"
        ? c.massStatus
        : undefined,
  }));
  const nodes = [...nodeMap.values()];

  if (nodes.length === 0) return null;

  return (
    <div className="mt-4">
      <div className="mb-1 flex items-center gap-3 text-[11px] uppercase tracking-wide text-zinc-500">
        <span>Chain map</span>
        <span className="normal-case tracking-normal text-zinc-600">
          click a system for its signatures · drag to rearrange (saved) · dashed
          = EOL · purple = wormhole ·{" "}
          <span style={{ color: SPECIAL_HUBS.Thera }}>teal = Thera</span> ·{" "}
          <span style={{ color: SPECIAL_HUBS.Turnur }}>pink = Turnur</span>
        </span>
      </div>
      <SystemGraph
        nodes={nodes}
        edges={edges}
        storageKey="wh-chain"
        onNodeClick={(id) => {
          const n = nodeMap.get(Number(id));
          if (n) onSelectSystem(Number(id), n.label);
        }}
      />
    </div>
  );
}
