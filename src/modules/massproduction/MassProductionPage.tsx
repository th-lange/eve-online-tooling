import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  ClipboardCopy,
  FolderOpen,
  Loader2,
  RotateCcw,
  Save,
  Trash2,
} from "lucide-react";

import {
  errorMessage,
  isAuthRequired,
  massprodDeleteList,
  massprodLists,
  massprodPlan,
  massprodSaveList,
  shoppingAddItem,
  shoppingCreateList,
  DEFAULT_HYPOTHETICAL_CONFIG,
  type AssetLocation,
  type BlueprintLine,
  type BuildList,
  type HypotheticalConfig,
  type MassProductionPlan,
  type MatchedBlueprint,
  type MaterialGroup,
  type PlanMode,
} from "../../lib/api";
import {
  assetsKeys,
  massprodKeys,
  SHOPPING_LISTS_KEY,
} from "../../lib/queryKeys";
import { formatInt } from "../../lib/format";
import { useCopyToClipboard } from "../../lib/useCopyToClipboard";
import { Page, PageHeader } from "../../components/page";
import { InlineError } from "../../components/InlineError";
import { Field } from "../../components/forms";
import { PasteImportControl } from "../../components/PasteImportControl";
import { SdeGate } from "../../components/SdeGate";
import {
  exportBlueprintLines,
  parseBlueprintLines,
} from "./parseBlueprintLines";

const TITLE = "Mass Production";
const SUBTITLE =
  "Paste blueprints and get a categorized shopping list to run all of them — matched against what the roster/corp actually own, or a rule-derived assumption in Hypothetical mode.";

export function MassProductionPage() {
  return (
    <SdeGate title={TITLE} subtitle={SUBTITLE}>
      <Workbench />
    </SdeGate>
  );
}

