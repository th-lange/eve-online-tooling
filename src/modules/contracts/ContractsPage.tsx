import { useState, type ReactNode } from "react";
import { FeesFromCharacter } from "../../components/FeesFromCharacter";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  contractsScan,
  marketRegions,
  sdeStatus,
  type ContractParams,
  type ContractRow,
} from "../../lib/api";
import { SdeSetup } from "../production/SdeSetup";
import {
  formatInt,
  formatIsk,
  formatPercent,
  sortRows,
} from "../../lib/format";
import { usePersistentSort } from "../../lib/usePersistentSort";
import {
  SortHeaderCell,
  type SortColumn,
} from "../../components/SortHeaderCell";
import { Page, PageHeader, Centered } from "../../components/page";

const FORGE = 10000002;

const TITLE = "Public contracts";
const SUBTITLE =
  "Item-exchange contracts whose contents are worth more at Jita than the asking price.";

export function ContractsPage() {
  const status = useQuery({ queryKey: ["sde", "status"], queryFn: sdeStatus });
  if (status.isLoading) {
    return (
      <Page>
        <PageHeader title={TITLE} subtitle={SUBTITLE} />
        <Centered>Checking static data…</Centered>
      </Page>
    );
  }
  if (!status.data?.installed) {
    return (
      <Page>
        <PageHeader title={TITLE} subtitle={SUBTITLE} />
        <SdeSetup onInstalled={() => status.refetch()} />
      </Page>
    );
  }
  return <Workbench />;
}

function Workbench() {
  const [regionId, setRegionId] = useState(FORGE);
  const [minRoiPct, setMinRoiPct] = useState("10");
  const [brokerPct, setBrokerPct] = useState("3");
  const [taxPct, setTaxPct] = useState("4.5");
  const [rows, setRows] = useState<ContractRow[]>([]);

  const num = (s: string) => (s.trim() === "" ? 0 : Number(s));

  const regions = useQuery({
    queryKey: ["market", "regions"],
    queryFn: marketRegions,
  });
  const run = useMutation({
    mutationFn: (p: ContractParams) => contractsScan(p),
    onSuccess: setRows,
  });

  return (
    <Page>
      <PageHeader
        title={TITLE}
        subtitle={SUBTITLE}
        actions={
          <button
            onClick={() =>
              run.mutate({
                regionId,
                minRoi: num(minRoiPct) / 100,
                brokerFee: num(brokerPct) / 100,
                salesTax: num(taxPct) / 100,
              })
            }
            disabled={run.isPending}
            className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
          >
            {run.isPending ? "Scanning…" : "Scan"}
          </button>
        }
      />

      <div className="mt-4 flex flex-wrap items-end gap-3">
        <Field label="Region">
          <select
            value={regionId}
            onChange={(e) => setRegionId(Number(e.currentTarget.value))}
            className="rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
          >
            {regions.data?.map((r) => (
              <option key={r.id} value={r.id}>
                {r.name}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Min ROI %">
          <input
            type="number"
            value={minRoiPct}
            onChange={(e) => setMinRoiPct(e.currentTarget.value)}
            className="w-24 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
          />
        </Field>
        <Field label="Broker fee %">
          <input
            type="number"
            value={brokerPct}
            onChange={(e) => setBrokerPct(e.currentTarget.value)}
            className="w-24 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
          />
        </Field>
        <Field label="Sales tax %">
          <input
            type="number"
            value={taxPct}
            onChange={(e) => setTaxPct(e.currentTarget.value)}
            className="w-24 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
          />
        </Field>
        <div className="self-end pb-1">
          <FeesFromCharacter
            onApply={(b, t) => {
              setBrokerPct(String(b));
              setTaxPct(String(t));
            }}
          />
        </div>
        <span className="text-xs text-zinc-500">
          Values up to 150 item-exchange contracts at Jita sell, net of resale
          fees (BPCs unpriceable).
        </span>
      </div>

      {run.isError && (
        <div className="mt-3 text-sm text-rose-400">
          Failed: {String(run.error)}
        </div>
      )}

      <ContractTable rows={rows} />
      {rows.length > 0 && (
        <div className="mt-1 text-xs text-zinc-500">
          {formatInt(rows.length)} profitable contract(s)
        </div>
      )}
    </Page>
  );
}

type ContractSortKey = "title" | "price" | "contentsValue" | "profit" | "roi";
const CONTRACT_COLUMNS: SortColumn<ContractSortKey>[] = [
  {
    key: "title",
    label: "Contract",
    numeric: false,
    description: "Contract title + item count.",
  },
  {
    key: "price",
    label: "Price",
    numeric: true,
    description: "The asking price.",
  },
  {
    key: "contentsValue",
    label: "Contents (Jita sell)",
    numeric: true,
    description: "Jita sell value of the included items.",
  },
  {
    key: "profit",
    label: "Profit",
    numeric: true,
    description:
      "Contents value net of sales tax + broker fee, − price (and any items you must provide).",
  },
  { key: "roi", label: "ROI", numeric: true, description: "Profit ÷ cost." },
];
const CONTRACT_KEYS = CONTRACT_COLUMNS.map((c) => c.key);

function ContractTable({ rows }: { rows: ContractRow[] }) {
  const { sortKey, sortDir, toggleSort } = usePersistentSort<ContractSortKey>(
    "sort.contracts",
    CONTRACT_KEYS,
    "roi",
    "desc",
    ["title"],
  );
  const sorted = sortRows(rows, sortKey, sortDir);
  return (
    <div className="mt-4 overflow-auto rounded border border-zinc-800">
      <table className="w-full border-collapse text-sm">
        <thead className="bg-zinc-900 text-zinc-400">
          <tr>
            {CONTRACT_COLUMNS.map((c) => (
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
            <tr
              key={r.contractId}
              className="border-t border-zinc-800 text-zinc-300"
            >
              <td className="px-3 py-1.5">
                {r.title}
                <span className="ml-1 text-xs text-zinc-500">
                  · {r.itemCount} item(s)
                </span>
                {r.hasBpc && (
                  <span
                    className="ml-1 text-amber-400"
                    title="Contains a BPC — value understated"
                  >
                    ⚠
                  </span>
                )}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                {formatIsk(r.price)}
              </td>
              <td className="px-3 py-1.5 text-right tabular-nums text-zinc-300">
                {formatIsk(r.contentsValue)}
              </td>
              <td
                className={`px-3 py-1.5 text-right tabular-nums ${
                  r.profit >= 0 ? "text-emerald-400" : "text-rose-400"
                }`}
              >
                {formatIsk(r.profit)}
              </td>
              <td
                className={`px-3 py-1.5 text-right tabular-nums ${
                  r.roi >= 0 ? "text-emerald-400" : "text-rose-400"
                }`}
              >
                {formatPercent(r.roi)}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={5} className="px-3 py-6 text-center text-zinc-500">
                Scan a region for profitable contracts.
              </td>
            </tr>
          )}
        </tbody>
      </table>
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
