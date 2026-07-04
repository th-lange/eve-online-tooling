import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
} from "react";
import { createPortal } from "react-dom";
import { Maximize2, Minimize2 } from "lucide-react";
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
  /** Override the border/text colour with a hex (e.g. faction control). */
  accent?: string;
  /** Draw an outline ring in this hex (e.g. contested state). */
  ring?: string;
  /** Tint the tile background with this colour (e.g. contested state). */
  bg?: string;
  /** Seed the initial position (e.g. real map coordinates) instead of the
   *  computed BFS layout. Overridden once the user drags a node. */
  x?: number;
  y?: number;
  /** Grouping key (e.g. region) — enables the "Region" cluster layout. */
  group?: string;
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

/**
 * How the nodes are arranged. `star` uses each node's real coordinates (only
 * offered when the nodes carry them); `tree` is the stargate BFS layout; `grid`
 * and `list` are index-based fallbacks. Switchable at runtime.
 */
export type LayoutMode = "star" | "region" | "tree" | "grid" | "list";
const LAYOUT_LABELS: Record<LayoutMode, string> = {
  star: "Star",
  region: "Region",
  tree: "Tree",
  grid: "Grid",
  list: "List",
};
const GRID_COL = 172;
const GRID_ROW = 66;
const LIST_ROW = 56;

/**
 * Cluster nodes by their `group` (e.g. region): each group is a mini-grid of its
 * systems, and the groups themselves are tiled on a coarse grid. Cell size is
 * the largest group's, so clusters never overlap. Pure.
 */
function groupedLayout(
  nodes: SystemGraphNode[],
): Map<string, { x: number; y: number }> {
  const groups = new Map<string, SystemGraphNode[]>();
  for (const n of nodes) {
    const g = n.group ?? "—";
    const arr = groups.get(g);
    if (arr) arr.push(n);
    else groups.set(g, [n]);
  }
  const names = [...groups.keys()].sort();
  const dims = names.map((name) => {
    const count = groups.get(name)!.length;
    const cols = Math.max(1, Math.ceil(Math.sqrt(count)));
    return { cols, rows: Math.ceil(count / cols) };
  });
  // Uniform cluster cell (largest group + a one-tile gutter) → no overlap.
  const cellW = (Math.max(...dims.map((d) => d.cols)) + 1) * GRID_COL;
  const cellH = (Math.max(...dims.map((d) => d.rows)) + 1) * GRID_ROW;
  const groupCols = Math.max(1, Math.ceil(Math.sqrt(names.length)));

  const pos = new Map<string, { x: number; y: number }>();
  names.forEach((name, gi) => {
    const ox = (gi % groupCols) * cellW;
    const oy = Math.floor(gi / groupCols) * cellH;
    const cols = dims[gi].cols;
    groups.get(name)!.forEach((n, i) => {
      pos.set(n.id, {
        x: ox + (i % cols) * GRID_COL,
        y: oy + Math.floor(i / cols) * GRID_ROW,
      });
    });
  });
  return pos;
}

/** Node positions for a given layout mode. `tree` reuses the BFS `layout`. */
function positionsForMode(
  mode: LayoutMode,
  nodes: SystemGraphNode[],
  tree: Map<string, { x: number; y: number }>,
): Map<string, { x: number; y: number }> {
  if (mode === "tree") return tree;
  if (mode === "region") return groupedLayout(nodes);
  const pos = new Map<string, { x: number; y: number }>();
  if (mode === "star") {
    nodes.forEach((n) =>
      pos.set(
        n.id,
        n.x != null && n.y != null
          ? { x: n.x, y: n.y }
          : (tree.get(n.id) ?? { x: 0, y: 0 }),
      ),
    );
  } else if (mode === "grid") {
    const cols = Math.max(1, Math.ceil(Math.sqrt(nodes.length)));
    nodes.forEach((n, i) =>
      pos.set(n.id, {
        x: (i % cols) * GRID_COL,
        y: Math.floor(i / cols) * GRID_ROW,
      }),
    );
  } else {
    nodes.forEach((n, i) => pos.set(n.id, { x: 0, y: i * LIST_ROW }));
  }
  return pos;
}

type SystemNodeData = {
  label: string;
  kind: NodeKind;
  sub?: string;
  current?: boolean;
  accent?: string;
  ring?: string;
  bg?: string;
};

