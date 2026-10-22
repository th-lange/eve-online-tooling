import { useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { RotateCcw, Trash2 } from "lucide-react";

import {
  errorMessage,
  type MassProductionPlan,
  type MatchedBlueprint,
  type PlanMode,
} from "../../lib/api";
import { assetsKeys } from "../../lib/queryKeys";
import { formatInt } from "../../lib/format";
import { InlineError } from "../../components/InlineError";
import { groupByTier } from "./massProductionHelpers";
import { GroupSection } from "./GroupSection";

export function PlanResult({
  plan,
  mode,
  overrides,
  onCommitBuildRuns,
  onRemoveBlueprint,
}: {
  plan: MassProductionPlan;
  mode: PlanMode;
  overrides: Record<number, number>;
  onCommitBuildRuns: (typeId: number, value: number | null) => void;
  onRemoveBlueprint: (typeId: number) => void;
}) {
  const copiesHeader = mode === "hypothetical" ? "Assumed ME" : "Owned copies";

  // The picker's option list: a lightweight, pricing-free read of where the
  // roster has assets (`assets_locations`) — unlike `assets_load` it doesn't
  // force a Jita valuation fetch just to populate a dropdown. `enabled:
  // false` only turns off this query's own auto-fetch-on-mount; the first
  // picker focus (or the button below) triggers the fetch.
  const qc = useQueryClient();
  const locationsQuery = useQuery({
    ...assetsKeys.locations(),
    enabled: false,
  });
  const locations = locationsQuery.data ?? [];

  // A group's location <select> calls this on focus: if nothing's loaded
  // yet and there's no fetch already in flight, kick one off silently —
  // the select stays usable and shows a "Loading…" placeholder while it
  // resolves, so opening the picker is enough to populate it without a
  // separate button click first.
  const requestLocations = () => {
    if (locationsQuery.data == null && !locationsQuery.isFetching) {
      void locationsQuery.refetch();
    }
  };
  // Reload also drops cached per-location stock so a re-pick sees fresh data.
  const reloadLocations = () => {
    void qc.invalidateQueries({ queryKey: assetsKeys.stockAll });
    void locationsQuery.refetch();
  };

  return (
    <div className="flex flex-col gap-4">
      {plan.unresolvedNames.length > 0 && (
        <div className="rounded border border-amber-800 bg-amber-950/40 px-3 py-2 text-sm text-amber-300">
          Didn't match any blueprint name — check spelling:{" "}
          {plan.unresolvedNames.join(", ")}
        </div>
      )}

      {plan.matchedBlueprints.length === 0 ? (
        <div className="rounded border border-zinc-800 px-3 py-3 text-center text-sm text-zinc-500">
          No blueprint names resolved.
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {groupByTier(plan.matchedBlueprints).map((g) => (
            <TierSection
              key={g.tier}
              tier={g.tier}
              blueprints={g.items}
              mode={mode}
              copiesHeader={copiesHeader}
              overrides={overrides}
              onCommitBuildRuns={onCommitBuildRuns}
              onRemove={onRemoveBlueprint}
            />
          ))}
        </div>
      )}

      {plan.groups.length === 0 ? (
        <div className="text-sm text-zinc-500">
          {mode === "hypothetical"
            ? "No resolved blueprints — nothing to buy."
            : "No owned copies of the pasted blueprints — nothing to buy."}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-2 text-xs text-zinc-500">
            <button
              onClick={reloadLocations}
              disabled={locationsQuery.isFetching}
              className="rounded border border-zinc-700 px-2 py-1 text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
            >
              {locationsQuery.isFetching
                ? "Loading locations…"
                : locationsQuery.isSuccess
                  ? "Reload locations"
                  : "Load stock locations"}
            </button>
            {locationsQuery.isSuccess && (
              <span>
                Pick a location per group below to subtract what the roster
                already has there.
              </span>
            )}
            <InlineError
              message={
                locationsQuery.isError
                  ? errorMessage(locationsQuery.error)
                  : null
              }
            />
          </div>
          {plan.groups.map((g) => (
            <GroupSection
              key={g.categoryName}
              group={g}
              locations={locations}
              locationsFetching={locationsQuery.isFetching}
              onRequestLocations={requestLocations}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/** One tech-tier bucket of the pasted blueprint list (e.g. "Tech I") — a
 * collapsible table, same chrome as the materials `GroupSection` below. */
function TierSection({
  tier,
  blueprints,
  mode,
  copiesHeader,
  overrides,
  onCommitBuildRuns,
  onRemove,
}: {
  tier: string;
  blueprints: MatchedBlueprint[];
  mode: PlanMode;
  copiesHeader: string;
  overrides: Record<number, number>;
  onCommitBuildRuns: (typeId: number, value: number | null) => void;
  onRemove: (typeId: number) => void;
}) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="rounded border border-zinc-800">
      <button
        onClick={() => setCollapsed((c) => !c)}
        className="flex w-full items-center gap-2 border-b border-zinc-800 bg-zinc-900 px-3 py-2 text-left text-sm font-medium text-zinc-200"
      >
        <span className="text-zinc-500">{collapsed ? "▸" : "▾"}</span>
        {tier}
        <span className="text-xs font-normal text-zinc-500">
          ({blueprints.length} blueprint{blueprints.length === 1 ? "" : "s"})
        </span>
      </button>
      {!collapsed && (
        <table className="w-full border-collapse text-sm">
          <thead className="bg-zinc-900/60 text-zinc-400">
            <tr>
              <th className="px-3 py-1.5 text-left">Blueprint</th>
              <th className="px-3 py-1.5 text-right">{copiesHeader}</th>
              <th className="px-3 py-1.5 text-right">Runs to build</th>
              <th className="px-3 py-1.5 text-right" />
            </tr>
          </thead>
          <tbody>
            {blueprints.map((b) => (
              <tr key={b.typeId} className="border-t border-zinc-800">
                <td className="px-3 py-1.5 text-zinc-200">
                  {b.name}
                  {b.assumed?.specialEdition && (
                    <span
                      title="Faction/Officer/Deadspace-tier item — assumed ME0, not best-researched"
                      className="ml-2 rounded border border-amber-700 bg-amber-950/50 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-amber-400"
                    >
                      Special edition · ME0
                    </span>
                  )}
                </td>
                <td className="px-3 py-1.5 text-right text-zinc-300">
                  {mode === "hypothetical"
                    ? formatInt(b.assumed?.materialEfficiency ?? 0)
                    : formatInt(b.ownedCopies)}
                </td>
                <td className="px-3 py-1.5 text-right text-zinc-300">
                  <BuildRunsCell
                    typeId={b.typeId}
                    totalRuns={b.totalRuns}
                    overridden={overrides[b.typeId] != null}
                    onCommit={onCommitBuildRuns}
                  />
                </td>
                <td className="px-3 py-1.5 text-right">
                  <button
                    onClick={() => onRemove(b.typeId)}
                    aria-label={`Remove ${b.name}`}
                    title="Remove this blueprint from the build list"
                    className="text-zinc-600 hover:text-rose-400"
                  >
                    <Trash2 size={13} />
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** Editable "how many should be built" cell (#NNN) — keeps a local draft
 * while typing and commits once on blur/Enter, the same debounce-free
 * pattern Shopping Lists' quantity cells use, so a mid-edit keystroke never
 * fires a recompute. An empty commit clears the override, falling back to
 * the mode's computed default (real owned total, or the rule-derived
 * Hypothetical assumption); the ↺ button does the same in one click. */
function BuildRunsCell({
  typeId,
  totalRuns,
  overridden,
  onCommit,
}: {
  typeId: number;
  totalRuns: number;
  overridden: boolean;
  onCommit: (typeId: number, value: number | null) => void;
}) {
  // null = not editing → show the plan's current (server-computed) value.
  const [draft, setDraft] = useState<string | null>(null);

  function commit() {
    if (draft === null) return;
    setDraft(null);
    const trimmed = draft.trim();
    if (trimmed === "") {
      if (overridden) onCommit(typeId, null);
      return;
    }
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return;
    const next = Math.max(0, Math.round(n));
    if (next !== totalRuns || !overridden) onCommit(typeId, next);
  }

  return (
    <div className="flex items-center justify-end gap-1">
      <input
        type="number"
        min={0}
        value={draft ?? totalRuns}
        aria-label={`Runs to build of ${typeId}`}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") e.currentTarget.blur();
          else if (e.key === "Escape") setDraft(null);
        }}
        className="w-20 rounded bg-zinc-800 px-2 py-0.5 text-right text-zinc-100 outline-none"
      />
      {overridden && (
        <button
          onClick={() => onCommit(typeId, null)}
          title="Reset to the computed default"
          className="text-zinc-500 hover:text-zinc-300"
        >
          <RotateCcw size={12} />
        </button>
      )}
    </div>
  );
}
