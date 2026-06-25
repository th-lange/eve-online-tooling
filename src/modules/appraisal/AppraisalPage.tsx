import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  appraisal,
  marketRegions,
  sdeStatus,
  type AppraisalLine,
  type AppraisalParams,
  type AppraisalResult,
} from "../../lib/api";
import { SdeSetup } from "../production/SdeSetup";
import { formatInt, formatIsk, sortRows } from "../../lib/format";
import { usePersistentSort } from "../../lib/usePersistentSort";
import { SortHeaderCell, type SortColumn } from "../../components/SortHeaderCell";

const FORGE = 10000002;
const JITA = 60003760;

export function AppraisalPage() {
  const status = useQuery({ queryKey: ["sde", "status"], queryFn: sdeStatus });
  if (status.isLoading) return <Centered>Checking static data…</Centered>;
  if (!status.data?.installed) {
    return <SdeSetup onInstalled={() => status.refetch()} />;
  }
  return <Workbench />;
}

function Workbench() {
  const [text, setText] = useState("");
  const [regionId, setRegionId] = useState(FORGE);
  const [stationId, setStationId] = useState<number | null>(JITA);
  const [bestHub, setBestHub] = useState(false);
  const [result, setResult] = useState<AppraisalResult | null>(null);

  const regions = useQuery({ queryKey: ["market", "regions"], queryFn: marketRegions });
  const run = useMutation({
    mutationFn: (p: AppraisalParams) => appraisal(p),
    onSuccess: setResult,
  });

  // Parse the EVE clipboard format: tab- or multi-space-separated Name + Qty.
  const items = useMemo(() => parseItems(text), [text]);

  function calculate() {
    run.mutate({ items, regionId, stationId, bestHub });
  }

  const stations = regions.data?.find((r) => r.id === regionId)?.stations ?? [];

  return (
    <div className="p-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-100">Appraisal</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Paste items (from EVE: select → copy) and get a buy/sell ISK value
            and cargo volume.
          </p>
        </div>
        <button
          onClick={calculate}
          disabled={run.isPending || items.length === 0}
          className="rounded bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {run.isPending ? "Pricing…" : `Appraise (${items.length})`}
        </button>
      </div>

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          placeholder={"Tritanium\t1000\nHobgoblin II\t5\nRifter"}
          className="h-48 w-full rounded border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
        />
        <div className="grid grid-cols-2 gap-3 self-start">
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
          <label className="col-span-2 flex items-center gap-1 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={bestHub}
              onChange={(e) => setBestHub(e.currentTarget.checked)}
            />
            Sell side uses the best-paying hub (slower)
          </label>
          {result && (
            <div className="col-span-2 rounded border border-zinc-800 bg-zinc-900 p-3 text-sm">
              <div className="flex justify-between">
                <span className="text-zinc-400">Buy value</span>
                <span className="tabular-nums text-zinc-200">{formatIsk(result.buyTotal)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-400">Sell value</span>
                <span className="tabular-nums text-emerald-400">{formatIsk(result.sellTotal)}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-400">Volume</span>
                <span className="tabular-nums text-zinc-300">
                  {formatInt(Math.round(result.volumeTotal))} m³
                </span>
              </div>
            </div>
          )}
        </div>
      </div>

      {run.isError && (
        <div className="mt-3 text-sm text-rose-400">Failed: {String(run.error)}</div>
      )}

      {result && (
        <LineTable lines={result.lines} />
      )}
    </div>
  );
}

type LineSortKey =
  | "name"
  | "quantity"
  | "buyPrice"
  | "sellPrice"
  | "buyValue"
  | "sellValue"
  | "volume";
const LINE_COLUMNS: SortColumn<LineSortKey>[] = [
  { key: "name", label: "Item", numeric: false, description: "Pasted item name." },
  { key: "quantity", label: "Qty", numeric: true, description: "Quantity." },
  { key: "buyPrice", label: "Buy", numeric: true, description: "Per-unit buy price." },
  { key: "sellPrice", label: "Sell", numeric: true, description: "Per-unit sell price." },
  { key: "buyValue", label: "Buy value", numeric: true, description: "Qty × buy." },
  { key: "sellValue", label: "Sell value", numeric: true, description: "Qty × sell." },
  { key: "volume", label: "m³", numeric: true, description: "Total volume." },
];
const LINE_KEYS = LINE_COLUMNS.map((c) => c.key);

function LineTable({ lines }: { lines: AppraisalLine[] }) {
  const { sortKey, sortDir, toggleSort } = usePersistentSort<LineSortKey>(
    "sort.appraisal",
    LINE_KEYS,
    "sellValue",
    "desc",
    ["name"],
  );
  const sorted = sortRows(lines, sortKey, sortDir);
  return (
    <div className="mt-4 overflow-auto rounded border border-zinc-800">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-zinc-900 text-zinc-400">
              <tr>
                {LINE_COLUMNS.map((c) => (
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
              {sorted.map((l, i) => (
                <tr key={i} className="border-t border-zinc-800">
                  <td className="px-3 py-1.5 text-zinc-200">
                    {l.name}
                    {!l.resolved && (
                      <span className="ml-1 text-amber-400" title="Unknown item name">
                        ⚠
                      </span>
                    )}
                    {l.sellHub && (
                      <span className="ml-1 text-[10px] text-emerald-400">↗ {l.sellHub}</span>
                    )}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                    {formatInt(l.quantity)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                    {formatIsk(l.buyPrice)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                    {formatIsk(l.sellPrice)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-zinc-300">
                    {formatIsk(l.buyValue)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-emerald-400">
                    {formatIsk(l.sellValue)}
                  </td>
                  <td className="px-3 py-1.5 text-right tabular-nums text-zinc-500">
                    {formatInt(Math.round(l.volume))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
  );
}

/** Parse pasted lines: `Name<tab|2+ spaces>Quantity`; qty defaults to 1. */
function parseItems(text: string): { name: string; quantity: number }[] {
  const out: { name: string; quantity: number }[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    // Split on tab, or 2+ spaces, taking a trailing integer as the quantity.
    let name = line;
    let qty = 1;
    const parts = line.split(/\t| {2,}/).filter(Boolean);
    if (parts.length >= 2) {
      const last = parts[parts.length - 1].replace(/[.,\s]/g, "");
      if (/^\d+$/.test(last)) {
        qty = Number(last);
        name = parts.slice(0, -1).join(" ").trim();
      }
    }
    if (name) out.push({ name, quantity: qty });
  }
  return out;
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
  return <div className="p-10 text-center text-sm text-zinc-500">{children}</div>;
}
