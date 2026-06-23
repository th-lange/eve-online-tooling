import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  marketRegions,
  sdeStatus,
  stationTrading,
  tradingGetList,
  tradingSetList,
  type ListName,
  type TradeParams,
  type TradeRow,
} from "../../lib/api";
import { SdeSetup } from "../production/SdeSetup";
import { formatInt, formatIsk, formatPercent } from "../../lib/format";

const FORGE = 10000002;
type Tab = "opportunities" | "favorites" | "blacklist";

export function TradingPage() {
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
  const [stationId, setStationId] = useState<number | null>(60003760); // Jita
  const [brokerPct, setBrokerPct] = useState(3);
  const [taxPct, setTaxPct] = useState(4.5);
  const [minVolume, setMinVolume] = useState("1000");
  const [rows, setRows] = useState<TradeRow[]>([]);

  const regions = useQuery({ queryKey: ["market", "regions"], queryFn: marketRegions });
  const favorites = useQuery({
    queryKey: ["trading", "favorites"],
    queryFn: () => tradingGetList("favorites"),
  });
  const blacklist = useQuery({
    queryKey: ["trading", "blacklist"],
    queryFn: () => tradingGetList("blacklist"),
  });

  const run = useMutation({
    mutationFn: (p: TradeParams) => stationTrading(p),
    onSuccess: setRows,
  });

  function calculate() {
    run.mutate({
      regionId,
      stationId,
      brokerFee: brokerPct / 100,
      salesTax: taxPct / 100,
      minVolume: minVolume.trim() === "" ? 0 : Number(minVolume),
    });
  }

  const setList = useMutation({
    mutationFn: (v: { list: ListName; typeId: number; add: boolean }) =>
      tradingSetList(v.list, v.typeId, v.add),
    onSuccess: (_d, v) =>
      qc.invalidateQueries({ queryKey: ["trading", v.list] }),
  });

  function toggleFavorite(r: TradeRow) {
    setList.mutate({ list: "favorites", typeId: r.typeId, add: !r.favorite });
    setRows((prev) =>
      prev.map((x) =>
        x.typeId === r.typeId ? { ...x, favorite: !x.favorite } : x,
      ),
    );
  }
  function blacklistRow(r: TradeRow) {
    setList.mutate({ list: "blacklist", typeId: r.typeId, add: true });
    setRows((prev) => prev.filter((x) => x.typeId !== r.typeId));
  }

  const stations = regions.data?.find((r) => r.id === regionId)?.stations ?? [];
  const rowsByType = useMemo(
    () => new Map(rows.map((r) => [r.typeId, r])),
    [rows],
  );

  return (
    <div className="p-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-100">
            Station Trading
          </h1>
          <p className="mt-1 text-sm text-zinc-400">
            Buy→sell margins at a hub, after broker fee &amp; sales tax.
          </p>
        </div>
        <button
          onClick={calculate}
          disabled={run.isPending}
          className="rounded bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {run.isPending ? "Scanning…" : "Calculate"}
        </button>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-3 rounded border border-zinc-800 bg-zinc-900 p-3 md:grid-cols-5">
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
              setStationId(
                e.currentTarget.value === ""
                  ? null
                  : Number(e.currentTarget.value),
              )
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
        <NumField label="Broker fee %" value={brokerPct} onChange={setBrokerPct} />
        <NumField label="Sales tax %" value={taxPct} onChange={setTaxPct} />
        <Field label="Min volume">
          <input
            type="number"
            value={minVolume}
            min={0}
            onChange={(e) => setMinVolume(e.currentTarget.value)}
            className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
          />
        </Field>
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
            <ErrorMsg e={run.error} />
          ) : run.isPending ? (
            <Centered>Scanning ~19k items at the chosen market…</Centered>
          ) : (
            <TradeTable
              rows={rows}
              onFavorite={toggleFavorite}
              onBlacklist={blacklistRow}
            />
          ))}

        {tab === "favorites" && (
          <ListView
            items={favorites.data ?? []}
            rowsByType={rowsByType}
            removeLabel="Unfavorite"
            onRemove={(id) =>
              setList.mutate({ list: "favorites", typeId: id, add: false })
            }
          />
        )}
        {tab === "blacklist" && (
          <ListView
            items={blacklist.data ?? []}
            rowsByType={rowsByType}
            removeLabel="Remove"
            onRemove={(id) =>
              setList.mutate({ list: "blacklist", typeId: id, add: false })
            }
          />
        )}
      </div>
    </div>
  );
}

function TradeTable({
  rows,
  onFavorite,
  onBlacklist,
}: {
  rows: TradeRow[];
  onFavorite: (r: TradeRow) => void;
  onBlacklist: (r: TradeRow) => void;
}) {
  return (
    <div className="overflow-auto rounded border border-zinc-800">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-zinc-900 text-zinc-400">
          <tr>
            <th className="w-16" />
            <th className="px-3 py-2 text-left font-medium">Item</th>
            <th className="px-3 py-2 text-right font-medium">Buy</th>
            <th className="px-3 py-2 text-right font-medium">Sell</th>
            <th className="px-3 py-2 text-right font-medium">Profit/unit</th>
            <th className="px-3 py-2 text-right font-medium">Margin</th>
            <th className="px-3 py-2 text-right font-medium">Volume</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.typeId} className="border-t border-zinc-800 hover:bg-zinc-800/40">
              <td className="px-2">
                <button
                  onClick={() => onFavorite(r)}
                  title="Favorite"
                  className={r.favorite ? "text-amber-400" : "text-zinc-600 hover:text-amber-400"}
                >
                  ★
                </button>
                <button
                  onClick={() => onBlacklist(r)}
                  title="Blacklist"
                  className="ml-2 text-zinc-600 hover:text-rose-400"
                >
                  ✕
                </button>
              </td>
              <td className="px-3 py-1.5 text-zinc-200">{r.name}</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                {formatIsk(r.buy)}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                {formatIsk(r.sell)}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-emerald-400">
                {formatIsk(r.profitPerUnit)}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-zinc-300">
                {formatPercent(r.margin)}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                {formatInt(r.volume)}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={7} className="px-3 py-6 text-center text-zinc-500">
                Hit Calculate to scan the market.
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
  rowsByType: Map<number, TradeRow>;
  removeLabel: string;
  onRemove: (typeId: number) => void;
}) {
  if (items.length === 0) {
    return <Centered>Nothing here yet.</Centered>;
  }
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
                  {r ? `${formatIsk(r.profitPerUnit)}/unit · ${formatPercent(r.margin)}` : ""}
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
            tab === t.value
              ? "bg-zinc-700 text-zinc-100"
              : "text-zinc-400 hover:text-zinc-200"
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

function NumField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <Field label={label}>
      <input
        type="number"
        value={value}
        min={0}
        step={0.1}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
      />
    </Field>
  );
}

function ErrorMsg({ e }: { e: unknown }) {
  return <div className="text-sm text-rose-400">Failed: {String(e)}</div>;
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="p-10 text-center text-sm text-zinc-500">{children}</div>
  );
}
