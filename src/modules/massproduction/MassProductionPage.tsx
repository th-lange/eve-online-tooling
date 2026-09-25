import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ClipboardCopy } from "lucide-react";

import {
  errorMessage,
  isAuthRequired,
  massprodPlan,
  shoppingAddItem,
  shoppingCreateList,
  DEFAULT_HYPOTHETICAL_CONFIG,
  type HypotheticalConfig,
  type MassProductionPlan,
  type MaterialGroup,
  type PlanMode,
} from "../../lib/api";
import { SHOPPING_LISTS_KEY } from "../../lib/queryKeys";
import { formatInt } from "../../lib/format";
import { useCopyToClipboard } from "../../lib/useCopyToClipboard";
import { Page, PageHeader } from "../../components/page";
import { InlineError } from "../../components/InlineError";
import { Field } from "../../components/forms";
import { PasteImportControl } from "../../components/PasteImportControl";
import { SdeGate } from "../../components/SdeGate";

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

  const build = useMutation({
    mutationFn: (blueprintNames: string[]) =>
      massprodPlan(blueprintNames, mode, hypotheticalConfig),
    onSuccess: (result) => {
      setPlan(result);
      setPlanError(null);
    },
    onError: (e) => {
      setPlanError(
        isAuthRequired(e)
          ? "Log in a character first — Owned-copies mode needs your (or your corp's) owned blueprints."
          : errorMessage(e),
      );
    },
  });

  function importNames() {
    const names = text
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    if (names.length === 0) return;
    build.mutate(names);
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
              title="Paste blueprint names, one per line (e.g. from an in-game asset export)"
              placeholder={
                'paste blueprint names — one per line\n(e.g. "5MN Microwarpdrive II Blueprint")'
              }
              value={text}
              setValue={setText}
              onImport={importNames}
              pending={build.isPending}
            />
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
          <PlanResult plan={plan} mode={mode} />
        )}
      </div>
    </Page>
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
        title="Assumed run count for every T1 (and special-edition) blueprint pasted"
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
        <code>maxProductionLimit</code>) — not configurable. Faction/Officer/
        Deadspace items always assume ME0, flagged below.
      </div>
    </div>
  );
}

function PlanResult({
  plan,
  mode,
}: {
  plan: MassProductionPlan;
  mode: PlanMode;
}) {
  const runsHeader = mode === "hypothetical" ? "Assumed runs" : "Total runs";
  const copiesHeader = mode === "hypothetical" ? "Assumed ME" : "Owned copies";

  return (
    <div className="flex flex-col gap-4">
      {plan.unresolvedNames.length > 0 && (
        <div className="rounded border border-amber-800 bg-amber-950/40 px-3 py-2 text-sm text-amber-300">
          Didn't match any blueprint name — check spelling:{" "}
          {plan.unresolvedNames.join(", ")}
        </div>
      )}

      <div className="overflow-auto rounded border border-zinc-800">
        <table className="w-full border-collapse text-sm">
          <thead className="bg-zinc-900 text-zinc-400">
            <tr>
              <th className="px-3 py-1.5 text-left">Blueprint</th>
              <th className="px-3 py-1.5 text-right">{copiesHeader}</th>
              <th className="px-3 py-1.5 text-right">{runsHeader}</th>
            </tr>
          </thead>
          <tbody>
            {plan.matchedBlueprints.map((b) => (
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
                  {formatInt(b.totalRuns)}
                </td>
              </tr>
            ))}
            {plan.matchedBlueprints.length === 0 && (
              <tr>
                <td colSpan={3} className="px-3 py-3 text-center text-zinc-500">
                  No blueprint names resolved.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {plan.groups.length === 0 ? (
        <div className="text-sm text-zinc-500">
          {mode === "hypothetical"
            ? "No resolved blueprints — nothing to buy."
            : "No owned copies of the pasted blueprints — nothing to buy."}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {plan.groups.map((g) => (
            <GroupSection key={g.groupName} group={g} />
          ))}
        </div>
      )}
    </div>
  );
}

function GroupSection({ group }: { group: MaterialGroup }) {
  const [collapsed, setCollapsed] = useState(false);
  const { copied, copy } = useCopyToClipboard(1500);
  const multibuy = group.items
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
          {group.groupName}
          <span className="text-xs font-normal text-zinc-500">
            ({group.categoryName} · {group.items.length} items)
          </span>
        </button>
        <div className="flex items-center gap-2">
          <button
            onClick={() => copy(multibuy)}
            title="Copy this group as a Multibuy-pasteable item list"
            className="flex items-center gap-1.5 rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            <ClipboardCopy size={13} />
            {copied ? "Copied ✓" : "Copy Multibuy"}
          </button>
          <SaveAsListButton group={group} />
        </div>
      </div>
      {!collapsed && (
        <table className="w-full border-collapse text-sm">
          <thead className="text-zinc-500">
            <tr>
              <th className="px-3 py-1 text-left font-normal">Item</th>
              <th className="px-3 py-1 text-right font-normal">Quantity</th>
            </tr>
          </thead>
          <tbody>
            {group.items.map((it) => (
              <tr key={it.typeId} className="border-t border-zinc-800/60">
                <td className="px-3 py-1 text-zinc-200">{it.name}</td>
                <td className="px-3 py-1 text-right text-zinc-300">
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
              placeholder={`${group.groupName} — ${new Date().toLocaleDateString()}`}
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
