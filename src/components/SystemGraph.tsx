import { useCallback, useEffect, useMemo } from "react";
import {
  ReactFlow,
  Background,
  Controls,
  Panel,
  Handle,
  Position,
  useNodesState,
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
      <Handle
        type="target"
        position={Position.Left}
        className="!bg-transparent !border-0"
      />
      <div className="font-medium leading-tight">{data.label}</div>
      {data.sub && (
        <div className="text-[10px] opacity-70 leading-tight">{data.sub}</div>
      )}
      <Handle
        type="source"
        position={Position.Right}
        className="!bg-transparent !border-0"
      />
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

/** Load saved node positions for a graph (keyed by `storageKey`), if any. */
function loadPositions(key?: string): Record<string, { x: number; y: number }> {
  if (!key || typeof localStorage === "undefined") return {};
  try {
    return JSON.parse(localStorage.getItem(`sysgraph.${key}`) ?? "{}");
  } catch {
    return {};
  }
}

function savePositions(
  key: string,
  nodes: { id: string; position: { x: number; y: number } }[],
) {
  if (typeof localStorage === "undefined") return;
  const map: Record<string, { x: number; y: number }> = {};
  for (const n of nodes) map[n.id] = n.position;
  try {
    localStorage.setItem(`sysgraph.${key}`, JSON.stringify(map));
  } catch {
    /* ignore quota / unavailable */
  }
}

/**
 * A pan/zoom graph of solar systems and their connections, shared by the
 * wormhole chain map and the travel trail. Nodes are **draggable** and
 * multi-selectable; when `storageKey` is set, hand-placed positions persist
 * across refreshes (with a Reset layout control). Callers pass plain node/edge
 * sets; layout, styling and interactivity are handled here.
 */
export function SystemGraph({
  nodes: inputNodes,
  edges,
  rootId,
  onNodeClick,
  height = 360,
  storageKey,
}: {
  nodes: SystemGraphNode[];
  edges: SystemGraphEdge[];
  rootId?: string;
  onNodeClick?: (id: string) => void;
  height?: number;
  /** Persist hand-dragged positions under this key (localStorage). */
  storageKey?: string;
}) {
  const layout = useMemo(
    () => computeLayout(inputNodes, edges, rootId),
    [inputNodes, edges, rootId],
  );

  const toRfNode = useCallback(
    (
      n: SystemGraphNode,
      pos: { x: number; y: number },
    ): Node<SystemNodeData> => ({
      id: n.id,
      type: "system",
      position: pos,
      data: { label: n.label, kind: n.kind, sub: n.sub, current: n.current },
    }),
    [],
  );

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<
    Node<SystemNodeData>
  >([]);

  // Sync nodes when the inputs change, but keep positions the user has already
  // dragged (or previously saved) — only new nodes get a fresh computed spot.
  useEffect(() => {
    const saved = loadPositions(storageKey);
    setRfNodes((cur) => {
      const curPos = new Map(cur.map((n) => [n.id, n.position]));
      return inputNodes.map((n) =>
        toRfNode(
          n,
          curPos.get(n.id) ?? saved[n.id] ?? layout.get(n.id) ?? { x: 0, y: 0 },
        ),
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputNodes, layout, storageKey]);

  const rfEdges: Edge[] = useMemo(
    () =>
      edges.map((e, i) => {
        const color =
          e.color ?? (e.variant === "wormhole" ? "#a855f7" : "#52525b");
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

  // Persist positions after a drag settles (no-op state set just to read current).
  const persist = useCallback(() => {
    if (!storageKey) return;
    setRfNodes((cur) => {
      savePositions(storageKey, cur);
      return cur;
    });
  }, [storageKey, setRfNodes]);

  const resetLayout = useCallback(() => {
    const fresh = computeLayout(inputNodes, edges, rootId);
    setRfNodes(
      inputNodes.map((n) => toRfNode(n, fresh.get(n.id) ?? { x: 0, y: 0 })),
    );
    if (storageKey && typeof localStorage !== "undefined") {
      try {
        localStorage.removeItem(`sysgraph.${storageKey}`);
      } catch {
        /* ignore */
      }
    }
  }, [inputNodes, edges, rootId, storageKey, toRfNode, setRfNodes]);

  return (
    <div
      style={{ height }}
      className="rounded border border-zinc-800 bg-zinc-950/40"
    >
      <ReactFlow
        nodes={rfNodes}
        edges={rfEdges}
        nodeTypes={nodeTypes}
        onNodesChange={onNodesChange}
        onNodeClick={handleNodeClick}
        onNodeDragStop={persist}
        fitView
        proOptions={{ hideAttribution: true }}
        minZoom={0.2}
      >
        <Background color="#27272a" gap={20} />
        <Controls
          showInteractive={false}
          className="!bg-zinc-900 !border-zinc-700"
        />
        {storageKey && (
          <Panel position="top-right">
            <button
              onClick={resetLayout}
              className="rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800"
              title="Re-run the automatic layout and clear saved positions"
            >
              Reset layout
            </button>
          </Panel>
        )}
      </ReactFlow>
    </div>
  );
}
