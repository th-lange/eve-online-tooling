import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  useMutation,
  useQueries,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { FolderOpen, Save, Trash2 } from "lucide-react";
import {
  activeCharacter,
  errorMessage,
  piColonyNoteSet,
  piLockedGet,
  piLockedSet,
  piOverview,
  piPlanetsInSystem,
  piPlannerSetupDelete,
  piPlannerSetups,
  piPlannerSetupSave,
  piProductionChain,
  piShowInGame,
  sdeSearchPiCommodities,
  systemSearch,
  type ChainNode,
  type ColonyView,
  type ExtractorView,
  type PlannerSetupItem,
  type StorageView,
} from "../../lib/api";
import { authKeys, piKeys } from "../../lib/queryKeys";
import { InlineError } from "../../components/InlineError";
import { QueryErrorNotice } from "../../components/QueryErrorNotice";
import { Combo } from "../../components/Combo";
import { formatInt } from "../../lib/format";
import {
  Page,
  PageHeader,
  Centered,
  PrimaryButton,
} from "../../components/page";
import { SdeGate } from "../../components/SdeGate";
import { usePersistentState } from "../../lib/usePersistentState";
import { STORAGE_KEYS } from "../../lib/storageKeys";
import {
  EPS,
  extractionAdvice,
  runway,
  runwayThresholds,
  stockMaps,
} from "./balance";

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
        <>
          <QueryErrorNotice
            error={colonies.error}
            loginMessage="Log in a character first to view your colonies."
            scopeHint={
              <>
                needs <code>esi-planets.manage_planets.v1</code> — re-login if
                just enabled
              </>
            }
            className="mt-4 text-sm"
          />

          {!colonies.isError && rows.length === 0 && !colonies.isFetching && (
            <Centered>No colonies found for this character.</Centered>
          )}

          <div className="mt-4 grid gap-4 xl:grid-cols-2">
            {rows.map((c) => (
              <Colony
                key={`${c.characterId}:${c.planetId}`}
                colony={c}
                now={now}
                lockedSet={lockedSet}
                onToggleLock={toggleLock}
                showCharacter={multiCharacter}
                onSaveNotes={onSaveNotes}
              />
            ))}
          </div>
        </>
      ) : (
        <Planner />
      )}
    </Page>
  );
}

/** One commodity planned on the Planner tab: the pick itself, free-text
 * notes, and the (optional) solar system/planet it's assigned to build on.
 * Persisted as-is (see `picks` below) and is exactly the shape a setup is
 * saved/loaded as (#965). */
interface PlannerPick {
  id: number;
  name: string;
  notes: string;
  systemId: number | null;
  systemName: string | null;
  planetId: number | null;
  planetName: string | null;
  /** Material type ids within this pick's own production chain that are
   *  marked "produced on another planned colony, ship it in instead" —
   *  matched against another pick's `id` in the same plan. Toggled from
   *  the consuming side (the chain node for the imported material), not
   *  the producing pick. */
  imports: number[];
  /** A user-chosen display name, overriding the default "System · Planet ·
   *  Product" label below — `null` means "still using the auto-derived
   *  default", not "no name". */
  label: string | null;
}

/** Display label for a pick — the user's own override if set, else a live
 *  "System · Planet · Product" default built from whatever's picked so far
 *  (just the product name if neither system nor planet is assigned yet).
 *  Used both on the pick's own card and whenever another pick refers to it
 *  (an "Import from …" / "Exported to …" hint). */
function pickLabel(p: PlannerPick): string {
  const auto = [p.systemName, p.planetName, p.name].filter(Boolean).join(" · ");
  return p.label ?? auto;
}

