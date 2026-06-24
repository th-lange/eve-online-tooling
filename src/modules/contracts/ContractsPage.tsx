import { useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  contractsScan,
  marketRegions,
  sdeStatus,
  type ContractParams,
  type ContractRow,
} from "../../lib/api";
import { SdeSetup } from "../production/SdeSetup";
import { formatInt, formatIsk, formatPercent } from "../../lib/format";

const FORGE = 10000002;

export function ContractsPage() {
  const status = useQuery({ queryKey: ["sde", "status"], queryFn: sdeStatus });
  if (status.isLoading) return <Centered>Checking static data…</Centered>;
  if (!status.data?.installed) {
    return <SdeSetup onInstalled={() => status.refetch()} />;
  }
  return <Workbench />;
}

function Workbench() {
  const [regionId, setRegionId] = useState(FORGE);
  const [minRoiPct, setMinRoiPct] = useState("10");
  const [rows, setRows] = useState<ContractRow[]>([]);

  const regions = useQuery({ queryKey: ["market", "regions"], queryFn: marketRegions });
  const run = useMutation({
    mutationFn: (p: ContractParams) => contractsScan(p),
    onSuccess: setRows,
  });

  return (
    <div className="p-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-100">Public contracts</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Item-exchange contracts whose contents are worth more at Jita than
            the asking price.
          </p>
        </div>
        <button
          onClick={() =>
            run.mutate({ regionId, minRoi: minRoiPct.trim() === "" ? 0 : Number(minRoiPct) / 100 })
          }
          disabled={run.isPending}
          className="rounded bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
        >
          {run.isPending ? "Scanning…" : "Scan"}
        </button>
      </div>

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
        <span className="text-xs text-zinc-500">
          Values up to 150 item-exchange contracts at Jita sell (BPCs unpriceable).
        </span>
      </div>

      {run.isError && (
        <div className="mt-3 text-sm text-rose-400">Failed: {String(run.error)}</div>
      )}

      <div className="mt-4 overflow-auto rounded border border-zinc-800">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-zinc-900 text-zinc-400">
            <tr>
              <th className="px-3 py-2 text-left font-medium">Contract</th>
              <th className="px-3 py-2 text-right font-medium">Price</th>
              <th className="px-3 py-2 text-right font-medium">Contents (Jita sell)</th>
              <th className="px-3 py-2 text-right font-medium">Profit</th>
              <th className="px-3 py-2 text-right font-medium">ROI</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.contractId} className="border-t border-zinc-800 text-zinc-300">
                <td className="px-3 py-1.5">
                  {r.title}
                  <span className="ml-1 text-xs text-zinc-500">· {r.itemCount} item(s)</span>
                  {r.hasBpc && (
                    <span className="ml-1 text-amber-400" title="Contains a BPC — value understated">
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
      {rows.length > 0 && (
        <div className="mt-1 text-xs text-zinc-500">{formatInt(rows.length)} profitable contract(s)</div>
      )}
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
  return <div className="p-10 text-center text-sm text-zinc-500">{children}</div>;
}
