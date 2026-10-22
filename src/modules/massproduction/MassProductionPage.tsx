import { useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";

import {
  errorMessage,
  isAuthRequired,
  massprodPlan,
  DEFAULT_HYPOTHETICAL_CONFIG,
  type BlueprintLine,
  type BuildList,
  type HypotheticalConfig,
  type MassProductionPlan,
  type PlanMode,
} from "../../lib/api";
import { Page, PageHeader } from "../../components/page";
import { InlineError } from "../../components/InlineError";
import { PasteImportControl } from "../../components/PasteImportControl";
import { SdeGate } from "../../components/SdeGate";
import { parseBlueprintLines } from "./parseBlueprintLines";
import { CopyPlanButton } from "./CopyPlanButton";
import { ModeToggle } from "./ModeToggle";
import { HypotheticalSettingsRow } from "./HypotheticalSettingsRow";
import { BuildListsPanel } from "./BuildListsPanel";
import { PlanResult } from "./PlanResult";

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