function Planner() {
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

/** "Setups ▾" — save the current picks (with their notes/system/planet)
 * under a name, or load/delete a previously saved one. Loading replaces
 * the whole working plan, same semantics as Mass Production's build-list
 * panel this mirrors. */
function SetupsPanel({
  picks,
  onLoad,
}: {
  picks: PlannerPick[];
  onLoad: (items: PlannerSetupItem[]) => void;
}) {
  const qc = useQueryClient();
  const [browseOpen, setBrowseOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);

  const setupsQuery = useQuery({
    queryKey: piKeys.setups,
    queryFn: piPlannerSetups,
    enabled: browseOpen,
  });

  const save = useMutation({
    mutationFn: (setupName: string) =>
      piPlannerSetupSave(
        setupName,
        picks.map((p) => ({
          typeId: p.id,
          notes: p.notes,
          systemId: p.systemId,
          systemName: p.systemName,
          planetId: p.planetId,
          planetName: p.planetName,
          imports: p.imports,
          label: p.label,
        })),
      ),
    onSuccess: () => {
      setSaveOpen(false);
      setName("");
      setSaveError(null);
      void qc.invalidateQueries({ queryKey: piKeys.setups });
    },
    onError: (e) => setSaveError(errorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => piPlannerSetupDelete(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: piKeys.setups }),
  });

  const canSave = picks.length > 0;

  return (
    <div className="flex items-center gap-2">
      <div className="relative">
        <button
          type="button"
          onClick={() => {
            setBrowseOpen((o) => !o);
            setSaveOpen(false);
          }}
          className="flex items-center gap-1.5 rounded border border-zinc-700 px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
        >
          <FolderOpen size={13} />
          Setups
        </button>
        {browseOpen && (
          <>
            <div
              className="fixed inset-0 z-10"
              onClick={() => setBrowseOpen(false)}
            />
            <div className="absolute right-0 z-20 mt-1 w-72 rounded border border-zinc-700 bg-zinc-900 p-2 shadow-lg">
              {setupsQuery.isLoading && (
                <div className="px-2 py-1 text-xs text-zinc-500">Loading…</div>
              )}
              {setupsQuery.data?.length === 0 && (
                <div className="px-2 py-1 text-xs text-zinc-500">
                  No saved setups yet.
                </div>
              )}
              {setupsQuery.data?.map((s) => (
                <div
                  key={s.id}
                  className="flex items-center justify-between gap-2 rounded px-2 py-1 hover:bg-zinc-800"
                >
                  <button
                    type="button"
                    onClick={() => {
                      onLoad(s.items);
                      setBrowseOpen(false);
                    }}
                    className="flex-1 truncate text-left text-xs text-zinc-200"
                    title={`Load "${s.name}" (${s.items.length} commodities)`}
                  >
                    {s.name}
                    <span className="ml-1.5 text-zinc-500">
                      ({s.items.length})
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => remove.mutate(s.id)}
                    aria-label={`Delete ${s.name}`}
                    title="Delete this setup"
                    className="shrink-0 text-zinc-500 hover:text-rose-400"
                  >
                    <Trash2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
      </div>

      {canSave && (
        <div className="relative">
          <button
            type="button"
            onClick={() => {
              setSaveOpen((o) => !o);
              setBrowseOpen(false);
            }}
            className="flex items-center gap-1.5 rounded border border-zinc-700 px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            <Save size={13} />
            {save.isSuccess && !saveOpen ? "Saved ✓" : "Save setup…"}
          </button>
          {saveOpen && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setSaveOpen(false)}
              />
              <div className="absolute right-0 z-20 mt-1 w-64 rounded border border-zinc-700 bg-zinc-900 p-2 shadow-lg">
                <input
                  value={name}
                  onChange={(e) => setName(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && name.trim())
                      save.mutate(name.trim());
                  }}
                  placeholder={`Setup — ${new Date().toLocaleDateString()}`}
                  autoFocus
                  className="w-full rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-100 outline-none placeholder:text-zinc-500"
                />
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={() => setSaveOpen(false)}
                    className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => name.trim() && save.mutate(name.trim())}
                    disabled={name.trim().length === 0 || save.isPending}
                    className="rounded bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
                  >
                    {save.isPending ? "Saving…" : "Save"}
                  </button>
                </div>
                <InlineError
                  message={saveError}
                  className="mt-1 text-xs text-rose-400"
                />
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Badge color by PI tier — a quick-scan cue for how deep in the chain a
 * material sits, independent of which specific planet types it lists (the
 * tier number itself is already shown as text next to the material's name,
 * so this is reinforcement, not the only signal, per #848). */
const TIER_BADGE_CLASS: Record<number, string> = {
  0: "bg-zinc-800 text-zinc-300",
  1: "bg-sky-900/40 text-sky-300",
  2: "bg-emerald-900/40 text-emerald-300",
  3: "bg-yellow-900/40 text-yellow-300",
  4: "bg-violet-900/40 text-violet-300",
};

function PlanetBadges({
  planetTypes,
  tier,
}: {
  planetTypes: string[];
  tier: number;
}) {
  if (planetTypes.length === 0) {
    return (
      <span className="rounded bg-amber-900/40 px-2 py-1 text-xs text-amber-300">
        Needs imports — no single planet
      </span>
    );
  }
  const className = TIER_BADGE_CLASS[tier] ?? TIER_BADGE_CLASS[0];
  return (
    <div className="flex flex-wrap gap-1">
      {planetTypes.map((pt) => (
        <span
          key={pt}
          className={`rounded px-2 py-0.5 text-xs ${className}`}
          title={`P${tier} material`}
        >
          {pt}
        </span>
      ))}
    </div>
  );
}

/** A P1 node has exactly one child — the P0 raw resource it depends on;
 * inline it as "← <name> (P0)" instead of a nested bullet, per the
 * planner's design in #882. The P0's own `planetTypes` isn't rendered
 * separately — a P1's own set is already its P0 input's set (that's how
 * `intersect_planet_types` computes it bottom-up), so a second badge row
 * would just repeat the one above it.
 *
 * Multi-colony imports: if another pick in the same plan produces this
 * exact material (its `id` matches `node.typeId`), a toggle offers "import
 * this from <that colony> instead of building it here" — once marked, the
 * node's own sub-tree (its P0/intermediate inputs) is pruned from this
 * render, since it's already accounted for under the producing pick's own
 * chain and listing it twice would double it up. */
function ChainRow({
  node,
  depth,
  siblingPicks,
  imports,
  onToggleImport,
}: {
  node: ChainNode;
  depth: number;
  siblingPicks: PlannerPick[];
  imports: number[];
  onToggleImport: (typeId: number) => void;
}) {
  const p0 = node.tier === 1 ? node.children[0] : null;
  const isImported = imports.includes(node.typeId);
  const source = siblingPicks.find((sp) => sp.id === node.typeId);
  return (
    <div>
      <div
        className="flex flex-wrap items-center gap-2 py-0.5 text-sm"
        style={{ paddingLeft: `${depth * 1.25}rem` }}
      >
        <span className="text-zinc-600">├─</span>
        <span className="text-zinc-200">{node.name}</span>
        <span className="text-xs text-zinc-500">P{node.tier}</span>
        {node.qtyPerCycle > 0 && (
          <span className="text-xs text-zinc-400">
            {formatInt(node.qtyPerCycle)}/cycle
          </span>
        )}
        {isImported ? (
          <span className="rounded bg-indigo-950/60 px-2 py-0.5 text-xs text-indigo-300">
            Imported
            {source ? ` from ${pickLabel(source)}` : ""}
          </span>
        ) : (
          <>
            {p0 && (
              <span className="text-xs text-zinc-500">← {p0.name} (P0)</span>
            )}
            <PlanetBadges planetTypes={node.planetTypes} tier={node.tier} />
          </>
        )}
        {(source || isImported) && (
          <button
            type="button"
            onClick={() => onToggleImport(node.typeId)}
            title={
              isImported
                ? "Stop treating this as imported — build it in this chain again"
                : `Mark as imported from ${source ? pickLabel(source) : ""} instead of building it here`
            }
            className={`rounded border px-1.5 py-0.5 text-[11px] ${
              isImported
                ? "border-indigo-600 bg-indigo-900/40 text-indigo-300"
                : "border-zinc-700 text-zinc-400 hover:bg-zinc-800"
            }`}
          >
            {isImported
              ? "✓ Linked"
              : `⇄ Import from ${source ? pickLabel(source) : ""}`}
          </button>
        )}
      </div>
      {node.tier > 1 &&
        !isImported &&
        node.children.map((c) => (
          <ChainRow
            key={c.typeId}
            node={c}
            depth={depth + 1}
            siblingPicks={siblingPicks}
            imports={imports}
            onToggleImport={onToggleImport}
          />
        ))}
    </div>
  );
}

function Colony({
  colony,
  now,
  lockedSet,
  onToggleLock,
  showCharacter,
  onSaveNotes,
}: {
  colony: ColonyView;
  now: number;
  lockedSet: Set<number>;
  onToggleLock: (typeId: number) => void;
  showCharacter: boolean;
  onSaveNotes: (
    characterId: number,
    planetId: number,
    notes: string,
    targetProductTypeIds: number[],
  ) => void;
}) {
  const [routeError, setRouteError] = useState<string | null>(null);
  return (
    <div
      className={`rounded border bg-zinc-900/40 p-3 ${
        colony.needsAttention ? "border-amber-800" : "border-zinc-800"
      }`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold text-zinc-100">
          {colony.systemName}
        </span>
        {showCharacter && (
          <span className="text-[11px] text-zinc-500">
            {colony.characterName}
          </span>
        )}
        <span className="rounded border border-zinc-700 bg-zinc-900 px-1.5 py-0.5 text-[11px] capitalize text-zinc-300">
          {colony.planetType}
        </span>
        <span className="text-[11px] text-zinc-500">
          L{colony.upgradeLevel} · {colony.pinCount} pins
        </span>
        {colony.needsAttention && (
          <span className="rounded border border-amber-700 bg-amber-950/30 px-1.5 py-0.5 text-[10px] text-amber-300">
            needs attention
          </span>
        )}
        <button
          onClick={() =>
            piShowInGame(colony.systemId)
              .then(() => setRouteError(null))
              .catch((e) => {
                console.error("Failed to set route to colony system", e);
                setRouteError(`Couldn't set route: ${errorMessage(e)}`);
              })
          }
          title="Set autopilot to this colony's system — ESI can't open a planet/system Show Info window directly"
          className="ml-auto rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800"
        >
          Route here ↗
        </button>
      </div>
      <InlineError
        message={routeError}
        className="mt-1 text-xs text-rose-400"
      />

      <NextCycle colony={colony} />

      {colony.extractors.length > 0 && (
        <Section title="Extractors">
          <div className="flex flex-col gap-1">
            {colony.extractors.map((e, i) => (
              <Extractor key={`${e.productTypeId}-${i}`} ex={e} now={now} />
            ))}
          </div>
        </Section>
      )}

      {colony.storage.length > 0 && (
        <Section title="Storage">
          <div className="flex flex-col gap-1.5">
            {colony.storage.map((s, i) => (
              <Storage key={i} s={s} />
            ))}
          </div>
        </Section>
      )}

      {colony.balance.length > 0 && (
        <Section title="Required vs available · runway">
          <Balance colony={colony} />
        </Section>
      )}

      {colony.produced.length > 0 && (
        <Section title="Produces">
          <div className="flex flex-wrap gap-1.5">
            {colony.produced.map((p) => {
              const on = lockedSet.has(p.typeId);
              return (
                <button
                  key={p.typeId}
                  onClick={() => onToggleLock(p.typeId)}
                  title={
                    on
                      ? "Locked in — click to unlock"
                      : "Click to lock in as produced"
                  }
                  className={`rounded border px-2 py-0.5 text-xs ${
                    on
                      ? "border-emerald-600 bg-emerald-950/30 text-emerald-300"
                      : "border-zinc-700 bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
                  }`}
                >
                  {on ? "🔒 " : ""}
                  {p.name}
                </button>
              );
            })}
          </div>
        </Section>
      )}

      <ColonyNotes colony={colony} onSave={onSaveNotes} />
    </div>
  );
}

/** Local, user-authored notes + a target-product list for one colony — not
 * from ESI, deleted automatically once the colony itself is gone (the
 * backend prunes orphaned rows against the live ESI colony list on every
 * fetch). Notes save on blur (not per-keystroke); target products save
 * immediately on add/remove, same as the lock-in buttons above. */
function ColonyNotes({
  colony,
  onSave,
}: {
  colony: ColonyView;
  onSave: (
    characterId: number,
    planetId: number,
    notes: string,
    targetProductTypeIds: number[],
  ) => void;
}) {
  // null = not editing → show the saved (server) notes.
  const [draft, setDraft] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ id: number; name: string } | null>(
    null,
  );

  function commitNotes() {
    if (draft === null) return;
    const next = draft;
    setDraft(null);
    if (next !== colony.notes) {
      onSave(
        colony.characterId,
        colony.planetId,
        next,
        colony.targetProducts.map((p) => p.typeId),
      );
    }
  }

  function addTarget(product: { id: number; name: string } | null) {
    if (
      !product ||
      colony.targetProducts.some((p) => p.typeId === product.id)
    ) {
      setPicked(null);
      return;
    }
    onSave(colony.characterId, colony.planetId, colony.notes, [
      ...colony.targetProducts.map((p) => p.typeId),
      product.id,
    ]);
    setPicked(null);
  }

  function removeTarget(typeId: number) {
    onSave(
      colony.characterId,
      colony.planetId,
      colony.notes,
      colony.targetProducts
        .filter((p) => p.typeId !== typeId)
        .map((p) => p.typeId),
    );
  }

  return (
    <Section title="Notes & target products">
      <div className="flex flex-wrap items-center gap-1.5">
        {colony.targetProducts.map((p) => (
          <span
            key={p.typeId}
            className="flex items-center gap-1 rounded border border-indigo-700 bg-indigo-950/30 px-1.5 py-0.5 text-xs text-indigo-300"
          >
            {p.name}
            <button
              onClick={() => removeTarget(p.typeId)}
              aria-label={`Remove ${p.name} from targets`}
              className="text-indigo-400 hover:text-indigo-100"
            >
              ×
            </button>
          </span>
        ))}
        <Combo
          value={picked}
          onPick={addTarget}
          search={sdeSearchPiCommodities}
          placeholder="Add target product…"
          width="w-44"
        />
      </div>
      <textarea
        value={draft ?? colony.notes}
        onChange={(e) => setDraft(e.currentTarget.value)}
        onBlur={commitNotes}
        onKeyDown={(e) => {
          if (e.key === "Escape") setDraft(null);
        }}
        placeholder="What are you building here — and any sub-products for a later cycle…"
        rows={2}
        className="mt-2 w-full resize-y rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-200 outline-none placeholder:text-zinc-500"
      />
    </Section>
  );
}

function Extractor({ ex, now }: { ex: ExtractorView; now: number }) {
  const { label, tone } = countdown(ex.expiryTime, now);
  const remainingPct = programRemainingPct(ex.installTime, ex.expiryTime, now);
  return (
    <div className="text-xs">
      <div className="flex items-center justify-between">
        <span className="text-zinc-300">{ex.product}</span>
        <span className="flex items-center gap-2">
          <span className="tabular-nums text-zinc-500">
            {formatInt(ex.qtyPerCycle)}/cycle
          </span>
          <span className={`tabular-nums ${tone}`}>{label}</span>
        </span>
      </div>
      {remainingPct !== null && (
        // Green = time remaining, red = elapsed (a live countdown bar).
        <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded bg-rose-900/60">
          <div
            className="h-full bg-emerald-600"
            style={{ width: `${remainingPct}%` }}
          />
        </div>
      )}
    </div>
  );
}

/** Fraction of an extraction program still remaining (0–100), or null if the
 * start/end aren't both known. Drives the green-remaining / red-elapsed bar. */
function programRemainingPct(
  install: string | null,
  expiry: string | null,
  now: number,
): number | null {
  if (!install || !expiry) return null;
  const start = Date.parse(install);
  const end = Date.parse(expiry);
  if (Number.isNaN(start) || Number.isNaN(end) || end <= start) return null;
  const pct = ((end - now) / (end - start)) * 100;
  return Math.max(0, Math.min(100, pct));
}

function Storage({ s }: { s: StorageView }) {
  const pct =
    s.capacity > 0 ? Math.min(100, (s.usedVolume / s.capacity) * 100) : 0;
  const tone =
    pct >= 90 ? "bg-rose-600" : pct >= 70 ? "bg-amber-600" : "bg-emerald-600";
  return (
    <div>
      <div className="flex items-center justify-between text-[11px] text-zinc-400">
        <span>{s.name}</span>
        <span className="tabular-nums">
          {formatInt(Math.round(s.usedVolume))} /{" "}
          {formatInt(Math.round(s.capacity))} m³
        </span>
      </div>
      <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded bg-zinc-800">
        <div className={tone} style={{ width: `${pct}%`, height: "100%" }} />
      </div>
    </div>
  );
}

function NextCycle({ colony }: { colony: ColonyView }) {
  // Only meaningful once the chain is running (extractors + a balance).
  if (colony.extractors.length === 0 || colony.balance.length === 0)
    return null;
  const { short, over } = extractionAdvice(colony);

  if (short.length === 0 && over.length === 0) {
    return (
      <div className="mt-2 rounded border border-zinc-800 bg-zinc-900/40 px-2.5 py-1.5 text-xs text-zinc-500">
        Next cycle: extraction matches consumption — no change needed.
      </div>
    );
  }
  return (
    <div className="mt-2 rounded border border-sky-900/50 bg-sky-950/20 px-2.5 py-2 text-xs">
      <div className="mb-1 font-medium text-sky-300">Next extraction cycle</div>
      {short.length > 0 && (
        <div className="flex flex-wrap items-center gap-1">
          <span className="text-zinc-400">Feed (draining):</span>
          {short.slice(0, 4).map((r) => (
            <span
              key={r.typeId}
              className="rounded bg-rose-500/15 px-1.5 py-0.5 text-rose-300"
              title={`${formatInt(Math.round(r.stock))} in storage`}
            >
              {r.name} <span className="tabular-nums">−{fmt(-r.net)}/h</span>
              {r.stock <= EPS ? (
                <span className="ml-1 text-rose-400">· empty</span>
              ) : Number.isFinite(r.runwayHours) ? (
                <span className="ml-1 tabular-nums text-rose-400/80">
                  · {fmt(r.runwayHours)}h left
                </span>
              ) : null}
            </span>
          ))}
        </div>
      )}
      {over.length > 0 && (
        <div className="mt-1 flex flex-wrap items-center gap-1">
          <span className="text-zinc-400">Ease off (banking):</span>
          {over.slice(0, 4).map((r) => (
            <span
              key={r.typeId}
              className="rounded bg-sky-500/15 px-1.5 py-0.5 text-sky-300"
            >
              {r.name}{" "}
              <span className="tabular-nums">
                {formatInt(Math.round(r.stock))} on hand
              </span>
            </span>
          ))}
        </div>
      )}
      <div className="mt-1.5 text-[11px] text-zinc-500">
        Aim more extractor heads/time at the raw inputs feeding the “feed” list
        (lowest runway first); pull them off the “ease off” list.
      </div>
    </div>
  );
}

function Balance({ colony }: { colony: ColonyView }) {
  const { stock } = stockMaps(colony);
  const thresholds = runwayThresholds(colony, Date.now());
  return (
    <table className="w-full text-xs">
      <thead className="text-zinc-500">
        <tr>
          <th className="py-0.5 text-left font-medium">Commodity</th>
          <th className="py-0.5 text-right font-medium">Made/h</th>
          <th className="py-0.5 text-right font-medium">Used/h</th>
          <th className="py-0.5 text-right font-medium">Net/h</th>
          <th className="py-0.5 text-right font-medium">On hand</th>
          <th className="py-0.5 text-right font-medium">Runway</th>
        </tr>
      </thead>
      <tbody>
        {colony.balance.map((r) => {
          const onHand = stock.get(r.typeId) ?? 0;
          const rw = runway(onHand, r.net, thresholds);
          return (
            <tr key={r.typeId} className="border-t border-zinc-800/60">
              <td className="py-0.5 text-zinc-300">{r.name}</td>
              <td className="py-0.5 text-right tabular-nums text-zinc-400">
                {fmt(r.producedPerHour)}
              </td>
              <td className="py-0.5 text-right tabular-nums text-zinc-400">
                {fmt(r.consumedPerHour)}
              </td>
              <td
                className={`py-0.5 text-right tabular-nums ${
                  r.net < -EPS
                    ? "text-rose-400"
                    : r.net > EPS
                      ? "text-emerald-400"
                      : "text-zinc-500"
                }`}
              >
                {r.net > 0 ? "+" : ""}
                {fmt(r.net)}
              </td>
              <td className="py-0.5 text-right tabular-nums text-zinc-400">
                {formatInt(Math.round(onHand))}
              </td>
              <td
                className={`py-0.5 text-right tabular-nums font-medium ${rw.tone}`}
                title={rw.title}
              >
                {rw.label}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Round a per-hour rate for display (keeps one decimal for small rates). */
function fmt(n: number): string {
  if (n === 0) return "0";
  return Math.abs(n) >= 10 ? formatInt(Math.round(n)) : n.toFixed(1);
}

/** Remaining time to an ISO expiry, as a label + colour tone. */
function countdown(
  expiry: string | null,
  now: number,
): { label: string; tone: string } {
  if (!expiry) return { label: "no program", tone: "text-zinc-500" };
  const ms = Date.parse(expiry) - now;
  if (Number.isNaN(ms)) return { label: "—", tone: "text-zinc-500" };
  if (ms <= 0) return { label: "restart now", tone: "text-rose-400" };
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const label =
    h >= 24
      ? `${Math.floor(h / 24)}d ${h % 24}h`
      : h > 0
        ? `${h}h ${m}m`
        : `${m}m`;
  return {
    label: `in ${label}`,
    tone: ms < 3_600_000 ? "text-amber-300" : "text-zinc-300",
  };
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-3">
      <div className="mb-1 text-[11px] uppercase tracking-wide text-zinc-500">
        {title}
      </div>
      {children}
    </div>
  );
}
