import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  activeCharacter,
  piColonyNoteSet,
  piLockedGet,
  piLockedSet,
  piOverview,
  type ColonyView,
} from "../../lib/api";
import { authKeys, piKeys } from "../../lib/queryKeys";
import { Page, PageHeader, PrimaryButton } from "../../components/page";
import { SdeGate } from "../../components/SdeGate";
import { ColoniesTab } from "./ColoniesTab";
import { PlannerTab } from "./PlannerTab";

type Tab = "colonies" | "planner";

const TITLE = "Planetary Interaction";
const SUBTITLE =
  "Your colonies — what's extracting/producing, when extractors need a restart, storage usage, and where inputs fall short.";

export function PIPage() {
  return (
    <SdeGate title={TITLE} subtitle={SUBTITLE}>
      <Workbench />
    </SdeGate>
  );
}

function Workbench() {
  const qc = useQueryClient();
  // The backend resolves colonies against its own bookmarked active
  // character (or the whole roster for "All characters") — folding that
  // selection into the query key means switching characters refetches
  // instead of rendering the previous character's colonies from cache.
  const active = useQuery({
    queryKey: authKeys.active,
    queryFn: activeCharacter,
  });
  const colonies = useQuery({
    queryKey: piKeys.overview(active.data ?? null),
    queryFn: piOverview,
  });
  const locked = useQuery({ queryKey: piKeys.locked, queryFn: piLockedGet });
  const lockedSet = new Set(locked.data ?? []);

  const setLock = useMutation({
    mutationFn: (ids: number[]) => piLockedSet(ids),
    onSuccess: () => qc.invalidateQueries({ queryKey: piKeys.locked }),
  });
  const toggleLock = (typeId: number) => {
    const next = new Set(lockedSet);
    next.has(typeId) ? next.delete(typeId) : next.add(typeId);
    setLock.mutate([...next]);
  };

  // Notes/target products are local, not ESI — on save, merge the resolved
  // result straight into the cached overview instead of refetching from ESI.
  const saveNotes = useMutation({
    mutationFn: (vars: {
      characterId: number;
      planetId: number;
      notes: string;
      targetProductTypeIds: number[];
    }) =>
      piColonyNoteSet(
        vars.characterId,
        vars.planetId,
        vars.notes,
        vars.targetProductTypeIds,
      ),
    onSuccess: (view) => {
      qc.setQueryData<ColonyView[]>(
        piKeys.overview(active.data ?? null),
        (old) =>
          old?.map((c) =>
            c.characterId === view.characterId && c.planetId === view.planetId
              ? { ...c, notes: view.notes, targetProducts: view.targetProducts }
              : c,
          ),
      );
    },
  });
  const onSaveNotes = (
    characterId: number,
    planetId: number,
    notes: string,
    targetProductTypeIds: number[],
  ) => saveNotes.mutate({ characterId, planetId, notes, targetProductTypeIds });

  // Tick so extractor restart countdowns stay live (minute granularity is plenty).
  const [now, setNow] = useState(() => Date.now());
  const [sort, setSort] = useState<"default" | "restart">("default");
  const [tab, setTab] = useState<Tab>("colonies");
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  // "restart" floats colonies whose extractor program has ended to the top;
  // stable within each group so it otherwise keeps ESI's default order.
  const rows = useMemo(() => {
    const base = colonies.data ?? [];
    if (sort === "default") return base;
    return [...base].sort(
      (a, b) => Number(b.needsAttention) - Number(a.needsAttention),
    );
  }, [colonies.data, sort]);

  // Show the pilot label on each card only once colonies span more than one
  // character (i.e. "All characters" is active); single-character views stay
  // exactly as before.
  const multiCharacter = useMemo(
    () => new Set(rows.map((c) => c.characterId)).size > 1,
    [rows],
  );

  return (
    <Page>
      <PageHeader
        title={TITLE}
        subtitle={SUBTITLE}
        actions={
          tab === "colonies" ? (
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1 text-xs text-zinc-400">
                Sort
                <select
                  value={sort}
                  onChange={(e) =>
                    setSort(e.currentTarget.value as "default" | "restart")
                  }
                  className="rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-100 outline-none"
                >
                  <option value="default">Default</option>
                  <option value="restart">Restart required</option>
                </select>
              </label>
              <PrimaryButton
                onClick={() => colonies.refetch()}
                disabled={colonies.isFetching}
                pending={colonies.isFetching}
                pendingLabel="Loading…"
              >
                Refresh
              </PrimaryButton>
            </div>
          ) : null
        }
      />

      {/* Tab strip */}
      <div className="mt-4 inline-flex rounded border border-zinc-800 bg-zinc-900 p-0.5">
        {(["colonies", "planner"] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded px-3 py-1.5 text-sm capitalize ${
              tab === t
                ? "bg-zinc-700 text-zinc-100"
                : "text-zinc-400 hover:text-zinc-200"
            }`}
          >
            {t === "planner" ? "Planner" : "Colonies"}
          </button>
        ))}
      </div>

      {tab === "colonies" ? (
        <ColoniesTab
          colonies={colonies}
          rows={rows}
          now={now}
          lockedSet={lockedSet}
          onToggleLock={toggleLock}
          multiCharacter={multiCharacter}
          onSaveNotes={onSaveNotes}
        />
      ) : (
        <PlannerTab />
      )}
    </Page>
  );
}
