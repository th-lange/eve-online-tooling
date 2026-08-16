import { memo, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ALL_CHARACTERS,
  activeCharacter,
  assetsLoad,
  authCharacters,
  authLogin,
  errorMessage,
  type AssetNode,
  type AssetRow,
  type AssetsPayload,
} from "../../lib/api";
import { formatInt, formatIsk, sortRows } from "../../lib/format";
import { usePersistentSort } from "../../lib/usePersistentSort";
import {
  SortHeaderCell,
  type SortColumn,
} from "../../components/SortHeaderCell";
import { Page, PageHeader } from "../../components/page";
import { Stat } from "../../components/Stat";
import { SdeGate } from "../../components/SdeGate";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { Building2, Copy, User } from "lucide-react";

const TITLE = "Assets";
const SUBTITLE =
  "Your roster's holdings, valued at Jita — and where each stack is worth the most.";

export function AssetsPage() {
  return (
    <SdeGate title={TITLE} subtitle={SUBTITLE}>
      <Workbench />
    </SdeGate>
  );
}

function Workbench() {
  const qc = useQueryClient();
  // View toggle — no reload needed, both views already in `assets`.
  const [view, setView] = useState<"flat" | "tree">("flat");
  const [search, setSearch] = useState("");
  const [treeSearch, setTreeSearch] = useState("");
  const [owners, setOwners] = useState<Set<string>>(new Set());
  const [treeOwners, setTreeOwners] = useState<Set<string>>(new Set());
  const [assets, setAssets] = useState<AssetsPayload | null>(null);

  const loadMut = useMutation({
    mutationFn: () => assetsLoad(),
    onSuccess: (d) => {
      setAssets(d);
      setOwners(new Set());
      setTreeOwners(new Set());
    },
  });

  // Follow the global character selector: reload whenever the active
  // character changes. Guard on the previous value so unrelated re-renders
  // don't trigger a reload.
  const active = useQuery({
    queryKey: ["auth", "active"],
    queryFn: activeCharacter,
  });
  const prevActive = useRef<number | null | undefined>(undefined);
  const inited = useRef(false);
  useEffect(() => {
    if (inited.current) return;
    inited.current = true;
    loadMut.mutate();
  }, [loadMut]);
  useEffect(() => {
    if (prevActive.current === undefined) {
      prevActive.current = active.data;
      return;
    }
    if (active.data === prevActive.current) return;
    prevActive.current = active.data;
    loadMut.mutate();
  }, [active.data, loadMut]);

  const chars = useQuery({
    queryKey: ["auth", "characters"],
    queryFn: authCharacters,
  });
  const login = useMutation({
    mutationFn: authLogin,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["auth"] }),
  });

  // ── Flat view ────────────────────────────────────────────────────────────

  const ownerList = useMemo(() => {
    const seen = new Map<string, boolean>();
    for (const r of assets?.rows ?? []) {
      if (!seen.has(r.owner)) seen.set(r.owner, r.isCorp);
    }
    return [...seen.entries()]
      .map(([name, isCorp]) => ({ name, isCorp }))
      .sort(
        (a, b) =>
          Number(a.isCorp) - Number(b.isCorp) || a.name.localeCompare(b.name),
      );
  }, [assets]);

  // Precompute each row's lowercased search haystack once per load.
  const haystacks = useMemo(() => {
    const m = new Map<AssetRow, string>();
    for (const r of assets?.rows ?? []) {
      m.set(
        r,
        [r.name, r.category, r.group, r.owner, r.station, r.solarSystem]
          .filter(Boolean)
          .join(" ")
          .toLowerCase(),
      );
    }
    return m;
  }, [assets]);
  const debouncedSearch = useDebouncedValue(search);
  const rows = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    let all = assets?.rows ?? [];
    if (owners.size > 0) all = all.filter((r) => owners.has(r.owner));
    if (!q) return all;
    return all.filter((r) => (haystacks.get(r) ?? "").includes(q));
  }, [assets, debouncedSearch, owners, haystacks]);

  // ── Tree view ─────────────────────────────────────────────────────────────

  const treeOwnerList = useMemo(() => {
    if (!assets) return [];
    const seen = new Map<string, boolean>();
    const walk = (nodes: AssetNode[]) => {
      for (const n of nodes) {
        if (n.owner != null && !seen.has(n.owner)) seen.set(n.owner, n.isCorp);
        walk(n.children);
      }
    };
    walk(assets.roots);
    return [...seen.entries()]
      .map(([name, isCorp]) => ({ name, isCorp }))
      .sort(
        (a, b) =>
          Number(a.isCorp) - Number(b.isCorp) || a.name.localeCompare(b.name),
      );
  }, [assets]);

  const treeHay = useMemo(() => {
    const m = new WeakMap<AssetNode, string>();
    const walk = (ns: AssetNode[]) => {
      for (const n of ns) {
        m.set(
          n,
          [n.name, n.category, n.group, n.metaGroup, n.owner]
            .filter(Boolean)
            .join(" ")
            .toLowerCase(),
        );
        walk(n.children);
      }
    };
    if (assets) walk(assets.roots);
    return m;
  }, [assets]);
  const debouncedTreeSearch = useDebouncedValue(treeSearch);
  const treeSearching = debouncedTreeSearch.trim().length > 0;
  const treeRoots = useMemo(() => {
    if (!assets) return [];
    let roots = assets.roots;
    if (treeOwners.size > 0) roots = filterTreeByOwners(roots, treeOwners);
    const q = debouncedTreeSearch.trim().toLowerCase();
    return q ? filterTree(roots, q, treeHay) : roots;
  }, [assets, treeOwners, debouncedTreeSearch, treeHay]);

  // ── Corp scope hint ───────────────────────────────────────────────────────
  const CORP_SCOPE = "esi-assets.read_corporation_assets.v1";
  const missingCorpScope = useMemo(() => {
    const list = chars.data;
    if (!list?.length) return false;
    const activeId = active.data;
    const targets =
      activeId === ALL_CHARACTERS
        ? list
        : list.filter((c) => c.characterId === activeId);
    return targets.some((c) => !c.scopes.includes(CORP_SCOPE));
  }, [chars.data, active.data]);

  const isTree = view === "tree";

  return (
    <Page>
      <PageHeader
        title={TITLE}
        subtitle={SUBTITLE}
        actions={
          <div className="flex items-center gap-2">
            <button
              onClick={() => setView((v) => (v === "flat" ? "tree" : "flat"))}
              disabled={!assets}
              className="rounded border border-zinc-700 px-4 py-1.5 text-sm font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
              title="Toggle between the flat valued list and the nested location tree"
            >
              {isTree ? "Flat list" : "Location tree"}
            </button>
            <button
              onClick={() => loadMut.mutate()}
              disabled={loadMut.isPending}
              className="rounded border border-zinc-700 px-4 py-1.5 text-sm font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
              title="Reload assets from ESI"
            >
              {loadMut.isPending ? "Loading…" : "Refresh"}
            </button>
          </div>
        }
      />

      {missingCorpScope && (
        <p className="mt-2 text-xs text-amber-400">
          Corp hangar data requires re-login with the current scopes.{" "}
          <button
            onClick={() => login.mutate()}
            disabled={login.isPending}
            className="underline disabled:opacity-50"
          >
            {login.isPending ? "Opening browser…" : "Re-login"}
          </button>
        </p>
      )}

      {loadMut.isError && (
        <div className="mt-3 text-sm text-rose-400">
          Failed: {errorMessage(loadMut.error)} — log in a character with the
          assets scope.
        </div>
      )}

      {assets && isTree && (
        <>
          <div className="mt-4 flex flex-wrap gap-6 text-sm">
            <Stat
              label="Sell value"
              value={formatIsk(assets.sellTotal)}
              accent="text-emerald-400"
            />
            <Stat
              label="Volume"
              value={`${formatInt(Math.round(assets.volumeTotal))} m³`}
            />
            <Stat label="Locations" value={formatInt(assets.roots.length)} />
          </div>
          {treeOwnerList.length > 1 && (
            <OwnerChips
              ownerList={treeOwnerList}
              selected={treeOwners}
              setSelected={setTreeOwners}
            />
          )}
          <input
            value={treeSearch}
            onChange={(e) => setTreeSearch(e.currentTarget.value)}
            placeholder="Search tree: name / category / group / metatype / owner…"
            className="mt-3 w-96 max-w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
          />
          <div className="mt-2 rounded border border-zinc-800">
            {treeRoots.map((n) => (
              <TreeRow key={n.id} node={n} depth={0} searching={treeSearching} />
            ))}
            {treeRoots.length === 0 && (
              <div className="px-3 py-6 text-center text-sm text-zinc-500">
                {treeSearching || treeOwners.size > 0
                  ? "No matches."
                  : "No assets."}
              </div>
            )}
          </div>
        </>
      )}

      {assets && !isTree && (
        <>
          <div className="mt-4 flex flex-wrap gap-6 text-sm">
            <Stat
              label="Sell value (net worth)"
              value={formatIsk(assets.sellTotal)}
              accent="text-emerald-400"
            />
            <Stat label="Buy value" value={formatIsk(assets.buyTotal)} />
            <Stat
              label="Volume"
              value={`${formatInt(Math.round(assets.volumeTotal))} m³`}
            />
            <Stat
              label="Item types"
              value={formatInt(new Set(assets.rows.map((r) => r.typeId)).size)}
            />
          </div>
          {ownerList.length > 1 && (
            <OwnerChips
              ownerList={ownerList}
              selected={owners}
              setSelected={setOwners}
            />
          )}
          <input
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            placeholder="Search: name / category / group / owner…"
            className="mt-3 w-72 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
          />
          <AssetTable rows={rows} />
        </>
      )}
    </Page>
  );
}

