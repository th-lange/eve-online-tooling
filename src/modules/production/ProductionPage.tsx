import { DataAge } from "../../components/DataAge";
import { Page, PageHeader, PrimaryButton } from "../../components/page";
import { SdeGate } from "../../components/SdeGate";
import { ParamsPanel } from "./ParamsPanel";
import { Results } from "./Results";
import { useWorkbench } from "./useWorkbench";

const TITLE = "Production";
const SUBTITLE =
  "Every manufacturable item, ranked by build-vs-buy profit. Search, then filter.";

export function ProductionPage() {
  return (
    <SdeGate title={TITLE} subtitle={SUBTITLE}>
      <Workbench />
    </SdeGate>
  );
}

function Workbench() {
  const wb = useWorkbench();
  const { update, calculate, profit } = wb;

  return (
    <Page>
      <PageHeader
        title={TITLE}
        subtitle={SUBTITLE}
        actions={
          <>
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
              <PrimaryButton
                onClick={calculate}
                disabled={profit.isPending}
                pending={profit.isPending}
                pendingLabel="Calculating…"
              >
                Calculate
              </PrimaryButton>
            </div>
            <DataAge
              updatedAt={profit.isSuccess ? profit.submittedAt : undefined}
              fetching={profit.isPending}
            />
          </>
        }
      />

      <ParamsPanel wb={wb} />
      <Results wb={wb} />
    </Page>
  );
}
