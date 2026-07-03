import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  assetsTree,
  assetsValue,
  marketRegions,
  sdeStatus,
  type AssetNode,
  type AssetRow,
  type AssetsParams,
  type AssetsResult,
  type AssetsTreeResult,
} from "../../lib/api";
import { SdeSetup } from "../production/SdeSetup";
import {
  RegionSelect,
  StationSelect,
} from "../../components/RegionStationPicker";
import { formatInt, formatIsk, sortRows } from "../../lib/format";
import { usePersistentSort } from "../../lib/usePersistentSort";
import {
  SortHeaderCell,
  type SortColumn,
} from "../../components/SortHeaderCell";

const FORGE = 10000002;
const JITA = 60003760;

export function AssetsPage() {
  const status = useQuery({ queryKey: ["sde", "status"], queryFn: sdeStatus });
  if (status.isLoading) return <Centered>Checking static data…</Centered>;
  if (!status.data?.installed) {
    return <SdeSetup onInstalled={() => status.refetch()} />;
  }
  return <Workbench />;
}

function Workbench() {
  const [regionId, setRegionId] = useState(FORGE);
  const [stationId, setStationId] = useState<number | null>(JITA);
  const [bestHub, setBestHub] = useState(false);
  const [search, setSearch] = useState("");
  const [result, setResult] = useState<AssetsResult | null>(null);

  const [tree, setTree] = useState<AssetsTreeResult | null>(null);

  const regions = useQuery({
    queryKey: ["market", "regions"],
    queryFn: marketRegions,
  });
  const run = useMutation({
    mutationFn: (p: AssetsParams) => assetsValue(p),
    onSuccess: (r) => {
      setResult(r);
      setTree(null);
    },
  });
  const treeRun = useMutation({
    mutationFn: () => assetsTree(),
    onSuccess: (t) => {
      setTree(t);
      setResult(null);
    },
  });

  const stations = regions.data?.find((r) => r.id === regionId)?.stations ?? [];
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const all = result?.rows ?? [];
    if (!q) return all;
    return all.filter((r) =>
      [r.name, r.category, r.group]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(q),
    );
  }, [result, search]);

  return (
    <div className="p-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-100">Assets</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Your roster's holdings, valued at a market — and where each stack is
            worth the most.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => treeRun.mutate()}
            disabled={treeRun.isPending}
            className="rounded border border-zinc-700 px-4 py-1.5 text-sm font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
            title="Nested location tree, valued at the best hub"
          >
            {treeRun.isPending ? "Loading…" : "Location tree"}
          </button>
          <button
            onClick={() => run.mutate({ regionId, stationId, bestHub })}
            disabled={run.isPending}
            className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {run.isPending ? "Valuing…" : "Value assets"}
          </button>
        </div>
      </div>

      {treeRun.isError && (
        <div className="mt-3 text-sm text-rose-400">
          Failed: {String(treeRun.error)}
        </div>
      )}
      {tree && (
        <>
          <div className="mt-4 flex flex-wrap gap-6 text-sm">
            <Stat
              label="Sell value (best hub)"
              value={formatIsk(tree.sellTotal)}
              accent
            />
            <Stat
              label="Volume"
              value={`${formatInt(Math.round(tree.volumeTotal))} m³`}
            />
            <Stat label="Locations" value={formatInt(tree.roots.length)} />
          </div>
          <div className="mt-3 rounded border border-zinc-800">
            {tree.roots.map((n) => (
              <TreeRow key={n.id} node={n} depth={0} />
            ))}
            {tree.roots.length === 0 && (
              <div className="px-3 py-6 text-center text-sm text-zinc-500">
                No assets.
              </div>
            )}
          </div>
        </>
      )}

      <div className="mt-4 grid grid-cols-2 gap-3 rounded border border-zinc-800 bg-zinc-900 p-3 md:grid-cols-4">
        <Field label="Region">
          <RegionSelect
            regions={regions.data}
            value={regionId}
            onChange={(id) => {
              setRegionId(id);
              setStationId(null);
            }}
          />
        </Field>
        <Field label="Market">
          <StationSelect
            stations={stations}
            value={stationId}
            onChange={setStationId}
          />
        </Field>
        <label className="col-span-2 flex items-end gap-1 text-xs text-zinc-300">
          <input
            type="checkbox"
            checked={bestHub}
            onChange={(e) => setBestHub(e.currentTarget.checked)}
          />
          Value at the best-paying hub (slower)
        </label>
      </div>

      {run.isError && (
        <div className="mt-3 text-sm text-rose-400">
          Failed: {String(run.error)} — log in a character with the assets
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
            <Stat label="Item types" value={formatInt(result.rows.length)} />
          </div>
          <input
            value={search}
            onChange={(e) => setSearch(e.currentTarget.value)}
            placeholder="Search name / category / group…"
            className="mt-3 w-72 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
          />
          <AssetTable rows={rows} />
        </>
      )}
    </div>
  );
}

type AssetSortKey = "name" | "quantity" | "sellPrice" | "sellValue" | "volume";
const ASSET_COLUMNS: SortColumn<AssetSortKey>[] = [
  {
    key: "name",
    label: "Item",
    numeric: false,
    description: "The item (+ best sell hub).",
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
            <Row key={r.typeId} r={r} />
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
        <div className="text-zinc-200">
          {r.name}
          {r.sellHub && (
            <span className="ml-1 text-[10px] text-emerald-400">
              ↗ {r.sellHub}
            </span>
          )}
        </div>
        {(r.category || r.group) && (
          <div className="text-xs text-zinc-500">
            {[r.category, r.group].filter(Boolean).join(" · ")}
          </div>
        )}
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

/** A collapsible row in the asset location tree (locations expanded by default). */
function TreeRow({ node, depth }: { node: AssetNode; depth: number }) {
  const [open, setOpen] = useState(depth === 0);
  const hasChildren = node.children.length > 0;
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
          {node.bestHub && (
            <span className="ml-1 text-[10px] text-sky-400/70">
              {node.bestHub}
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

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-zinc-400">
      {label}
      {children}
    </label>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="p-10 text-center text-sm text-zinc-500">{children}</div>
  );
}
