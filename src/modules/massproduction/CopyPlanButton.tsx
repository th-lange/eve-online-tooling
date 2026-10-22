import { ClipboardCopy } from "lucide-react";

import { type MassProductionPlan } from "../../lib/api";
import { useCopyToClipboard } from "../../lib/useCopyToClipboard";
import { exportBlueprintLines } from "./parseBlueprintLines";

/** Export the current blueprint list (resolved build-run counts included)
 * as a Multibuy-style "Name\tRuns" paste — share it with a teammate, or
 * paste it back into this same page later to reproduce the exact plan.
 * Disabled with nothing built yet to export. */
export function CopyPlanButton({ plan }: { plan: MassProductionPlan | null }) {
  const { copied, copy } = useCopyToClipboard(1500);
  const canCopy = plan != null && plan.matchedBlueprints.length > 0;
  return (
    <button
      onClick={() =>
        canCopy &&
        copy(
          exportBlueprintLines(
            plan.matchedBlueprints.map((b) => ({
              name: b.name,
              runs: b.totalRuns,
            })),
          ),
        )
      }
      disabled={!canCopy}
      title='Copy the current blueprint list with build-run counts (one "Name␉Runs" per line) — paste it back in later, or share it'
      className="flex items-center gap-1.5 rounded border border-zinc-700 px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
    >
      <ClipboardCopy size={13} />
      {copied ? "Copied ✓" : "Copy list"}
    </button>
  );
}