// ── Shared owner filter chips ─────────────────────────────────────────────────

function OwnerChips({
  ownerList,
  selected,
  setSelected,
}: {
  ownerList: { name: string; isCorp: boolean }[];
  selected: Set<string>;
  setSelected: React.Dispatch<React.SetStateAction<Set<string>>>;
}) {
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5">
      <span className="mr-1 text-xs text-zinc-500">Source:</span>
      <button
        onClick={() => setSelected(new Set())}
        className={`rounded px-2 py-0.5 text-xs transition ${
          selected.size === 0
            ? "bg-indigo-600 text-white"
            : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
        }`}
      >
        All
      </button>
      {ownerList.map((o) => {
        const on = selected.has(o.name);
        return (
          <button
            key={o.name}
            onClick={() =>
              setSelected((prev) => {
                const next = new Set(prev);
                if (next.has(o.name)) next.delete(o.name);
                else next.add(o.name);
                return next;
              })
            }
            className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-xs transition ${
              on
                ? o.isCorp
                  ? "bg-sky-700 text-white"
                  : "bg-indigo-600 text-white"
                : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
            }`}
          >
            {o.isCorp ? <Building2 size={11} /> : <User size={11} />}
            {o.name}
          </button>
        );
      })}
    </div>
  );
}

// ── Flat list table ───────────────────────────────────────────────────────────

type AssetSortKey =
  | "name"
  | "solarSystem"
  | "station"
  | "owner"
  | "quantity"
  | "sellPrice"
  | "sellValue"
  | "volume";
const ASSET_COLUMNS: SortColumn<AssetSortKey>[] = [
  {
    key: "name",
    label: "Item",
    numeric: false,
    description: "The item (+ category / group).",
  },
  {
    key: "solarSystem",
    label: "System",
    numeric: false,
    description: "Solar system the location sits in.",
  },
  {
    key: "station",
    label: "Station",
    numeric: false,
    description: "Station or structure where this stack is stored.",
  },
  {
    key: "owner",
    label: "Owner",
    numeric: false,
    description: "The character, or corporation, holding this stack.",
  },
  {
    key: "quantity",
    label: "Qty",
    numeric: true,
    description: "Units owned across the roster.",
  },
  {
    key: "sellPrice",
    label: "Unit sell",
    numeric: true,
    description: "Per-unit sell price at the chosen market.",
  },
  {
    key: "sellValue",
    label: "Sell value",
    numeric: true,
    description: "Quantity × unit sell.",
  },
  {
    key: "volume",
    label: "m³",
    numeric: true,
    description: "Total packaged volume.",
  },
];
const ASSET_KEYS = ASSET_COLUMNS.map((c) => c.key);

// memo(): Workbench re-renders on every raw search-box keystroke (the
// debounce only delays the *filter*, so `rows` stays referentially stable
// until it lands) and this lets those re-renders skip the table entirely.
const AssetTable = memo(function AssetTable({ rows }: { rows: AssetRow[] }) {
  const { sortKey, sortDir, toggleSort } = usePersistentSort<AssetSortKey>(
    "sort.assets",
    ASSET_KEYS,
    "sellValue",
    "desc",
    ["name"],
  );
  // The row set is uncapped (one row per typeId × owner × location — easily
  // 5k-20k for a multi-character roster), so memoize the O(n log n) sort
  // instead of re-running it in the render body.
  const sorted = useMemo(
    () => sortRows(rows, sortKey, sortDir).slice(0, 500),
    [rows, sortKey, sortDir],
  );
  return (
    <div className="mt-2 overflow-auto rounded border border-zinc-800">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-zinc-900 text-zinc-400">
          <tr>
            {ASSET_COLUMNS.map((c) => (
              <SortHeaderCell
                key={c.key}
                column={c}
                active={sortKey === c.key}
                dir={sortDir}
                onClick={toggleSort}
              />
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.map((r) => (
            <Row key={`${r.typeId}-${r.owner}-${r.station}`} r={r} />
          ))}
        </tbody>
      </table>
    </div>
  );
});

function Row({ r }: { r: AssetRow }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <>
      <tr
        className="cursor-pointer border-t border-zinc-800 hover:bg-zinc-800/20"
        onClick={() => setExpanded((v) => !v)}
      >
        <td className="px-3 py-1.5">
          <div className="flex items-center gap-1.5">
            <span className="text-zinc-200">{r.name}</span>
            <button
              className="text-zinc-600 transition hover:text-zinc-300"
              title="Copy name"
              onClick={(e) => {
                e.stopPropagation();
                navigator.clipboard?.writeText(r.name).catch(() => {});
              }}
            >
              <Copy size={11} />
            </button>
          </div>
          {(r.category || r.group) && (
            <div className="text-xs text-zinc-500">
              {[r.category, r.group].filter(Boolean).join(" · ")}
            </div>
          )}
        </td>
        <td className="px-3 py-1.5 text-zinc-400">
          {r.solarSystem ?? <span className="text-zinc-600">—</span>}
        </td>
        <td
          className="max-w-[200px] truncate px-3 py-1.5 text-zinc-400"
          title={r.station}
        >
          {r.station}
        </td>
        <td className="px-3 py-1.5">
          <span
            className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs ${
              r.isCorp ? "bg-sky-950 text-sky-300" : "bg-zinc-800 text-zinc-300"
            }`}
            title={r.isCorp ? "Corporation hangar" : "Personal hangar"}
          >
            {r.isCorp ? <Building2 size={11} /> : <User size={11} />}
            {r.owner}
          </span>
        </td>
        <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
          {formatInt(r.quantity)}
        </td>
        <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
          {formatIsk(r.sellPrice)}
        </td>
        <td className="px-3 py-1.5 text-right tabular-nums text-emerald-400">
          {formatIsk(r.sellValue)}
        </td>
        <td className="px-3 py-1.5 text-right tabular-nums text-zinc-500">
          {formatInt(Math.round(r.volume))}
        </td>
      </tr>
      {expanded && (
        <tr className="border-t border-zinc-800/30 bg-zinc-900/40">
          <td colSpan={8} className="px-4 py-1.5">
            <div className="flex items-center gap-1.5 text-xs">
              {r.solarSystem && (
                <>
                  <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">
                    {r.solarSystem}
                  </span>
                  <span className="text-zinc-600">›</span>
                </>
              )}
              <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-zinc-300">
                {r.station}
              </span>
              <span className="text-zinc-600">›</span>
              <span className="text-zinc-500">Items</span>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

// ── Tree view helpers ─────────────────────────────────────────────────────────

/** Prune the tree to nodes matching `q` (already lowercased): a matching node
 *  keeps its whole subtree; a non-match survives only to carry a matching
 *  descendant. */
function filterTree(
  nodes: AssetNode[],
  q: string,
  hay: WeakMap<AssetNode, string>,
): AssetNode[] {
  const out: AssetNode[] = [];
  for (const n of nodes) {
    if ((hay.get(n) ?? "").includes(q)) {
      out.push(n);
      continue;
    }
    const kids = filterTree(n.children, q, hay);
    if (kids.length > 0) out.push({ ...n, children: kids });
  }
  return out;
}

/** Prune the tree to nodes whose owner is in `owners`. */
function filterTreeByOwners(
  nodes: AssetNode[],
  owners: Set<string>,
): AssetNode[] {
  const out: AssetNode[] = [];
  for (const n of nodes) {
    if (!n.isLocation && n.owner != null && owners.has(n.owner)) {
      out.push(n);
      continue;
    }
    const kids = filterTreeByOwners(n.children, owners);
    if (kids.length > 0) out.push({ ...n, children: kids });
  }
  return out;
}

/** A collapsible row in the asset location tree. Locations (depth 0) open by
 *  default; containers stay collapsed unless toggled. When `searching`, any
 *  node with filtered children auto-expands — but the user can explicitly
 *  close a container to override the auto-expand. */
function TreeRow({
  node,
  depth,
  searching,
}: {
  node: AssetNode;
  depth: number;
  searching: boolean;
}) {
  const [open, setOpen] = useState(depth === 0);
  // Track when the user explicitly closes a container that would auto-expand
  // during search. Without this, `isOpen` would always be true for containers
  // with children when searching, making the toggle button appear broken.
  const [closedByUser, setClosedByUser] = useState(false);
  const hasChildren = node.children.length > 0;
  const wouldAutoExpand = searching && hasChildren;
  const isOpen = !closedByUser && (open || wouldAutoExpand);
  const showOwner = depth === 1 && !node.isLocation && node.owner;
  return (
    <>
      <div
        className="flex items-center justify-between border-t border-zinc-800/60 px-3 py-1 text-sm hover:bg-zinc-800/30"
        style={{ paddingLeft: `${12 + depth * 16}px` }}
      >
        <span className="flex items-center gap-1">
          {hasChildren ? (
            <button
              onClick={() => {
                if (isOpen) {
                  setClosedByUser(true);
                  setOpen(false);
                } else {
                  setClosedByUser(false);
                  setOpen(true);
                }
              }}
              className="w-4 text-zinc-500"
            >
              {isOpen ? "▾" : "▸"}
            </button>
          ) : (
            <span className="w-4" />
          )}
          <span
            className={
              node.isLocation ? "font-medium text-zinc-100" : "text-zinc-300"
            }
          >
            {node.name}
          </span>
          {node.quantity > 1 && !node.isLocation && (
            <span className="text-xs text-zinc-500">
              ×{formatInt(node.quantity)}
            </span>
          )}
          {showOwner && (
            <span
              className={`ml-1 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] ${
                node.isCorp
                  ? "bg-sky-950 text-sky-300"
                  : "bg-zinc-800 text-zinc-400"
              }`}
              title={node.isCorp ? "Corporation hangar" : "Personal hangar"}
            >
              {node.isCorp ? <Building2 size={10} /> : <User size={10} />}
              {node.owner}
            </span>
          )}
        </span>
        <span className="tabular-nums text-zinc-400">
          {formatIsk(node.sellValue)}
        </span>
      </div>
      {isOpen &&
        node.children.map((c) => (
          <TreeRow key={c.id} node={c} depth={depth + 1} searching={searching} />
        ))}
    </>
  );
}
