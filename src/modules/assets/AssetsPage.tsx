import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  activeCharacter,
  assetsTree,
  assetsValue,
  errorMessage,
  type AssetNode,
  type AssetRow,
  type AssetsResult,
  type AssetsTreeResult,
} from "../../lib/api";
import { formatInt, formatIsk, sortRows } from "../../lib/format";
import { usePersistentSort } from "../../lib/usePersistentSort";
import {
  SortHeaderCell,
  type SortColumn,
} from "../../components/SortHeaderCell";
import { Page, PageHeader } from "../../components/page";
import { SdeGate } from "../../components/SdeGate";
import { useDebouncedValue } from "../../lib/useDebouncedValue";
import { Building2, User } from "lucide-react";

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
  const [search, setSearch] = useState("");
  const [treeSearch, setTreeSearch] = useState("");
  const [owners, setOwners] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<AssetsResult | null>(null);

  const [tree, setTree] = useState<AssetsTreeResult | null>(null);

  const run = useMutation({
    mutationFn: () => assetsValue(),
    onSuccess: (r) => {
      setResult(r);
      setTree(null);
      setOwners(new Set());
    },
  });
  const treeRun = useMutation({
    mutationFn: () => assetsTree(),
    onSuccess: (t) => {
      setTree(t);
      setResult(null);
    },
  });

  // The Assets view follows the global character selector: when it changes,
  // re-run whichever view is loaded so it reflects the new selection (a single
  // character's assets, or everyone's under "all characters"). The guard keys
  // on the active id so unrelated re-renders don't re-value.
  const active = useQuery({
    queryKey: ["auth", "active"],
    queryFn: activeCharacter,
  });
  const prevActive = useRef<number | null | undefined>(undefined);
  const inited = useRef(false);
  useEffect(() => {
    if (inited.current) return;
    inited.current = true;
    run.mutate();
  }, [run]);
  useEffect(() => {
    if (prevActive.current === undefined) {
      prevActive.current = active.data;
      return;
    }
    if (active.data === prevActive.current) return;
    prevActive.current = active.data;
    if (tree) treeRun.mutate();
    else run.mutate();
  }, [active.data, tree, run, treeRun]);

  // Distinct owners present in the current result, characters first then
  // corps, each alphabetical — drives the source filter chips.
  const ownerList = useMemo(() => {
    const seen = new Map<string, boolean>();
    for (const r of result?.rows ?? []) {
      if (!seen.has(r.owner)) seen.set(r.owner, r.isCorp);
    }
    return [...seen.entries()]
      .map(([name, isCorp]) => ({ name, isCorp }))
      .sort(
        (a, b) =>
          Number(a.isCorp) - Number(b.isCorp) || a.name.localeCompare(b.name),
      );
  }, [result]);
  // Precompute each row's lowercased search haystack once per result, so
  // typing only scans (indexOf) instead of re-building + re-lowercasing
  // strings for every row on every keystroke.
  const haystacks = useMemo(() => {
    const m = new Map<AssetRow, string>();
    for (const r of result?.rows ?? []) {
      m.set(
        r,
        [r.name, r.category, r.group, r.owner]
          .filter(Boolean)
          .join(" ")
          .toLowerCase(),
      );
    }
    return m;
  }, [result]);
  const debouncedSearch = useDebouncedValue(search);
  const rows = useMemo(() => {
    const q = debouncedSearch.trim().toLowerCase();
    let all = result?.rows ?? [];
    if (owners.size > 0) all = all.filter((r) => owners.has(r.owner));
    if (!q) return all;
    return all.filter((r) => (haystacks.get(r) ?? "").includes(q));
  }, [result, debouncedSearch, owners, haystacks]);
  // Same precompute for the tree: one lowercased haystack per node, cached
  // for the life of the tree, so filtering only scans.
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
    if (tree) walk(tree.roots);
    return m;
  }, [tree]);
  const debouncedTreeSearch = useDebouncedValue(treeSearch);
  const treeSearching = debouncedTreeSearch.trim().length > 0;
  const treeRoots = useMemo(() => {
    if (!tree) return [];
    const q = debouncedTreeSearch.trim().toLowerCase();
    return q ? filterTree(tree.roots, q, treeHay) : tree.roots;
  }, [tree, debouncedTreeSearch, treeHay]);

  return (
    <Page>
      <PageHeader
        title={TITLE}
        subtitle={SUBTITLE}
        actions={
          <button
            onClick={() => (tree ? run.mutate() : treeRun.mutate())}
            disabled={run.isPending || treeRun.isPending}
            className="rounded border border-zinc-700 px-4 py-1.5 text-sm font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
            title="Toggle between a flat valued list and the nested location tree (both valued at Jita)"
          >
            {tree
              ? "Flat list"
              : treeRun.isPending
                ? "Loading…"
                : "Location tree"}
          </button>
        }
      />

      {treeRun.isError && (
        <div className="mt-3 text-sm text-rose-400">
          Failed: {errorMessage(treeRun.error)}
        </div>
      )}
      {tree && (
        <>
          <div className="mt-4 flex flex-wrap gap-6 text-sm">
            <Stat label="Sell value" value={formatIsk(tree.sellTotal)} accent />
            <Stat
              label="Volume"
              value={`${formatInt(Math.round(tree.volumeTotal))} m³`}
            />
            <Stat label="Locations" value={formatInt(tree.roots.length)} />
          </div>
          <input
            value={treeSearch}
            onChange={(e) => setTreeSearch(e.currentTarget.value)}
            placeholder="Search tree: name / category / group / metatype / owner…"
            className="mt-3 w-96 max-w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
          />
          <div className="mt-2 rounded border border-zinc-800">
            {treeRoots.map((n) => (
              <TreeRow key={n.id} node={n} depth={0} />
            ))}
            {treeRoots.length === 0 && (
              <div className="px-3 py-6 text-center text-sm text-zinc-500">
                {treeSearching ? "No matches." : "No assets."}
              </div>
            )}
          </div>
        </>
      )}

      {run.isError && (
        <div className="mt-3 text-sm text-rose-400">
          Failed: {errorMessage(run.error)} — log in a character with the assets
          scope.
        </div>
      )}

      {result && (
        <>
          <div className="mt-4 flex flex-wrap gap-6 text-sm">
            <Stat
              label="Sell value (net worth)"
              value={formatIsk(result.sellTotal)}
              accent
            />
            <Stat label="Buy value" value={formatIsk(result.buyTotal)} />
            <Stat
              label="Volume"
              value={`${formatInt(Math.round(result.volumeTotal))} m³`}
            />
            <Stat
              label="Item types"
              value={formatInt(new Set(result.rows.map((r) => r.typeId)).size)}
            />
          </div>
          {ownerList.length > 1 && (
            <div className="mt-3 flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-xs text-zinc-500">Source:</span>
              <button
                onClick={() => setOwners(new Set())}
                className={`rounded px-2 py-0.5 text-xs transition ${
                  owners.size === 0
                    ? "bg-indigo-600 text-white"
                    : "bg-zinc-800 text-zinc-300 hover:bg-zinc-700"
                }`}
              >
                All
              </button>
              {ownerList.map((o) => {
                const on = owners.has(o.name);
                return (
                  <button
                    key={o.name}
                    onClick={() =>
                      setOwners((prev) => {
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

type AssetSortKey =
  "name" | "owner" | "quantity" | "sellPrice" | "sellValue" | "volume";
const ASSET_COLUMNS: SortColumn<AssetSortKey>[] = [
  {
    key: "name",
    label: "Item",
    numeric: false,
    description: "The item (+ best sell hub).",
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

function AssetTable({ rows }: { rows: AssetRow[] }) {
  const { sortKey, sortDir, toggleSort } = usePersistentSort<AssetSortKey>(
    "sort.assets",
    ASSET_KEYS,
    "sellValue",
    "desc",
    ["name"],
  );
  const sorted = sortRows(rows, sortKey, sortDir).slice(0, 500);
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
            <Row key={`${r.typeId}-${r.owner}`} r={r} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Row({ r }: { r: AssetRow }) {
  return (
    <tr className="border-t border-zinc-800">
      <td className="px-3 py-1.5">
        <div className="text-zinc-200">{r.name}</div>
        {(r.category || r.group) && (
          <div className="text-xs text-zinc-500">
            {[r.category, r.group].filter(Boolean).join(" · ")}
          </div>
        )}
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
  );
}

/** Prune the tree to nodes matching `q` (already lowercased): a matching node
 *  keeps its whole subtree; a non-match survives only to carry a matching
 *  descendant. Uses the precomputed per-node haystack cache so filtering only
 *  scans. */
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

/** A collapsible row in the asset location tree (locations open by default,
 *  everything else collapsed — searching filters but never auto-expands, so
 *  matches inside a container stay tucked until you open it). Top-level items
 *  (direct children of a location) carry an owner badge; contents inherit it. */
function TreeRow({ node, depth }: { node: AssetNode; depth: number }) {
  const [open, setOpen] = useState(depth === 0);
  const hasChildren = node.children.length > 0;
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
              onClick={() => setOpen(!open)}
              className="w-4 text-zinc-500"
            >
              {open ? "▾" : "▸"}
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
      {open &&
        node.children.map((c) => (
          <TreeRow key={c.id} node={c} depth={depth + 1} />
        ))}
    </>
  );
}

function Stat({
  label,
  value,
  accent,
}: {
  label: string;
  value: string;
  accent?: boolean;
}) {
  return (
    <div>
      <div className="text-xs text-zinc-500">{label}</div>
      <div
        className={`tabular-nums ${accent ? "text-emerald-400" : "text-zinc-200"}`}
      >
        {value}
      </div>
    </div>
  );
}
