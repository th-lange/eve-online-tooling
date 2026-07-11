import { useQuery } from "@tanstack/react-query";
import { DataAge } from "../../components/DataAge";
import { sdeStatus } from "../../lib/api";
import { SdeSetup } from "./SdeSetup";
import { Centered } from "./components";
import { ParamsPanel } from "./ParamsPanel";
import { Results } from "./Results";
import { useWorkbench } from "./useWorkbench";

export function ProductionPage() {
  const status = useQuery({ queryKey: ["sde", "status"], queryFn: sdeStatus });

  if (status.isLoading) return <Centered>Checking static data…</Centered>;
  if (status.isError) {
    return (
      <Centered>
        <span className="text-rose-400">
          Couldn't reach the backend: {String(status.error)}
        </span>
      </Centered>
    );
  }
  if (!status.data?.installed) {
    return <SdeSetup onInstalled={() => status.refetch()} />;
  }
  return <Workbench />;
}

function Workbench() {
  const wb = useWorkbench();
  const { update, calculate, profit } = wb;

  return (
    <div className="p-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-100">Production</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Every manufacturable item, ranked by build-vs-buy profit. Search,
            then filter.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex gap-2">
            <button
              onClick={() => update.mutate()}
              disabled={update.isPending}
              className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
              title="Re-download the SDE only if it changed"
            >
              {update.isPending
                ? "Checking…"
                : update.data
                  ? update.data.updated
                    ? "Updated ✓"
                    : "Up to date ✓"
                  : "Update data"}
            </button>
            <button
              onClick={calculate}
              disabled={profit.isPending}
              className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {profit.isPending ? "Calculating…" : "Calculate"}
            </button>
          </div>
          <DataAge
            updatedAt={profit.isSuccess ? profit.submittedAt : undefined}
            fetching={profit.isPending}
          />
        </div>
      </div>

      <ParamsPanel wb={wb} />
      <Results wb={wb} />
    </div>
  );
}
