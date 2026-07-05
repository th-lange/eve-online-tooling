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
  useInternalNode,
  getBezierPath,
  EdgeLabelRenderer,
  type Edge,
  type EdgeProps,
  type InternalNode,
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
  /** Render a solid filled tile in this colour with black text (stands out
   *  most — e.g. special hub systems). Overrides accent/bg. */
  fill?: string;
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

/** Hex colour of a node by kind — used to fill it when selected. */
const KIND_HEX: Record<NodeKind, string> = {
  wspace: "#a855f7",
  hisec: "#34d399",
  lowsec: "#fbbf24",
  nullsec: "#fb7185",
  unknown: "#a1a1aa",
};

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
  fill?: string;
};

function SystemNode({ data, selected }: NodeProps<Node<SystemNodeData>>) {
  const style: CSSProperties = {};
  // The node's own colour (explicit fill/accent, else its security band).
  const bandColor = data.fill ?? data.accent ?? KIND_HEX[data.kind];
  // A selected node fills with that band colour (keeping the region's colour,
  // just solid with contrasting text) — as does an explicitly-filled node.
  const filled = !!data.fill || (!!selected && !!bandColor);
  if (filled && bandColor) {
    style.backgroundColor = bandColor;
    style.borderColor = bandColor;
    style.color = "#000";
  } else {
    if (data.accent) {
      style.borderColor = data.accent;
      style.color = data.accent;
    }
    if (data.ring) style.boxShadow = `0 0 0 2px ${data.ring}`;
    if (data.bg) style.backgroundColor = data.bg;
  }
  return (
    <div
      className={`rounded border px-3 py-1.5 text-xs shadow ${
        filled
          ? "font-semibold"
          : data.accent
            ? "bg-zinc-900 text-zinc-100"
            : kindClass(data.kind)
      } ${data.current ? "ring-2 ring-emerald-400" : ""}`}
      style={filled || data.accent || data.ring || data.bg ? style : undefined}
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

// --- Floating edges: connect at whichever side of each node faces the other,
// so links take the shortest path instead of always exiting on the right. ---

/** Point where the line to `target`'s centre crosses `node`'s border. */
function nodeIntersection(node: InternalNode, target: InternalNode) {
  const w = (node.measured.width ?? 0) / 2;
  const h = (node.measured.height ?? 0) / 2;
  const x2 = node.internals.positionAbsolute.x + w;
  const y2 = node.internals.positionAbsolute.y + h;
  const x1 =
    target.internals.positionAbsolute.x + (target.measured.width ?? 0) / 2;
  const y1 =
    target.internals.positionAbsolute.y + (target.measured.height ?? 0) / 2;
  const xx1 = (x1 - x2) / (2 * w) - (y1 - y2) / (2 * h);
  const yy1 = (x1 - x2) / (2 * w) + (y1 - y2) / (2 * h);
  const a = 1 / (Math.abs(xx1) + Math.abs(yy1) || 1);
  return {
    x: w * (a * xx1 + a * yy1) + x2,
    y: h * (-a * xx1 + a * yy1) + y2,
  };
}

/** Which side of `node` an intersection point sits on. */
function edgeSide(node: InternalNode, p: { x: number; y: number }): Position {
  const nx = node.internals.positionAbsolute.x;
  const ny = node.internals.positionAbsolute.y;
  const w = node.measured.width ?? 0;
  if (Math.round(p.x) <= Math.round(nx) + 1) return Position.Left;
  if (Math.round(p.x) >= Math.round(nx + w) - 1) return Position.Right;
  if (Math.round(p.y) <= Math.round(ny) + 1) return Position.Top;
  return Position.Bottom;
}

function FloatingEdge({
  id,
  source,
  target,
  markerEnd,
  style,
  label,
}: EdgeProps) {
  const s = useInternalNode(source);
  const t = useInternalNode(target);
  if (!s || !t) return null;
  const sp = nodeIntersection(s, t);
  const tp = nodeIntersection(t, s);
  const [path, labelX, labelY] = getBezierPath({
    sourceX: sp.x,
    sourceY: sp.y,
    sourcePosition: edgeSide(s, sp),
    targetX: tp.x,
    targetY: tp.y,
    targetPosition: edgeSide(t, tp),
  });
  return (
    <>
      <path
        id={id}
        className="react-flow__edge-path"
        d={path}
        markerEnd={markerEnd}
        style={style}
      />
      {label && (
        <EdgeLabelRenderer>
          <div
            className="pointer-events-none absolute rounded bg-zinc-900 px-1 text-[10px] text-zinc-400"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
          >
            {label}
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
}

const edgeTypes = { floating: FloatingEdge };

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
  onSelectionChange,
  height = 360,
  storageKey,
  defaultMode,
}: {
  nodes: SystemGraphNode[];
  edges: SystemGraphEdge[];
  rootId?: string;
  onNodeClick?: (id: string) => void;
  /** Fired with the ids of the currently-selected nodes whenever it changes. */
  onSelectionChange?: (ids: string[]) => void;
  height?: number;
  /** Persist hand-dragged positions under this key (localStorage). */
  storageKey?: string;
  /** Initial layout when nothing is saved (else star-if-coords, otherwise tree). */
  defaultMode?: LayoutMode;
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
        fill: n.fill,
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
    if (defaultMode) return defaultMode;
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
      // Preserve which node is selected — otherwise a re-render (e.g. clicking a
      // system on the scan map re-runs this effect) wipes the selection before
      // its highlight can show.
      const curSel = new Map(cur.map((n) => [n.id, n.selected]));
      return inputNodes.map((n) => ({
        ...toRfNode(
          n,
          curPos.get(n.id) ?? saved[n.id] ?? base.get(n.id) ?? { x: 0, y: 0 },
        ),
        selected: curSel.get(n.id) ?? false,
      }));
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
          type: "floating",
          label: e.label,
          animated: e.variant === "wormhole" && !e.dashed,
          style: {
            stroke: color,
            strokeWidth: 1.5,
            strokeDasharray: e.dashed ? "5 4" : undefined,
          },
        };
      }),
    [edges],
  );

  const handleNodeClick = useCallback(
    (_: unknown, node: Node) => onNodeClick?.(node.id),
    [onNodeClick],
  );

  const handleSelectionChange = useCallback(
    ({ nodes }: { nodes: Node[] }) =>
      onSelectionChange?.(nodes.map((n) => n.id)),
    [onSelectionChange],
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
      edgeTypes={edgeTypes}
      onNodesChange={onNodesChange}
      onNodeClick={handleNodeClick}
      onSelectionChange={handleSelectionChange}
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
