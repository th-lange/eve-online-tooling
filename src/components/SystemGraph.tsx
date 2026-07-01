import { useCallback, useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";

/** Visual class of a system node — drives its colour. */
export type NodeKind = "wspace" | "hisec" | "lowsec" | "nullsec" | "unknown";

export interface SystemGraphNode {
  id: string;
  label: string;
  kind: NodeKind;
  /** Secondary line (e.g. sec status, region, or a signature code). */
  sub?: string;
  /** Highlight as the current / focused system. */
  current?: boolean;
}

export interface SystemGraphEdge {
  source: string;
  target: string;
  /** Stargate vs wormhole styling. */
  variant?: "stargate" | "wormhole";
  /** Dash the edge (e.g. EOL holes). */
  dashed?: boolean;
  /** Stroke colour override (defaults by variant). */
  color?: string;
  /** Optional short label rendered on the edge. */
  label?: string;
}

const COL = 190;
const ROW = 74;

/** Colour of a node's border/text by kind. */
function kindClass(kind: NodeKind): string {
  switch (kind) {
    case "wspace":
      return "border-purple-600 bg-purple-950/50 text-purple-200";
    case "hisec":
      return "border-emerald-700 bg-zinc-900 text-emerald-200";
    case "lowsec":
      return "border-amber-700 bg-zinc-900 text-amber-200";
    case "nullsec":
      return "border-rose-800 bg-zinc-900 text-rose-200";
    default:
      return "border-zinc-700 bg-zinc-900 text-zinc-200";
  }
}

/** Map a raw SDE security value to a node kind (w-space handled by caller). */
export function kindFromSecurity(security: number): NodeKind {
  if (security >= 0.5) return "hisec";
  if (security > 0.0) return "lowsec";
  return "nullsec";
}

type SystemNodeData = {
  label: string;
  kind: NodeKind;
  sub?: string;
  current?: boolean;
};

function SystemNode({ data }: NodeProps<Node<SystemNodeData>>) {
  return (
    <div
      className={`rounded border px-3 py-1.5 text-xs shadow ${kindClass(data.kind)} ${
        data.current ? "ring-2 ring-emerald-400" : ""
      }`}
    >
      {/* Hidden connection points so edges attach cleanly left↔right. */}
      <Handle type="target" position={Position.Left} className="!bg-transparent !border-0" />
      <div className="font-medium leading-tight">{data.label}</div>
      {data.sub && <div className="text-[10px] opacity-70 leading-tight">{data.sub}</div>}
      <Handle type="source" position={Position.Right} className="!bg-transparent !border-0" />
    </div>
  );
}

const nodeTypes = { system: SystemNode };

/**
 * Lay out nodes in BFS layers left→right (depth = column, siblings stacked in
 * rows). Deterministic and dependency-free — good enough for chain/trail shapes.
 * Disconnected components stack below one another. Pure.
 */
export function computeLayout(
  nodes: SystemGraphNode[],
  edges: SystemGraphEdge[],
  rootId?: string,
): Map<string, { x: number; y: number }> {
  const adj = new Map<string, string[]>();
  nodes.forEach((n) => adj.set(n.id, []));
  edges.forEach((e) => {
    if (adj.has(e.source) && adj.has(e.target)) {
      adj.get(e.source)!.push(e.target);
      adj.get(e.target)!.push(e.source);
    }
  });

  const pos = new Map<string, { x: number; y: number }>();
  const visited = new Set<string>();
  const rowAtDepth = new Map<number, number>();

  // Visit the requested root first so it anchors the top-left.
  const order = nodes.map((n) => n.id);
  if (rootId && adj.has(rootId)) {
    order.sort((a, b) => (a === rootId ? -1 : b === rootId ? 1 : 0));
  }

  for (const start of order) {
    if (visited.has(start)) continue;
    const queue: [string, number][] = [[start, 0]];
    visited.add(start);
    while (queue.length) {
      const [id, depth] = queue.shift()!;
      const row = rowAtDepth.get(depth) ?? 0;
      rowAtDepth.set(depth, row + 1);
      pos.set(id, { x: depth * COL, y: row * ROW });
      for (const nb of adj.get(id) ?? []) {
        if (!visited.has(nb)) {
          visited.add(nb);
          queue.push([nb, depth + 1]);
        }
      }
    }
  }
  return pos;
}

/**
 * A pan/zoom graph of solar systems and their connections, shared by the
 * wormhole chain map and the travel trail. Callers pass plain node/edge sets;
 * layout, styling and interactivity are handled here.
 */
export function SystemGraph({
  nodes,
  edges,
  rootId,
  onNodeClick,
  height = 360,
}: {
  nodes: SystemGraphNode[];
  edges: SystemGraphEdge[];
  rootId?: string;
  onNodeClick?: (id: string) => void;
  height?: number;
}) {
  const layout = useMemo(() => computeLayout(nodes, edges, rootId), [nodes, edges, rootId]);

  const rfNodes: Node<SystemNodeData>[] = useMemo(
    () =>
      nodes.map((n) => ({
        id: n.id,
        type: "system",
        position: layout.get(n.id) ?? { x: 0, y: 0 },
        data: { label: n.label, kind: n.kind, sub: n.sub, current: n.current },
      })),
    [nodes, layout],
  );

  const rfEdges: Edge[] = useMemo(
    () =>
      edges.map((e, i) => {
        const color = e.color ?? (e.variant === "wormhole" ? "#a855f7" : "#52525b");
        return {
          id: `${e.source}-${e.target}-${i}`,
          source: e.source,
          target: e.target,
          label: e.label,
          animated: e.variant === "wormhole" && !e.dashed,
          style: {
            stroke: color,
            strokeWidth: 1.5,
            strokeDasharray: e.dashed ? "5 4" : undefined,
          },
          labelStyle: { fill: "#a1a1aa", fontSize: 10 },
          labelBgStyle: { fill: "#18181b" },
        };
      }),
    [edges],
  );

  const handleNodeClick = useCallback(
    (_: unknown, node: Node) => onNodeClick?.(node.id),
    [onNodeClick],
  );

  return (
    <div style={{ height }} className="rounded border border-zinc-800 bg-zinc-950/40">
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodeClick={handleNodeClick}
        fitView
        proOptions={{ hideAttribution: true }}
        minZoom={0.2}
      >
        <Background color="#27272a" gap={20} />
        <Controls showInteractive={false} className="!bg-zinc-900 !border-zinc-700" />
      </ReactFlow>
    </div>
  );
}