function Workbench() {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<PlanMode>("owned");
  const [hypotheticalConfig, setHypotheticalConfig] =
    useState<HypotheticalConfig>(DEFAULT_HYPOTHETICAL_CONFIG);
  const [plan, setPlan] = useState<MassProductionPlan | null>(null);
  const [planError, setPlanError] = useState<string | null>(null);
  /** Per-blueprint "how many should be built" overrides, keyed by type id —
   *  absent means "use the mode's computed default". Mirrored into every
   *  `massprodPlan` call's `BlueprintLine.buildRuns` so a row's edit
   *  actually recomputes the materials below it. */
  const [overrides, setOverrides] = useState<Record<number, number>>({});
  /** One-shot "pending import to reconcile", set only by `importLines`
   *  right before `build.mutate` and consumed (then cleared) by the
   *  mutation's `onSuccess` — lets a pasted "Name\tRuns" line's explicit
   *  count land in `overrides` once the plan resolves it to a real type id,
   *  without clobbering overrides already set synchronously by a single-
   *  cell edit or a loaded build list (those leave this `null`). */
  const pendingOverridesByNameRef = useRef<Map<string, number> | null>(null);

  const build = useMutation({
    mutationFn: (lines: BlueprintLine[]) =>
      massprodPlan(lines, mode, hypotheticalConfig),
    onSuccess: (result) => {
      setPlan(result);
      setPlanError(null);
      const pending = pendingOverridesByNameRef.current;
      if (pending) {
        pendingOverridesByNameRef.current = null;
        const next: Record<number, number> = {};
        for (const b of result.matchedBlueprints) {
          const v = pending.get(b.name.trim().toLowerCase());
          if (v != null) next[b.typeId] = v;
        }
        setOverrides(next);
      }
    },
    onError: (e) => {
      setPlanError(
        isAuthRequired(e)
          ? "Log in a character first — Owned-copies mode needs your (or your corp's) owned blueprints."
          : errorMessage(e),
      );
    },
  });

  /** Paste import: each line is a blueprint name, optionally followed by a
   *  build-run count ("Rifter Blueprint" or "Rifter Blueprint\t5") — the
   *  same Multibuy-style format `exportBlueprintLines` writes, so an
   *  exported list re-imports with its counts intact. */
  function importLines() {
    const lines = parseBlueprintLines(text);
    if (lines.length === 0) return;
    const named = new Map<string, number>();
    for (const l of lines) {
      if (l.buildRuns != null)
        named.set(l.name.trim().toLowerCase(), l.buildRuns);
    }
    pendingOverridesByNameRef.current = named;
    build.mutate(lines);
  }

  /** A `BuildRunsCell` edit: set or clear one blueprint's override, then
   *  recompute the plan with every other matched/unresolved line carried
   *  forward unchanged (by resolved name, so the backend re-resolves the
   *  exact same type). Clearing an override lets the backend recompute
   *  that line's natural default instead of pinning it. */
  function commitBuildRuns(typeId: number, value: number | null) {
    if (plan == null) return;
    const nextOverrides = { ...overrides };
    if (value == null) delete nextOverrides[typeId];
    else nextOverrides[typeId] = value;
    setOverrides(nextOverrides);

    const lines: BlueprintLine[] = [
      ...plan.matchedBlueprints.map((b) => ({
        name: b.name,
        buildRuns: nextOverrides[b.typeId] ?? null,
      })),
      ...plan.unresolvedNames.map((name) => ({ name })),
    ];
    build.mutate(lines);
  }

  /** Drop one blueprint from the current plan (and its override, if any),
   *  then recompute with everything else carried forward unchanged — the
   *  "remove an item from the build list" counterpart to `commitBuildRuns`,
   *  so a loaded/edited list can be trimmed without going back to the raw
   *  paste text. */
  function removeBlueprint(typeId: number) {
    if (plan == null) return;
    const nextOverrides = { ...overrides };
    delete nextOverrides[typeId];
    setOverrides(nextOverrides);

    const lines: BlueprintLine[] = [
      ...plan.matchedBlueprints
        .filter((b) => b.typeId !== typeId)
        .map((b) => ({
          name: b.name,
          buildRuns: nextOverrides[b.typeId] ?? null,
        })),
      ...plan.unresolvedNames.map((name) => ({ name })),
    ];
    build.mutate(lines);
  }

  /** Load a saved build list: repopulate the paste box for visibility/edit,
   *  restore its saved per-line overrides, and recompute immediately. */
  function loadBuildList(list: BuildList) {
    setText(list.items.map((i) => i.name).join("\n"));
    const restored: Record<number, number> = {};
    for (const item of list.items) {
      if (item.buildRuns != null) restored[item.typeId] = item.buildRuns;
    }
    setOverrides(restored);
    build.mutate(
      list.items.map((i) => ({ name: i.name, buildRuns: i.buildRuns })),
    );
  }

  return (
    <Page>
      <PageHeader title={TITLE} subtitle={SUBTITLE} />
      <div className="flex h-full flex-col gap-4">
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <ModeToggle mode={mode} onChange={setMode} />
            <PasteImportControl
              label="Paste blueprint names"
              title='Paste blueprint names, one per line — optionally with a build-run count ("Rifter Blueprint" or "Rifter Blueprint\t5")'
              placeholder={
                'paste blueprint names — one per line\n(e.g. "5MN Microwarpdrive II Blueprint" or "Rifter Blueprint  5")'
              }
              value={text}
              setValue={setText}
              onImport={importLines}
              pending={build.isPending}
            />
            <BuildListsPanel
              plan={plan}
              overrides={overrides}
              onLoad={loadBuildList}
            />
            <CopyPlanButton plan={plan} />
          </div>
          <InlineError message={planError} className="text-xs text-rose-400" />
          {mode === "hypothetical" && (
            <HypotheticalSettingsRow
              config={hypotheticalConfig}
              onChange={setHypotheticalConfig}
            />
          )}
        </div>

        {plan == null ? (
          <div className="flex h-full items-center justify-center text-sm text-zinc-500">
            Paste a list of blueprint names to build a plan.
          </div>
        ) : (
          <PlanResult
            plan={plan}
            mode={mode}
            overrides={overrides}
            onCommitBuildRuns={commitBuildRuns}
            onRemoveBlueprint={removeBlueprint}
          />
        )}
      </div>
    </Page>
  );
}

