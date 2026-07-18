import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  appraisal,
  errorMessage,
  appraisalReprocess,
  type AppraisalLine,
  type AppraisalParams,
  type AppraisalResult,
  type ReprocessAppraisalParams,
  type ReprocessAppraisalResult,
} from "../../lib/api";
import { marketKeys } from "../../lib/queryKeys";
import {
  RegionSelect,
  StationSelect,
} from "../../components/RegionStationPicker";
import { formatInt, formatIsk, sortRows } from "../../lib/format";
import { usePersistentSort } from "../../lib/usePersistentSort";
import { parseItems } from "../../lib/parseItems";
import {
  SortHeaderCell,
  type SortColumn,
} from "../../components/SortHeaderCell";
import { Page, PageHeader, PrimaryButton } from "../../components/page";
import { Field } from "../../components/forms";
import { SdeGate } from "../../components/SdeGate";

const FORGE = 10000002;
const JITA = 60003760;

const TITLE = "Appraisal";
const SUBTITLE =
  "Paste items (from EVE: select → copy) and get a buy/sell ISK value and cargo volume.";

export function AppraisalPage() {
  return (
    <SdeGate title={TITLE} subtitle={SUBTITLE}>
      <Workbench />
    </SdeGate>
  );
}

function Workbench() {
  const [text, setText] = useState("");
  const [regionId, setRegionId] = useState(FORGE);
  const [stationId, setStationId] = useState<number | null>(JITA);
  const [bestHub, setBestHub] = useState(false);
  const [reprocess, setReprocess] = useState(false);
  const [effPct, setEffPct] = useState(70);
  const [result, setResult] = useState<AppraisalResult | null>(null);
  const [repro, setRepro] = useState<ReprocessAppraisalResult | null>(null);

  const regions = useQuery(marketKeys.regions());
  const run = useMutation({
    mutationFn: (p: AppraisalParams) => appraisal(p),
    onSuccess: setResult,
  });
  const runRepro = useMutation({
    mutationFn: (p: ReprocessAppraisalParams) => appraisalReprocess(p),
    onSuccess: setRepro,
  });

  // Parse the EVE clipboard format: tab- or multi-space-separated Name + Qty.
  const items = useMemo(() => parseItems(text), [text]);

  function calculate() {
    if (reprocess) {
      runRepro.mutate({ items, regionId, stationId, efficiency: effPct / 100 });
    } else {
      run.mutate({ items, regionId, stationId, bestHub });
    }
  }

  const stations = regions.data?.find((r) => r.id === regionId)?.stations ?? [];

  return (
    <Page>
      <PageHeader
        title={TITLE}
        subtitle={SUBTITLE}
        actions={
          <PrimaryButton
            onClick={calculate}
            disabled={run.isPending || runRepro.isPending || items.length === 0}
            pending={run.isPending || runRepro.isPending}
            pendingLabel="Pricing…"
          >
            {`${reprocess ? "Reprocess" : "Appraise"} (${items.length})`}
          </PrimaryButton>
        }
      />

      <div className="mt-4 grid gap-3 md:grid-cols-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.currentTarget.value)}
          placeholder={"Tritanium\t1000\nHobgoblin II\t5\nRifter"}
          className="h-48 w-full rounded border border-zinc-800 bg-zinc-900 px-3 py-2 font-mono text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
        />
        <div className="grid grid-cols-2 gap-3 self-start">
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
          <label className="col-span-2 flex items-center gap-1 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={bestHub}
              disabled={reprocess}
              onChange={(e) => setBestHub(e.currentTarget.checked)}
            />
            Sell side uses the best-paying hub (slower)
          </label>
          <label className="col-span-2 flex items-center gap-1 text-xs text-zinc-300">
            <input
              type="checkbox"
              checked={reprocess}
              onChange={(e) => setReprocess(e.currentTarget.checked)}
            />
            Reprocess — show mineral yield instead of item value
          </label>
          {reprocess && (
            <Field label="Refining efficiency %">
              <input
                type="number"
                value={effPct}
                min={0}
                max={100}
                onChange={(e) => setEffPct(Number(e.currentTarget.value))}
                className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
              />
            </Field>
          )}
          {!reprocess && result && (
            <div className="col-span-2 rounded border border-zinc-800 bg-zinc-900 p-3 text-sm">
              <div className="flex justify-between">
                <span className="text-zinc-400">Buy value</span>
                <span className="tabular-nums text-zinc-200">
                  {formatIsk(result.buyTotal)}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-zinc-400">Sell value</span>
                <span className="tabular-nums text-emerald-400">
                  {formatIsk(result.sellTotal)}
                </span>
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

      {(run.isError || runRepro.isError) && (
        <div className="mt-3 text-sm text-rose-400">
          Failed: {errorMessage(run.error ?? runRepro.error)}
        </div>
      )}

      {!reprocess && result && <LineTable lines={result.lines} />}
      {reprocess && repro && <ReproResult d={repro} />}
    </Page>
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
  {
    key: "name",
    label: "Item",
    numeric: false,
    description: "Pasted item name.",
  },
  { key: "quantity", label: "Qty", numeric: true, description: "Quantity." },
  {
    key: "buyPrice",
    label: "Buy",
    numeric: true,
    description: "Per-unit buy price.",
  },
  {
    key: "sellPrice",
    label: "Sell",
    numeric: true,
    description: "Per-unit sell price.",
  },
  {
    key: "buyValue",
    label: "Buy value",
    numeric: true,
    description: "Qty × buy.",
  },
  {
    key: "sellValue",
    label: "Sell value",
    numeric: true,
    description: "Qty × sell.",
  },
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
                  <span
                    className="ml-1 text-amber-400"
                    title="Unknown item name"
                  >
                    ⚠
                  </span>
                )}
                {l.sellHub && (
                  <span className="ml-1 text-[10px] text-emerald-400">
                    ↗ {l.sellHub}
                  </span>
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

function ReproResult({ d }: { d: ReprocessAppraisalResult }) {
  const better = d.mineralTotal >= d.inputSellTotal;
  return (
    <div className="mt-4">
      <div className="mb-3 flex flex-wrap gap-6 text-sm">
        <div>
          <div className="text-xs text-zinc-500">Mineral yield value</div>
          <div className="tabular-nums text-emerald-400">
            {formatIsk(d.mineralTotal)}
          </div>
        </div>
        <div>
          <div className="text-xs text-zinc-500">Sell inputs as-is</div>
          <div className="tabular-nums text-zinc-200">
            {formatIsk(d.inputSellTotal)}
          </div>
        </div>
        <div>
          <div className="text-xs text-zinc-500">Efficiency</div>
          <div className="tabular-nums text-zinc-300">
            {(d.efficiency * 100).toFixed(0)}%
          </div>
        </div>
        <div>
          <div className="text-xs text-zinc-500">Better to</div>
          <div className={better ? "text-emerald-400" : "text-zinc-200"}>
            {better ? "reprocess" : "sell as-is"}
          </div>
        </div>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <h3 className="mb-1 text-sm font-medium text-zinc-300">
            Mineral yield
          </h3>
          <div className="overflow-auto rounded border border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-900 text-zinc-400">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Mineral</th>
                  <th className="px-3 py-2 text-right font-medium">Units</th>
                  <th className="px-3 py-2 text-right font-medium">Value</th>
                </tr>
              </thead>
              <tbody>
                {d.minerals.map((m) => (
                  <tr
                    key={m.typeId}
                    className="border-t border-zinc-800 text-zinc-300"
                  >
                    <td className="px-3 py-1.5">{m.name}</td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                      {formatInt(m.quantity)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-emerald-400">
                      {formatIsk(m.value)}
                    </td>
                  </tr>
                ))}
                {d.minerals.length === 0 && (
                  <tr>
                    <td
                      colSpan={3}
                      className="px-3 py-4 text-center text-zinc-500"
                    >
                      Nothing reprocessable in the paste.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
        <div>
          <h3 className="mb-1 text-sm font-medium text-zinc-300">Inputs</h3>
          <div className="overflow-auto rounded border border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-900 text-zinc-400">
                <tr>
                  <th className="px-3 py-2 text-left font-medium">Item</th>
                  <th className="px-3 py-2 text-right font-medium">Qty</th>
                  <th className="px-3 py-2 text-right font-medium">
                    Yield value
                  </th>
                </tr>
              </thead>
              <tbody>
                {d.inputs.map((l, i) => (
                  <tr
                    key={i}
                    className="border-t border-zinc-800 text-zinc-300"
                  >
                    <td className="px-3 py-1.5">
                      {l.name}
                      {!l.resolved && (
                        <span
                          className="ml-1 text-amber-400"
                          title="Not reprocessable / unknown"
                        >
                          ⚠
                        </span>
                      )}
                      {l.resolved && l.reprocessed < l.quantity && (
                        <span className="ml-1 text-[10px] text-zinc-500">
                          ({formatInt(l.reprocessed)} refined)
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
                      {formatInt(l.quantity)}
                    </td>
                    <td className="px-3 py-1.5 text-right tabular-nums text-zinc-300">
                      {formatIsk(l.yieldValue)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>
  );
}
