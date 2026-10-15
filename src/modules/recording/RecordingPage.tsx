import { Page, PageHeader } from "../../components/page";
import { RecordingSettingsCard } from "./RecordingSettingsCard";

/** Dedicated configuration page for combat recording (#1013) — the same
 *  card Settings embeds, hosted as its own (hidden-by-default) sidebar
 *  module so the feature is discoverable and testable in one place. */
export function RecordingPage() {
  return (
    <Page width="narrow">
      <PageHeader
        title="Recording"
        subtitle="Start an external recorder automatically when the Combat Overview detects a fight. Requires the Combat Overview (Settings) and a configured gamelogs folder (DPS Meter)."
      />
      <div className="mt-6 divide-y divide-zinc-800 rounded-lg border border-zinc-800 bg-zinc-900/40">
        <RecordingSettingsCard />
      </div>
    </Page>
  );
}
