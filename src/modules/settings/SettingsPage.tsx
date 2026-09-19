import { Page, PageHeader } from "../../components/page";
import { useFightOverlay } from "../pvp/fightOverlayContext";

/**
 * App-wide preferences that don't belong to any one feature module. The
 * underlying state for each setting still lives where its behavior is
 * implemented (e.g. the fight overlay's `enabled` flag lives in
 * `FightOverlayProvider`, mounted at the app root) — this page is just a
 * discoverable, central place to flip them, alongside the PVP page's own
 * "Show fight overlay" checkbox.
 */
export function SettingsPage() {
  const { enabled: combatOverviewOn, setEnabled: setCombatOverviewOn } =
    useFightOverlay();

  return (
    <Page>
      <PageHeader
        title="Settings"
        subtitle="App-wide preferences that apply across every module."
      />
      <div className="mt-6 divide-y divide-zinc-800 rounded-lg border border-zinc-800 bg-zinc-900/40">
        <label className="flex cursor-pointer items-start justify-between gap-4 p-4">
          <span>
            <span className="block text-sm font-medium text-zinc-100">
              Display Combat Overview
            </span>
            <span className="mt-0.5 block text-xs text-zinc-500">
              Pop over live combat details — attackers, DPS, and their fits —
              the moment your gamelog shows you in a fight. Shown over every
              module, not just PVP.
            </span>
          </span>
          <input
            type="checkbox"
            checked={combatOverviewOn}
            onChange={(e) => setCombatOverviewOn(e.currentTarget.checked)}
            className="mt-1 h-4 w-4 shrink-0 accent-indigo-500"
          />
        </label>
      </div>
    </Page>
  );
}
