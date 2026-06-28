import { Fragment, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  marketRegions,
  reprocessingEfficiency,
  reprocessingGetList,
  reprocessingScan,
  reprocessingSetList,
  sdeStatus,
  type ListName,
  type ReprocessParams,
  type ReprocessRow,
} from "../../lib/api";
import { SdeSetup } from "../production/SdeSetup";
import { formatIsk, formatPercent } from "../../lib/format";
import { usePersistentSort } from "../../lib/usePersistentSort";
import { SortHeaderCell, type SortColumn } from "../../components/SortHeaderCell";

const FORGE = 10000002;
const JITA = 60003760;
type Tab = "opportunities" | "favorites" | "blacklist";

export function ReprocessingPage() {
  const status = useQuery({ queryKey: ["sde", "status"], queryFn: sdeStatus });
  if (status.isLoading) return <Centered>Checking static data…</Centered>;
  if (!status.data?.installed) {
    return <SdeSetup onInstalled={() => status.refetch()} />;
  }
  return <Workbench />;
}

function Workbench() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("opportunities");
  const [regionId, setRegionId] = useState(FORGE);
  const [stationId, setStationId] = useState<number | null>(JITA);
  const [reproc, setReproc] = useState(5);
  const [reprocEff, setReprocEff] = useState(5);
  const [oreProc, setOreProc] = useState(4);
  const [implantPct, setImplantPct] = useState(0);
  const [rigBonusPct, setRigBonusPct] = useState(0);
  const [structureMult, setStructureMult] = useState(1.0);
  const [securityMult, setSecurityMult] = useState(1.0);
  const [search, setSearch] = useState("");
  const [rows, setRows] = useState<ReprocessRow[]>([]);

  const params: ReprocessParams = {
    regionId,
    stationId,
    reprocessing: reproc,
    reprocessingEfficiency: reprocEff,
    oreProcessing: oreProc,
    implantPct,
    rigBonusPct,
    structureMult,
    securityMult,
  };

  const regions = useQuery({ queryKey: ["market", "regions"], queryFn: marketRegions });
  const eff = useQuery({
    queryKey: ["reprocessing", "eff", reproc, reprocEff, oreProc, implantPct, rigBonusPct, structureMult, securityMult],
    queryFn: () => reprocessingEfficiency(params),
  });
  const favorites = useQuery({
    queryKey: ["reprocessing", "favorites"],
    queryFn: () => reprocessingGetList("favorites"),
  });
  const blacklist = useQuery({
    queryKey: ["reprocessing", "blacklist"],
    queryFn: () => reprocessingGetList("blacklist"),
  });

  const run = useMutation({
    mutationFn: (p: ReprocessParams) => reprocessingScan(p),
    onSuccess: setRows,
  });
  const setList = useMutation({
    mutationFn: (v: { list: ListName; typeId: number; add: boolean }) =>
      reprocessingSetList(v.list, v.typeId, v.add),
    onSuccess: (_d, v) =>
      qc.invalidateQueries({ queryKey: ["reprocessing", v.list] }),
  });

  function toggleFavorite(r: ReprocessRow) {
    setList.mutate({ list: "favorites", typeId: r.typeId, add: !r.favorite });
    setRows((prev) =>
      prev.map((x) => (x.typeId === r.typeId ? { ...x, favorite: !x.favorite } : x)),
    );
  }
  function blacklistRow(r: ReprocessRow) {
    setList.mutate({ list: "blacklist", typeId: r.typeId, add: true });
    setRows((prev) => prev.filter((x) => x.typeId !== r.typeId));
  }

  const stations = regions.data?.find((r) => r.id === regionId)?.stations ?? [];
  const rowsByType = useMemo(() => new Map(rows.map((r) => [r.typeId, r])), [rows]);
  const filteredRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [r.name, r.group].filter(Boolean).join(" ").toLowerCase().includes(q),
    );
  }, [rows, search]);

  return (
    <div className="p-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-100">Reprocessing</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Ores ranked by reprocess-vs-sell — refine value per unit vs the ore's
            own market price.
          </p>
        </div>
        <button
          onClick={() => run.mutate(params)}
          disabled={run.isPending}
          className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {run.isPending ? "Pricing…" : "Calculate"}
        </button>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 rounded border border-zinc-800 bg-zinc-900 p-3 md:grid-cols-4">
        <Field label="Region">
          <select
            value={regionId}
            onChange={(e) => {
              setRegionId(Number(e.currentTarget.value));
              setStationId(null);
            }}
            className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
          >
            {regions.data?.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Market">
          <select
            value={stationId ?? ""}
            onChange={(e) =>
              setStationId(e.currentTarget.value === "" ? null : Number(e.currentTarget.value))
            }
            className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
          >
            <option value="">Region average</option>
            {stations.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
        </Field>
        <Num label="Reprocessing" value={reproc} onChange={setReproc} min={0} max={5} />
        <Num label="Reproc. Efficiency" value={reprocEff} onChange={setReprocEff} min={0} max={5} />
        <Num label="Ore Processing" value={oreProc} onChange={setOreProc} min={0} max={5} />
        <Num label="Implant %" value={implantPct} onChange={setImplantPct} min={0} max={4} />
        <Field label="Structure">
          <select
            value={structureMult}
            onChange={(e) => setStructureMult(Number(e.currentTarget.value))}
            className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
          >
            <option value={1.0}>NPC station</option>
            <option value={1.02}>Refinery (Athanor)</option>
            <option value={1.055}>Tatara</option>
          </select>
        </Field>
        <Field label="Security">
          <select
            value={securityMult}
            onChange={(e) => setSecurityMult(Number(e.currentTarget.value))}
            className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
          >
            <option value={1.0}>High-sec</option>
            <option value={1.06}>Low-sec</option>
            <option value={1.12}>Null / WH</option>
          </select>
        </Field>
        <Field label="Rig">
          <select
            value={rigBonusPct}
            onChange={(e) => setRigBonusPct(Number(e.currentTarget.value))}
            className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
          >
            <option value={0}>None</option>
            <option value={1}>T1 rig</option>
            <option value={3}>T2 rig</option>
          </select>
        </Field>
        <div className="col-span-2 self-end text-xs text-zinc-400 md:col-span-4">
          Effective yield:{" "}
          <strong className="text-emerald-400">
            {eff.data != null ? formatPercent(eff.data) : "—"}
          </strong>{" "}
          — outputs valued at the chosen market's sell price.
        </div>
      </div>

      <Tabs
        tab={tab}
        onChange={setTab}
        counts={{
          favorites: favorites.data?.length ?? 0,
          blacklist: blacklist.data?.length ?? 0,
        }}
      />

      <div className="mt-3">
        {tab === "opportunities" &&
          (run.isError ? (
            <div className="text-sm text-rose-400">Failed: {String(run.error)}</div>
          ) : run.isPending ? (
            <Centered>Pricing ores and their refine outputs…</Centered>
          ) : (
            <div>
              {rows.length > 0 && (
                <input
                  value={search}
                  onChange={(e) => setSearch(e.currentTarget.value)}
                  placeholder="Search ore / group…"
                  className="mb-2 w-72 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
                />
              )}
              <ReprocessTable
                rows={filteredRows}
                onFavorite={toggleFavorite}
                onBlacklist={blacklistRow}
              />
            </div>
          ))}

        {tab === "favorites" && (
          <ListView
            items={favorites.data ?? []}
            rowsByType={rowsByType}
            removeLabel="Unfavorite"
            onRemove={(id) => setList.mutate({ list: "favorites", typeId: id, add: false })}
          />
        )}
        {tab === "blacklist" && (
          <ListView
            items={blacklist.data ?? []}
            rowsByType={rowsByType}
            removeLabel="Remove"
            onRemove={(id) => setList.mutate({ list: "blacklist", typeId: id, add: false })}
          />
        )}
      </div>
    </div>
  );
}

type ReproSortKey = "name" | "sellPrice" | "reprocessValue" | "delta" | "uplift";

const REPRO_COLUMNS: SortColumn<ReproSortKey>[] = [
  { key: "name", label: "Ore", numeric: false, description: "The ore (refine outputs in the drill-down)." },
  {
    key: "sellPrice",
    label: "Sell",
    numeric: true,
    description: "The ore's own sell price per unit at the chosen market.",
  },
  {
    key: "reprocessValue",
    label: "Reprocess",
    numeric: true,
    description: "Refine value per unit — output minerals at the chosen market, after efficiency.",
  },
  {
    key: "delta",
    label: "Δ/unit",
    numeric: true,
    description: "Reprocess value − sell price. Positive = refining beats selling the ore.",
  },
  {
    key: "uplift",
    label: "Uplift",
    numeric: true,
    description: "Reprocess value ÷ ore sell price − 1.",
  },
];

const REPRO_SORT_KEYS = REPRO_COLUMNS.map((c) => c.key);

function ReprocessTable({
  rows,
  onFavorite,
  onBlacklist,
}: {
  rows: ReprocessRow[];
  onFavorite: (r: ReprocessRow) => void;
  onBlacklist: (r: ReprocessRow) => void;
}) {
  const { sortKey, sortDir, toggleSort } = usePersistentSort<ReproSortKey>(
    "sort.reprocessing",
    REPRO_SORT_KEYS,
    "delta",
    "desc",
    ["name"],
  );
  const [expanded, setExpanded] = useState<number | null>(null);

  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (sortKey === "name") return dir * a.name.localeCompare(b.name);
      const av = (a[sortKey] as number | null) ?? -Infinity;
      const bv = (b[sortKey] as number | null) ?? -Infinity;
      return dir * (av - bv);
    });
  }, [rows, sortKey, sortDir]);

  return (
    <div className="overflow-auto rounded border border-zinc-800">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-zinc-900 text-zinc-400">
          <tr>
            <th className="w-6" />
            <th className="w-16" />
            {REPRO_COLUMNS.map((c) => (
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
          {sorted.map((r) => {
            const open = expanded === r.typeId;
            return (
              <Fragment key={r.typeId}>
                <tr
                  onClick={() => setExpanded(open ? null : r.typeId)}
                  className="cursor-pointer border-t border-zinc-800 hover:bg-zinc-800/40"
                >
                  <td className="px-2 text-center text-zinc-500">{open ? "▾" : "▸"}</td>
                  <td className="px-2 whitespace-nowrap">
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onFavorite(r);
                      }}
                      title="Favorite"
                      className={r.favorite ? "text-amber-400" : "text-zinc-600 hover:text-amber-400"}
                    >
                      ★
                    </button>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        onBlacklist(r);
                      }}
                      title="Blacklist"
                      className="ml-2 text-zinc-600 hover:text-rose-400"
                    >
                      ✕
                    </button>
                  </td>
                  <td className="px-3 py-1.5">
                    <div className="text-zinc-200">
                      {r.name}
                      {r.missingPrices.length > 0 && (
                        <span className="ml-1 text-amber-400" title="Some outputs unpriced">
                          ⚠
                        </span>
                      )}
                    </div>
                    {r.group && <div className="text-xs text-zinc-500">{r.group}</div>}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                    {formatIsk(r.sellPrice)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-zinc-300">
                    {formatIsk(r.reprocessValue)}
                  </td>
                  <td
                    className={`px-3 py-1.5 text-right tabular-nums ${
                      r.delta >= 0 ? "text-emerald-400" : "text-rose-400"
                    }`}
                  >
                    {formatIsk(r.delta)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-zinc-300">
                    {formatPercent(r.uplift)}
                  </td>
                </tr>
                {open && (
                  <tr className="border-t border-zinc-800 bg-zinc-900/40">
                    <td />
                    <td />
                    <td colSpan={4} className="px-3 py-3">
                      <table className="w-full text-xs">
                        <thead className="text-zinc-500">
                          <tr>
                            <th className="text-left font-medium">Output (per unit ore)</th>
                            <th className="text-right font-medium">Yield/unit</th>
                            <th className="text-right font-medium">Unit</th>
                            <th className="text-right font-medium">Value</th>
                          </tr>
                        </thead>
                        <tbody>
                          {r.outputs.map((o) => (
                            <tr key={o.typeId} className="text-zinc-300">
                              <td className="py-0.5">{o.name}</td>
                              <td className="text-right tabular-nums">
                                {o.perUnit.toLocaleString(undefined, {
                                  maximumFractionDigits: 4,
                                })}
                              </td>
                              <td className="text-right tabular-nums">{formatIsk(o.unitPrice)}</td>
                              <td className="text-right tabular-nums">{formatIsk(o.value)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="px-3 py-6 text-center text-zinc-500">
                Hit Calculate to rank ores.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function ListView({
  items,
  rowsByType,
  removeLabel,
  onRemove,
}: {
  items: { typeId: number; name: string }[];
  rowsByType: Map<number, ReprocessRow>;
  removeLabel: string;
  onRemove: (typeId: number) => void;
}) {
  if (items.length === 0) return <Centered>Nothing here yet.</Centered>;
  return (
    <div className="overflow-auto rounded border border-zinc-800">
      <table className="w-full border-collapse text-sm">
        <tbody>
          {items.map((it) => {
            const r = rowsByType.get(it.typeId);
            return (
              <tr key={it.typeId} className="border-t border-zinc-800">
                <td className="px-3 py-1.5 text-zinc-200">{it.name}</td>
                <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                  {r ? `${formatIsk(r.delta)}/unit` : ""}
                </td>
                <td className="px-3 py-1.5 text-right">
                  <button
                    onClick={() => onRemove(it.typeId)}
                    className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
                  >
                    {removeLabel}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Tabs({
  tab,
  onChange,
  counts,
}: {
  tab: Tab;
  onChange: (t: Tab) => void;
  counts: { favorites: number; blacklist: number };
}) {
  const tabs: { value: Tab; label: string }[] = [
    { value: "opportunities", label: "Opportunities" },
    { value: "favorites", label: `Favorites (${counts.favorites})` },
    { value: "blacklist", label: `Blacklist (${counts.blacklist})` },
  ];
  return (
    <div className="mt-4 inline-flex rounded border border-zinc-800 bg-zinc-900 p-0.5">
      {tabs.map((t) => (
        <button
          key={t.value}
          onClick={() => onChange(t.value)}
          className={`rounded px-3 py-1.5 text-sm ${
            tab === t.value ? "bg-zinc-700 text-zinc-100" : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          {t.label}
        </button>
      ))}
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

function Num({
  label,
  value,
  onChange,
  min,
  max,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
}) {
  return (
    <Field label={label}>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
      />
    </Field>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return <div className="p-10 text-center text-sm text-zinc-500">{children}</div>;
}
