import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  errorMessage,
  piPlanetsInSystem,
  systemSearch,
  type ChainNode,
} from "../../lib/api";
import { piKeys } from "../../lib/queryKeys";
import { InlineError } from "../../components/InlineError";
import { Combo } from "../../components/Combo";
import { ChainRow, PlanetBadges } from "./ChainRow";
import { type PlannerPick, pickLabel } from "./plannerTypes";

function PlanCard({
  pick,
  chain,
  siblingPicks,
  onRemove,
  onUpdate,
}: {
  pick: PlannerPick;
  chain: { isError: boolean; error: unknown; data: ChainNode | undefined };
  siblingPicks: PlannerPick[];
  onRemove: () => void;
  onUpdate: (patch: Partial<PlannerPick>) => void;
}) {
  // null = not editing → show the saved notes.
  const [notesDraft, setNotesDraft] = useState<string | null>(null);
  // null = not editing → show pickLabel(pick) (the override, or the live
  // auto-derived "System · Planet · Product" default).
  const [labelDraft, setLabelDraft] = useState<string | null>(null);
  const planets = useQuery({
    queryKey: piKeys.planetsInSystem(pick.systemId),
    queryFn: () => piPlanetsInSystem(pick.systemId!),
    enabled: pick.systemId != null,
  });

  function commitNotes() {
    if (notesDraft === null) return;
    const next = notesDraft;
    setNotesDraft(null);
    if (next !== pick.notes) onUpdate({ notes: next });
  }

  function commitLabel() {
    if (labelDraft === null) return;
    const next = labelDraft.trim();
    setLabelDraft(null);
    if (next === pickLabel(pick)) return;
    // Blank clears the override, reverting to the live auto-derived
    // default instead of storing an empty string as a "name".
    onUpdate({ label: next || null });
  }

  /** Toggle "this material in my own chain is imported from another
   *  planned colony" for one node's type id. */
  function toggleImport(typeId: number) {
    const next = pick.imports.includes(typeId)
      ? pick.imports.filter((t) => t !== typeId)
      : [...pick.imports, typeId];
    onUpdate({ imports: next });
  }

  return (
    <div className="relative rounded border border-zinc-800 bg-zinc-900/40 p-4">
      <button
        type="button"
        onClick={onRemove}
        title="Remove from planner"
        aria-label={`Remove ${pick.name} from planner`}
        className="absolute right-3 top-3 rounded border border-zinc-700 px-1.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
      >
        ✕
      </button>

      {chain.isError && (
        <InlineError message={errorMessage(chain.error)} className="mb-2" />
      )}

      {chain.data && (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 pr-6">
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <input
                type="text"
                value={labelDraft ?? pickLabel(pick)}
                onChange={(e) => setLabelDraft(e.currentTarget.value)}
                onBlur={commitLabel}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setLabelDraft(null);
                  if (e.key === "Enter") e.currentTarget.blur();
                }}
                aria-label={`Name for ${pick.name}`}
                title="Editable — defaults to System · Planet · Product once picked"
                className="min-w-0 rounded border border-transparent bg-transparent px-0 text-lg font-medium text-zinc-100 outline-none hover:border-zinc-700 focus:border-zinc-500"
              />
              <span className="text-xs text-zinc-500">
                {chain.data.name} · P{chain.data.tier}
              </span>
            </div>
            <PlanetBadges
              planetTypes={chain.data.planetTypes}
              tier={chain.data.tier}
            />
          </div>
          {(() => {
            const exportedTo = siblingPicks.filter((o) =>
              o.imports.includes(pick.id),
            );
            return (
              exportedTo.length > 0 && (
                <div className="mt-1 text-xs text-indigo-400">
                  ↳ Exported to:{" "}
                  {exportedTo.map((o) => pickLabel(o)).join(", ")}
                </div>
              )
            );
          })()}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Combo
              label="System"
              value={
                pick.systemId != null
                  ? { id: pick.systemId, name: pick.systemName ?? "" }
                  : null
              }
              onPick={(v) =>
                onUpdate({
                  systemId: v?.id ?? null,
                  systemName: v?.name ?? null,
                  // A new system invalidates whichever planet was picked
                  // under the old one.
                  planetId: null,
                  planetName: null,
                })
              }
              search={systemSearch}
              placeholder="Solar system…"
              width="w-40"
            />
            {pick.systemId != null && (
              <label className="flex flex-col gap-1 text-xs text-zinc-400">
                Planet
                <select
                  value={pick.planetId ?? ""}
                  onChange={(e) => {
                    const id = Number(e.currentTarget.value) || null;
                    const name =
                      planets.data?.find((pl) => pl.id === id)?.name ?? null;
                    onUpdate({ planetId: id, planetName: name });
                  }}
                  className="w-48 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
                >
                  <option value="">
                    {planets.isLoading ? "Loading…" : "Pick a planet…"}
                  </option>
                  {planets.data?.map((pl) => (
                    <option key={pl.id} value={pl.id}>
                      {pl.name} ({pl.planetType})
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>

          <textarea
            value={notesDraft ?? pick.notes}
            onChange={(e) => setNotesDraft(e.currentTarget.value)}
            onBlur={commitNotes}
            onKeyDown={(e) => {
              if (e.key === "Escape") setNotesDraft(null);
            }}
            placeholder="Notes — what you're building, sub-products for a later cycle…"
            rows={2}
            className="mt-2 w-full resize-y rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-none placeholder:text-zinc-500"
          />

          <div className="mt-3 space-y-1">
            {chain.data.children.map((c) => (
              <ChainRow
                key={c.typeId}
                node={c}
                depth={0}
                siblingPicks={siblingPicks}
                imports={pick.imports}
                onToggleImport={toggleImport}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

export { PlanCard };