/** Export the current blueprint list (resolved build-run counts included)
 * as a Multibuy-style "Name\tRuns" paste — share it with a teammate, or
 * paste it back into this same page later to reproduce the exact plan.
 * Disabled with nothing built yet to export. */
function CopyPlanButton({ plan }: { plan: MassProductionPlan | null }) {
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
/** Owned-copies vs. Hypothetical mode toggle (#893) — Owned matches every
 * pasted blueprint against real ESI-owned copies (#883's original
 * behavior); Hypothetical assumes a rule-derived (runs, ME) per line
 * instead, with zero ESI ownership calls. */
function ModeToggle({
  mode,
  onChange,
}: {
  mode: PlanMode;
  onChange: (m: PlanMode) => void;
}) {
  const options: { value: PlanMode; label: string }[] = [
    { value: "owned", label: "Owned copies" },
    { value: "hypothetical", label: "Hypothetical" },
  ];
  return (
    <div className="flex overflow-hidden rounded border border-zinc-700 text-xs">
      {options.map((o) => (
        <button
          key={o.value}
          onClick={() => onChange(o.value)}
          aria-pressed={mode === o.value}
          className={`px-3 py-1.5 font-medium transition-colors ${
            mode === o.value
              ? "bg-indigo-600 text-white"
              : "bg-transparent text-zinc-400 hover:bg-zinc-800"
          }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/** Settings row for Hypothetical mode's configurable knobs (#893): the T1
 * assumed run count, and both ME overrides. Hidden entirely in Owned mode,
 * where none of these apply. */
function HypotheticalSettingsRow({
  config,
  onChange,
}: {
  config: HypotheticalConfig;
  onChange: (c: HypotheticalConfig) => void;
}) {
  function set<K extends keyof HypotheticalConfig>(key: K, value: number) {
    onChange({ ...config, [key]: Math.max(0, Math.round(value)) });
  }

  return (
    <div className="flex flex-wrap items-end gap-4 rounded border border-zinc-800 bg-zinc-900/60 px-3 py-2">
      <Field
        label="T1 assumed runs"
        title="Default run count for a T1 (and special-edition) blueprint pasted with no per-row override"
      >
        <input
          type="number"
          min={1}
          step={1}
          value={config.t1Runs}
          onChange={(e) => set("t1Runs", Number(e.currentTarget.value))}
          className="w-20 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
        />
      </Field>
      <Field
        label="T1 assumed ME"
        title="Assumed material efficiency for T1 blueprints — default ME10, the max level researchable on a player-owned BPO"
      >
        <input
          type="number"
          min={0}
          max={10}
          step={1}
          value={config.t1Me}
          onChange={(e) => set("t1Me", Number(e.currentTarget.value))}
          className="w-20 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
        />
      </Field>
      <Field
        label="T2 assumed ME"
        title="Assumed material efficiency for T2 blueprints — default ME2, a freshly invented BPC with no decryptor"
      >
        <input
          type="number"
          min={0}
          max={10}
          step={1}
          value={config.t2Me}
          onChange={(e) => set("t2Me", Number(e.currentTarget.value))}
          className="w-20 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
        />
      </Field>
      <div className="text-xs text-zinc-500">
        T2 runs always come from each blueprint's own SDE run cap (
        <code>maxProductionLimit</code>) unless overridden per row below.
        Faction/Officer/Deadspace items always assume ME0, flagged below.
      </div>
    </div>
  );
}

/** "Build lists ▾" — save the current matched blueprints (with their build-
 * run overrides) under a name, or load/delete a previously saved one.
 * Separate from Shopping Lists: a build list is the *input* (blueprints +
 * how many to build), not the computed materials. */
function BuildListsPanel({
  plan,
  overrides,
  onLoad,
}: {
  plan: MassProductionPlan | null;
  overrides: Record<number, number>;
  onLoad: (list: BuildList) => void;
}) {
  const qc = useQueryClient();
  const [browseOpen, setBrowseOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState("");
  const [saveError, setSaveError] = useState<string | null>(null);
  const { copied: copiedList, copy: copyList } = useCopyToClipboard(1500);

  const listsQuery = useQuery({
    queryKey: massprodKeys.lists,
    queryFn: massprodLists,
    enabled: browseOpen,
  });

  const save = useMutation({
    mutationFn: (listName: string) =>
      massprodSaveList(
        listName,
        (plan?.matchedBlueprints ?? []).map((b) => ({
          typeId: b.typeId,
          buildRuns: overrides[b.typeId] ?? null,
        })),
      ),
    onSuccess: () => {
      setSaveOpen(false);
      setName("");
      setSaveError(null);
      void qc.invalidateQueries({ queryKey: massprodKeys.lists });
    },
    onError: (e) => setSaveError(errorMessage(e)),
  });

  const remove = useMutation({
    mutationFn: (id: string) => massprodDeleteList(id),
    onSuccess: () =>
      void qc.invalidateQueries({ queryKey: massprodKeys.lists }),
  });

  const canSave = plan != null && plan.matchedBlueprints.length > 0;

  return (
    <div className="flex items-center gap-2">
      <div className="relative">
        <button
          onClick={() => {
            setBrowseOpen((o) => !o);
            setSaveOpen(false);
          }}
          className="flex items-center gap-1.5 rounded border border-zinc-700 px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
        >
          <FolderOpen size={13} />
          Build lists
        </button>
        {browseOpen && (
          <>
            <div
              className="fixed inset-0 z-10"
              onClick={() => setBrowseOpen(false)}
            />
            <div className="absolute left-0 z-20 mt-1 w-72 rounded border border-zinc-700 bg-zinc-900 p-2 shadow-lg">
              {listsQuery.isLoading && (
                <div className="px-2 py-1 text-xs text-zinc-500">Loading…</div>
              )}
              {listsQuery.data?.length === 0 && (
                <div className="px-2 py-1 text-xs text-zinc-500">
                  No saved build lists yet.
                </div>
              )}
              {listsQuery.data?.map((list) => (
                <div
                  key={list.id}
                  className="flex items-center justify-between gap-2 rounded px-2 py-1 hover:bg-zinc-800"
                >
                  <button
                    onClick={() => {
                      onLoad(list);
                      setBrowseOpen(false);
                    }}
                    className="flex-1 truncate text-left text-xs text-zinc-200"
                    title={`Load "${list.name}" (${list.items.length} blueprints)`}
                  >
                    {list.name}
                    <span className="ml-1.5 text-zinc-500">
                      ({list.items.length})
                    </span>
                  </button>
                  <button
                    onClick={() =>
                      copyList(
                        exportBlueprintLines(
                          list.items.map((i) => ({
                            name: i.name,
                            runs: i.buildRuns,
                          })),
                        ),
                        list.id,
                      )
                    }
                    aria-label={`Copy ${list.name}`}
                    title="Copy this list as a Multibuy-style paste (Name, or Name␉Runs if it has a saved build-run)"
                    className="shrink-0 text-zinc-500 hover:text-indigo-400"
                  >
                    {copiedList === list.id ? (
                      <Check size={13} />
                    ) : (
                      <ClipboardCopy size={13} />
                    )}
                  </button>
                  <button
                    onClick={() => remove.mutate(list.id)}
                    aria-label={`Delete ${list.name}`}
                    title="Delete this build list"
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
            onClick={() => {
              setSaveOpen((o) => !o);
              setBrowseOpen(false);
            }}
            className="flex items-center gap-1.5 rounded border border-zinc-700 px-2 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            <Save size={13} />
            {save.isSuccess && !saveOpen ? "Saved ✓" : "Save build list…"}
          </button>
          {saveOpen && (
            <>
              <div
                className="fixed inset-0 z-10"
                onClick={() => setSaveOpen(false)}
              />
              <div className="absolute left-0 z-20 mt-1 w-64 rounded border border-zinc-700 bg-zinc-900 p-2 shadow-lg">
                <input
                  value={name}
                  onChange={(e) => setName(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && name.trim())
                      save.mutate(name.trim());
                  }}
                  placeholder={`Build list — ${new Date().toLocaleDateString()}`}
                  autoFocus
                  className="w-full rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-100 outline-none placeholder:text-zinc-500"
                />
                <div className="mt-2 flex justify-end gap-2">
                  <button
                    onClick={() => setSaveOpen(false)}
                    className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
                  >
                    Cancel
                  </button>
                  <button
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

/** Priority order a tier group renders in — standard tech levels first
 *  (matching how players think about a mixed doctrine paste), then
 *  everything else (Faction/Officer/Deadspace) alphabetically. */
const TIER_PRIORITY: Record<string, number> = { "Tech I": 0, "Tech II": 1 };

/** Buckets matched blueprints by their SDE meta-group tier (e.g. "all T1
 *  base items into one group") — mirrors the materials-side grouping below,
 *  applied to the input blueprint list instead of the output materials. */
function groupByTier(
  blueprints: MatchedBlueprint[],
): { tier: string; items: MatchedBlueprint[] }[] {
  const byTier = new Map<string, MatchedBlueprint[]>();
  for (const b of blueprints) {
    const existing = byTier.get(b.tier);
    if (existing) existing.push(b);
    else byTier.set(b.tier, [b]);
  }
  return [...byTier.entries()]
    .map(([tier, items]) => ({ tier, items }))
    .sort((a, b) => {
      const pa = TIER_PRIORITY[a.tier] ?? 2;
      const pb = TIER_PRIORITY[b.tier] ?? 2;
      return pa !== pb ? pa - pb : a.tier.localeCompare(b.tier);
    });
}

function PlanResult({
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

function GroupSection({
  group,
  locations,
  locationsFetching,
  onRequestLocations,
}: {
  group: MaterialGroup;
  locations: AssetLocation[];
  locationsFetching: boolean;
  onRequestLocations: () => void;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [locationId, setLocationId] = useState<number | "">("");
  const { copied, copy } = useCopyToClipboard(1500);

  // Stock at the picked location, fetched on demand and cached per location
  // (no pricing involved — see `assets_stock_at_location`). Until it arrives
  // the table keeps showing the full quantity rather than a misleading
  // "have 0".
  const stockQuery = useQuery({
    ...assetsKeys.stockAt(locationId === "" ? 0 : locationId),
    enabled: locationId !== "",
  });
  const stockByType = useMemo(
    () => new Map((stockQuery.data ?? []).map((s) => [s.typeId, s.quantity])),
    [stockQuery.data],
  );
  const netted = locationId !== "" && stockQuery.data != null;

  // Blank location (default): the full needed quantity, unchanged. A picked
  // location subtracts what the roster already has stocked there, so the
  // Multibuy/save actions below only reflect what's still actually needed.
  // `required`/`owned` stay on each row so the table can show the full
  // accounting — a fully covered material reads "have ≥ need", not as a
  // silently vanished row.
  const items = group.items.map((it) => {
    if (!netted) return { ...it, required: it.quantity, owned: 0 };
    const owned = stockByType.get(it.typeId) ?? 0;
    return {
      ...it,
      required: it.quantity,
      owned,
      quantity: Math.max(0, it.quantity - owned),
    };
  });
  const stillNeeded = items.filter((it) => it.quantity > 0);
  const multibuy = stillNeeded
    .map((i) => `${i.name}\t${i.quantity}`)
    .join("\n");

  return (
    <div className="rounded border border-zinc-800">
      <div className="flex items-center justify-between gap-3 border-b border-zinc-800 bg-zinc-900 px-3 py-2">
        <button
          onClick={() => setCollapsed((c) => !c)}
          className="flex items-center gap-2 text-left text-sm font-medium text-zinc-200"
        >
          <span className="text-zinc-500">{collapsed ? "▸" : "▾"}</span>
          {group.categoryName}
          <span className="text-xs font-normal text-zinc-500">
            ({group.items.length} item{group.items.length === 1 ? "" : "s"})
          </span>
        </button>
        <div className="flex items-center gap-2">
          <select
            value={locationId}
            onChange={(e) =>
              setLocationId(
                e.currentTarget.value ? Number(e.currentTarget.value) : "",
              )
            }
            onFocus={onRequestLocations}
            title="Subtract what the roster already has stocked at a location"
            className="rounded border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs text-zinc-300 outline-none"
          >
            <option value="">
              {locationsFetching && locations.length === 0
                ? "Loading locations…"
                : "All locations — full quantity"}
            </option>
            {locations.map((loc) => (
              <option key={loc.id} value={loc.id}>
                {loc.name}
              </option>
            ))}
          </select>
          {(locationsFetching || stockQuery.isFetching) && (
            <Loader2
              size={13}
              className="animate-spin text-zinc-500"
              aria-label="Loading stock…"
            />
          )}
          <button
            onClick={() => copy(multibuy)}
            disabled={stockQuery.isFetching}
            title="Copy this group as a Multibuy-pasteable item list"
            className="flex items-center gap-1.5 rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          >
            <ClipboardCopy size={13} />
            {copied ? "Copied ✓" : "Copy Multibuy"}
          </button>
          <SaveAsListButton
            group={{ categoryName: group.categoryName, items: stillNeeded }}
          />
        </div>
      </div>
      {stockQuery.isError && (
        <div className="px-3 py-1.5">
          <InlineError message={errorMessage(stockQuery.error)} />
        </div>
      )}
      {!collapsed && (
        <table className="w-full border-collapse text-sm">
          <thead className="text-zinc-500">
            <tr>
              <th className="px-3 py-1 text-left font-normal">Item</th>
              {!netted ? (
                <th className="px-3 py-1 text-right font-normal">Quantity</th>
              ) : (
                <>
                  <th className="px-3 py-1 text-right font-normal">Need</th>
                  <th className="px-3 py-1 text-right font-normal">Have</th>
                  <th className="px-3 py-1 text-right font-normal">To buy</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {items.map((it) => (
              <tr key={it.typeId} className="border-t border-zinc-800/60">
                <td className="px-3 py-1 text-zinc-200">{it.name}</td>
                {netted && (
                  <>
                    <td className="px-3 py-1 text-right text-zinc-300">
                      {formatInt(it.required)}
                    </td>
                    <td className="px-3 py-1 text-right text-zinc-300">
                      {formatInt(it.owned)}
                    </td>
                  </>
                )}
                <td
                  className={`px-3 py-1 text-right ${
                    it.quantity === 0 && netted
                      ? "text-zinc-600"
                      : "text-zinc-300"
                  }`}
                >
                  {formatInt(it.quantity)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** "Save as new shopping list…" — a name popover that creates the list, bulk
 * adds every item in the group, and invalidates the Shopping Lists query so
 * the new list shows up immediately there. */
function SaveAsListButton({ group }: { group: MaterialGroup }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = useMutation({
    mutationFn: async (listName: string) => {
      const list = await shoppingCreateList(listName);
      for (const it of group.items) {
        await shoppingAddItem(list.id, it.typeId, it.quantity);
      }
      return list;
    },
    onSuccess: () => {
      setError(null);
      setOpen(false);
      setName("");
      setSaved(true);
      window.setTimeout(() => setSaved(false), 1500);
      void qc.invalidateQueries({ queryKey: SHOPPING_LISTS_KEY });
    },
    onError: (e) => setError(errorMessage(e)),
  });

  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
      >
        {saved ? "Saved ✓" : "Save as new shopping list…"}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-1 w-64 rounded border border-zinc-700 bg-zinc-900 p-2 shadow-lg">
            <input
              value={name}
              onChange={(e) => setName(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && name.trim()) save.mutate(name.trim());
              }}
              placeholder={`${group.categoryName} — ${new Date().toLocaleDateString()}`}
              autoFocus
              className="w-full rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-100 outline-none placeholder:text-zinc-500"
            />
            <div className="mt-2 flex justify-end gap-2">
              <button
                onClick={() => setOpen(false)}
                className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                onClick={() => name.trim() && save.mutate(name.trim())}
                disabled={name.trim().length === 0 || save.isPending}
                className="rounded bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {save.isPending ? "Saving…" : "Save"}
              </button>
            </div>
            <InlineError
              message={error}
              className="mt-1 text-xs text-rose-400"
            />
          </div>
        </>
      )}
    </div>
  );
}