function SystemNode({ data }: NodeProps<Node<SystemNodeData>>) {
  const style: CSSProperties = {};
  if (data.accent) {
    style.borderColor = data.accent;
    style.color = data.accent;
  }
  if (data.ring) style.boxShadow = `0 0 0 2px ${data.ring}`;
  if (data.bg) style.backgroundColor = data.bg;
  return (
    <div
      className={`rounded border px-3 py-1.5 text-xs shadow ${
        data.accent ? "bg-zinc-900 text-zinc-100" : kindClass(data.kind)
      } ${data.current ? "ring-2 ring-emerald-400" : ""}`}
      style={data.accent || data.ring || data.bg ? style : undefined}
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
      data: {
        label: n.label,
        kind: n.kind,
        sub: n.sub,
        current: n.current,
        accent: n.accent,
        ring: n.ring,
        bg: n.bg,
      },
    }),
    [],
  );

  // Available layouts: `star` only when the nodes carry real coordinates.
  const hasCoords = useMemo(
    () => inputNodes.some((n) => n.x != null && n.y != null),
    [inputNodes],
  );
  const hasGroups = useMemo(
    () => inputNodes.some((n) => n.group != null),
    [inputNodes],
  );
  const modes = useMemo<LayoutMode[]>(() => {
    const m: LayoutMode[] = [];
    if (hasCoords) m.push("star");
    if (hasGroups) m.push("region");
    m.push("tree", "grid", "list");
    return m;
  }, [hasCoords, hasGroups]);

  const [mode, setMode] = useState<LayoutMode>(() => {
    if (storageKey && typeof localStorage !== "undefined") {
      const saved = localStorage.getItem(`sysgraph.mode.${storageKey}`);
      if (
        saved === "star" ||
        saved === "region" ||
        saved === "tree" ||
        saved === "grid" ||
        saved === "list"
      ) {
        return saved;
      }
    }
    // Default to the star map when coordinates are available, else the tree.
    return inputNodes.some((n) => n.x != null && n.y != null) ? "star" : "tree";
  });

  const positionsFor = useCallback(
    (m: LayoutMode) => positionsForMode(m, inputNodes, layout),
    [inputNodes, layout],
  );

  // Full-screen toggle (Escape exits).
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!maximized) return;
    const onKey = (e: KeyboardEvent) =>
      e.key === "Escape" && setMaximized(false);
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [maximized]);

  const [rfNodes, setRfNodes, onNodesChange] = useNodesState<
    Node<SystemNodeData>
  >([]);

  // Sync nodes when the inputs change, but keep positions the user has already
  // dragged (or previously saved) — only new nodes get a spot from the current
  // layout mode. (Mode switches are handled by `applyMode`, so `mode` is read
  // via closure and left out of the deps.)
  useEffect(() => {
    const saved = loadPositions(storageKey);
    const base = positionsFor(mode);
    setRfNodes((cur) => {
      const curPos = new Map(cur.map((n) => [n.id, n.position]));
      return inputNodes.map((n) =>
        toRfNode(
          n,
          curPos.get(n.id) ?? saved[n.id] ?? base.get(n.id) ?? { x: 0, y: 0 },
        ),
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inputNodes, positionsFor, storageKey]);

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

  // Switch layout: re-place every node from the chosen mode, drop saved drags,
  // and remember the choice. Clicking the current mode acts as a reset.
  const applyMode = useCallback(
    (m: LayoutMode) => {
      setMode(m);
      if (storageKey && typeof localStorage !== "undefined") {
        try {
          localStorage.setItem(`sysgraph.mode.${storageKey}`, m);
          localStorage.removeItem(`sysgraph.${storageKey}`);
        } catch {
          /* ignore */
        }
      }
      const base = positionsFor(m);
      setRfNodes(
        inputNodes.map((n) => toRfNode(n, base.get(n.id) ?? { x: 0, y: 0 })),
      );
    },
    [storageKey, positionsFor, inputNodes, toRfNode, setRfNodes],
  );

  const graph = (
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
      <Panel position="top-right">
        <div className="flex items-center gap-1">
          {modes.map((m) => (
            <button
              key={m}
              onClick={() => applyMode(m)}
              className={`rounded border px-2 py-0.5 text-[11px] ${
                mode === m
                  ? "border-zinc-500 bg-zinc-700 text-zinc-100"
                  : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
              }`}
              title={`${LAYOUT_LABELS[m]} layout`}
            >
              {LAYOUT_LABELS[m]}
            </button>
          ))}
          {storageKey && (
            <button
              onClick={() => applyMode(mode)}
              className="rounded border border-zinc-700 bg-zinc-900 px-2 py-0.5 text-[11px] text-zinc-400 hover:bg-zinc-800"
              title="Re-run this layout and clear saved positions"
            >
              Reset
            </button>
          )}
          <button
            onClick={() => setMaximized((v) => !v)}
            className="flex items-center rounded border border-zinc-700 bg-zinc-900 p-1 text-zinc-300 hover:bg-zinc-800"
            title={maximized ? "Exit full screen (Esc)" : "Maximize"}
            aria-label={maximized ? "Exit full screen" : "Maximize"}
          >
            {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
        </div>
      </Panel>
    </ReactFlow>
  );

  // Full-screen: portal a fixed overlay so it escapes the layout's clipping.
  if (maximized) {
    return createPortal(
      <div className="fixed inset-0 z-50 bg-zinc-950">{graph}</div>,
      document.body,
    );
  }
  return (
    <div
      style={{ height }}
      className="rounded border border-zinc-800 bg-zinc-950/40"
    >
      {graph}
    </div>
  );
}
