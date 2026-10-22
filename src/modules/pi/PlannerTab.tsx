import { useMemo, useState } from "react";
import { useQueries } from "@tanstack/react-query";
import {
  piProductionChain,
  sdeSearchPiCommodities,
  type PlannerSetupItem,
} from "../../lib/api";
import { piKeys } from "../../lib/queryKeys";
import { Combo } from "../../components/Combo";
import { Centered } from "../../components/page";
import { usePersistentState } from "../../lib/usePersistentState";
import { STORAGE_KEYS } from "../../lib/storageKeys";
import { PlanCard } from "./PlanCard";
import { SetupsPanel } from "./SetupsPanel";
import { type PlannerPick } from "./plannerTypes";

function PlannerTab() {
  // Persisted across visits/reloads ("remember" — #963) rather than
  // session-only useState: the whole point is the plan survives navigating
  // away and coming back, not just a re-render.
  const [picksRaw, setPicks] = usePersistentState<PlannerPick[]>(
    STORAGE_KEYS.piPlannerPicks,
    [],
  );
  // `imports` was added after this storage key already had real data in
  // it — a pre-existing pick's stored JSON has no `imports` key at all, so
  // `JSON.parse` leaves it `undefined` rather than `[]`. Normalize once
  // here so every reader below can assume `imports` is always an array.
  const picks = useMemo(
    () => picksRaw.map((p) => (p.imports ? p : { ...p, imports: [] })),
    [picksRaw],
  );
  // The Combo's own controlled value — always reset to null right after an
  // add so the search field clears and is ready for the next pick, instead
  // of locking onto the last-picked commodity's name.
  const [picker, setPicker] = useState<{ id: number; name: string } | null>(
    null,
  );

  function addPick(v: { id: number; name: string } | null) {
    if (v && !picks.some((p) => p.id === v.id)) {
      setPicks([
        ...picks,
        {
          id: v.id,
          name: v.name,
          notes: "",
          systemId: null,
          systemName: null,
          planetId: null,
          planetName: null,
          imports: [],
          label: null,
        },
      ]);
    }
    setPicker(null);
  }
  function removePick(id: number) {
    // Also drop `id` from every remaining pick's `imports` — otherwise a
    // removed colony leaves other picks pointing at a producer that no
    // longer exists.
    setPicks(
      picks
        .filter((p) => p.id !== id)
        .map((p) => ({ ...p, imports: p.imports.filter((t) => t !== id) })),
    );
  }
  function updatePick(id: number, patch: Partial<PlannerPick>) {
    setPicks(picks.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  }
  function loadSetup(items: PlannerSetupItem[]) {
    setPicks(
      items.map((i) => ({
        id: i.typeId,
        name: i.name,
        notes: i.notes,
        systemId: i.systemId,
        systemName: i.systemName,
        planetId: i.planetId,
        planetName: i.planetName,
        imports: i.imports,
        label: i.label,
      })),
    );
  }

  const chains = useQueries({
    queries: picks.map((p) => ({
      queryKey: piKeys.productionChain(p.id),
      queryFn: () => piProductionChain(p.id),
    })),
  });

  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <Combo
            key={picks.length}
            label="Commodity"
            value={picker}
            onPick={addPick}
            search={sdeSearchPiCommodities}
            placeholder="Search a P1-P4 commodity…"
          />
          {picks.length > 0 && (
            <button
              type="button"
              onClick={() => setPicks([])}
              className="mt-5 rounded border border-zinc-700 px-2.5 py-1 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-zinc-200"
            >
              Clear all
            </button>
          )}
        </div>
        <SetupsPanel picks={picks} onLoad={loadSetup} />
      </div>

      {picks.length === 0 && (
        <Centered>
          Pick a P1-P4 commodity to see which planet type(s) can produce it
          alone, and its full production chain down to raw resources. Add as
          many as you like, note what each is for and where you're building it —
          they stay here until you remove them, or save the whole set as a
          reusable setup.
        </Centered>
      )}

      <div className="mt-4 space-y-4">
        {picks.map((p, i) => (
          <PlanCard
            key={p.id}
            pick={p}
            chain={chains[i]}
            siblingPicks={picks.filter((o) => o.id !== p.id)}
            onRemove={() => removePick(p.id)}
            onUpdate={(patch) => updatePick(p.id, patch)}
          />
        ))}
      </div>
    </div>
  );
}

export { PlannerTab };
