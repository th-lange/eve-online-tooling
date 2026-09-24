import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BarChart2, ClipboardPaste, SlidersHorizontal, X } from "lucide-react";
import {
  errorMessage,
  fittingDeleteLocal,
  fittingEsiPush,
  fittingOptimize,
  fittingPrice,
  fittingAmmoTable,
  fittingLoadAmmo,
  sdeSearchShips,
  type AmmoRow,
  type OptimizeMode,
  type OptimizeObjective,
  type SlotKind,
} from "../../lib/api";
import { marketKeys } from "../../lib/queryKeys";
import { Page, PageHeader, PrimaryButton } from "../../components/page";
import { InlineError } from "../../components/InlineError";
import { Combo } from "../../components/Combo";
import { SdeGate } from "../../components/SdeGate";
import { Modal } from "../../components/Modal";
import {
  Centered,
  ComparisonPanel,
  EnvironmentEffectSelector,
  EsiFitStatus,
  FitHeader,
  ModuleBrowser,
  ProjectedPanel,
  SlotGrid,
  TargetProfileBox,
} from "./components";
import { StatsAside } from "./StatsAside";
import { useFitEditor } from "./useFitEditor";
import { useFitLibrary } from "./useFitLibrary";

const FORGE = 10000002;

const TITLE = "Fitting";
const SUBTITLE =
  "Build a fit, validate slots and resources, price it, and optimize. Import/export EFT or load your in-game fittings.";

/** Meta-group tiers the optimizer can draw from. */
const META_TIERS: [number, string][] = [
  [1, "T1"],
  [2, "T2"],
  [4, "Faction"],
  [6, "Deadspace"],
  [5, "Officer"],
];

/** Gate the editor on the SDE being installed (like the other SDE-backed pages). */
export function FittingPage() {
  return (
    <SdeGate title={TITLE} subtitle={SUBTITLE}>
      <Workbench />
    </SdeGate>
  );
}

function Workbench() {
  const qc = useQueryClient();
  const editor = useFitEditor();
  const library = useFitLibrary();
  // When set (from clicking a free slot), the add-module browser filters to it.
  const [slotFilter, setSlotFilter] = useState<SlotKind | null>(null);
  const [comparing, setComparing] = useState(false);
  const [regionId, setRegionId] = useState(FORGE);
  const [objective, setObjective] = useState<OptimizeObjective>("tank");
  const [optimizeMode, setOptimizeMode] = useState<OptimizeMode>("all");
  const [capStable, setCapStable] = useState(false);
  // ISK budget cap as a string (millions); empty = no budget.
  const [maxCostM, setMaxCostM] = useState("");
  const [unmetConstraints, setUnmetConstraints] = useState<string[] | null>(
    null,
  );
  // `setFit` always runs the fit through `stackCargo`, which returns a new
  // object even for a no-op normalization — so we can't tell "optimize just
  // applied this fit" apart from "the user edited it" by reference alone.
  // Instead: mark the next fit-change as optimizer-caused, consume that mark
  // in the effect below, and only treat *further* changes as manual edits.
  const pendingOptimizeApplyRef = useRef(false);
  const lastOptimizedFitRef = useRef<typeof editor.fit>(null);
  const [meta, setMeta] = useState<Record<number, boolean>>({
    1: true,
    2: true,
    4: false,
    6: false,
    5: false,
  });

  const regions = useQuery(marketKeys.regions());

  const price = useMutation({
    mutationFn: () => fittingPrice(editor.fit!, regionId, null),
  });
  const del = useMutation({
    mutationFn: (id: string) => fittingDeleteLocal(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["fitting", "saved"] }),
  });
  // Save the current fit to the active character's in-game fittings via ESI.
  const pushEsi = useMutation({
    mutationFn: () => fittingEsiPush(editor.fit!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["fitting", "esi"] }),
    onError: (e) => console.error("Couldn't save to EVE", e),
  });
  const optimize = useMutation({
    mutationFn: () => {
      const maxCost = maxCostM.trim() ? Number(maxCostM) * 1_000_000 : null;
      return fittingOptimize(
        editor.fit!,
        objective,
        Object.entries(meta)
          .filter(([, on]) => on)
          .map(([id]) => Number(id)),
        optimizeMode,
        { capStable, maxCost, regionId },
      );
    },
    onSuccess: (res) => {
      pendingOptimizeApplyRef.current = true;
      editor.setFit(res.fit);
      const unmet: string[] = [];
      if (capStable && !res.capStable) unmet.push("cap-stable");
      if (maxCostM.trim() && !res.withinBudget) unmet.push("ISK budget");
      setUnmetConstraints(unmet.length ? unmet : null);
    },
    onError: (e) => console.error("Optimize failed", e),
  });
  // Clear the unmet-constraint banner the moment the fit changes to
  // something other than what the optimizer just produced — i.e. the user
  // edited it manually (any of the setFit-backed actions in useFitEditor).
  useEffect(() => {
    if (pendingOptimizeApplyRef.current) {
      // This change is the optimizer's own setFit call landing (post
      // stackCargo) — keep the banner and remember this fit as the one it
      // describes.
      pendingOptimizeApplyRef.current = false;
      lastOptimizedFitRef.current = editor.fit;
      return;
    }
    if (editor.fit !== lastOptimizedFitRef.current) {
      setUnmetConstraints(null);
    }
  }, [editor.fit]);
  // Combines the mutation's own error with the deep-link import path's
  // (useFitEditor's effect-driven import doesn't go through this mutation).
  const eftImportError =
    editor.importError ??
    (editor.importEft.isError
      ? `Import failed: ${errorMessage(editor.importEft.error)}`
      : null);
  const listImportError = editor.importList.isError
    ? `Import failed: ${errorMessage(editor.importList.error)}`
    : null;

  const { fit, nameOf, layout, stats, rangeOf, activatable, fitContext } =
    editor;
  const resolvedLayout = stats.data?.layout ?? layout.data;

  // DPS/range/tracking for each cargo ammo the fit's turrets can load, keyed by
  // type id — surfaced as a hover popover on the cargo rows (see SlotGrid).
  const ammoTable = useQuery({
    queryKey: ["fitting", "ammoTable", fit, editor.skillSource],
    queryFn: () => fittingAmmoTable(fit!, editor.skillSource),
    enabled: fit != null,
  });
  const ammoStats: Record<number, AmmoRow> = useMemo(
    () => Object.fromEntries((ammoTable.data ?? []).map((r) => [r.typeId, r])),
    [ammoTable.data],
  );
  const loadAmmo = useMutation({
    mutationFn: (typeId: number) => fittingLoadAmmo(fit!, typeId),
    onSuccess: (f) => editor.setFit(f),
    onError: (e) => console.error("Couldn't load ammo", e),
  });

  return (
    <Page>
      <PageHeader title={TITLE} subtitle={SUBTITLE} />
      <div className="flex h-full flex-col gap-4">
        {/* Controls: Ship · Skills · Price · Import EFT · (right) Fits */}
        <div className="flex flex-wrap items-end gap-3">
          <Combo
            value={
              fit ? { id: fit.shipTypeId, name: nameOf(fit.shipTypeId) } : null
            }
            onPick={(v) =>
              v ? editor.pickShip(v.id, v.name) : editor.setFit(null)
            }
            search={sdeSearchShips}
            label="Ship (hull)"
            placeholder="search a hull…"
            width="w-56"
          />
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Skills
            <select
              value={editor.skillSource}
              onChange={(e) =>
                editor.setSkillSource(
                  e.currentTarget.value as typeof editor.skillSource,
                )
              }
              className="rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
            >
              <option value="allFive">All V</option>
              <option value="character">Character</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Price at
            <select
              value={regionId}
              onChange={(e) => setRegionId(Number(e.currentTarget.value))}
              className="rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
            >
              {regions.data?.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <div className="flex items-start gap-2 pb-0.5">
            <div>
              <PasteImportControl
                label="Import EFT"
                title="Paste an EFT fit to import"
                placeholder="paste an EFT fit here…"
                value={editor.eft}
                setValue={editor.setEft}
                onImport={() => editor.importEft.mutate()}
                pending={editor.importEft.isPending}
                mono
              />
              <InlineError
                message={eftImportError}
                className="mt-1 text-xs text-rose-400"
              />
            </div>
            <div>
              <PasteImportControl
                label="Paste list"
                title="Paste a loose item list (contract, multibuy, cargo/asset paste) to build a fit"
                placeholder={
                  "paste an item list — one item per line\n(contract, multibuy, cargo scan…)"
                }
                value={editor.listText}
                setValue={editor.setListText}
                onImport={() => editor.importList.mutate()}
                pending={editor.importList.isPending}
              />
              <InlineError
                message={listImportError}
                className="mt-1 text-xs text-rose-400"
              />
            </div>
          </div>

          {/* Fits picker — independent of the hull, grouped by ship group → hull → name */}
          <div className="ml-auto flex items-end gap-2">
            <label className="flex flex-col gap-1 text-xs text-zinc-400">
              Fits ({library.allFits.length} saved + in-game)
              <select
                value=""
                onChange={(e) => {
                  const f = library.fitByKey.get(e.currentTarget.value);
                  if (f) editor.setFit(f);
                }}
                className="w-72 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
              >
                <option value="">load a fit…</option>
                {library.fitGroups.map((g) => (
                  <optgroup key={g.group} label={g.group}>
                    {g.fits.map((f) => (
                      <option key={f.key} value={f.key}>
                        {f.hull} — {f.name}
                        {f.source === "in-game" ? "  (EVE)" : ""}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <EsiFitStatus
                esi={library.esiFits}
                refresh={library.refreshEsi}
              />
            </label>
            <button
              onClick={() => library.refreshEsi.mutate()}
              disabled={library.refreshEsi.isPending}
              title="Refresh in-game fittings from EVE (bypasses the cache)"
              className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
            >
              {library.refreshEsi.isPending ? "…" : "Refresh"}
            </button>
          </div>
        </div>

        {fit != null && (
          <div className="flex items-center justify-end">
            <button
              onClick={() => setComparing((v) => !v)}
              className="flex items-center gap-1.5 rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
            >
              <BarChart2 className="h-3.5 w-3.5" />
              {comparing ? "Hide comparison" : "Compare"}
            </button>
          </div>
        )}

        {comparing && (
          <ComparisonPanel
            currentFit={fit}
            nameOf={nameOf}
            onClose={() => setComparing(false)}
          />
        )}

        {fit == null ? (
          <Centered>
            Pick a hull, load a saved/in-game fit, or import an EFT fit to
            begin.
          </Centered>
        ) : (
          <div className="flex min-h-0 flex-1 gap-4">
            {/* Left: editor */}
            <section className="min-w-0 flex-1 overflow-auto">
              <FitHeader
                shipTypeId={fit.shipTypeId}
                hullName={layout.data?.name ?? nameOf(fit.shipTypeId)}
                groupName={layout.data?.groupName ?? ""}
                fitName={fit.name}
                onSave={() => editor.save.mutate()}
                savePending={editor.save.isPending}
                onExportEft={() => editor.exportEft.mutate()}
                onPushEsi={() => pushEsi.mutate()}
                pushEsiPending={pushEsi.isPending}
                pushEsiSuccess={pushEsi.isSuccess}
                onDelete={() => {
                  del.mutate(fit.id);
                  editor.setFit(null);
                }}
                canDelete={
                  library.saved.data?.some((s) => s.id === fit.id) ?? false
                }
              />
              <InlineError
                message={
                  pushEsi.isError
                    ? `Couldn't save to EVE: ${errorMessage(pushEsi.error)}`
                    : null
                }
              />

              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-xs uppercase tracking-wide text-zinc-500">
                  Fitting
                </h3>
                <OptimizeControl
                  objective={objective}
                  setObjective={setObjective}
                  optimizeMode={optimizeMode}
                  setOptimizeMode={setOptimizeMode}
                  meta={meta}
                  setMeta={setMeta}
                  capStable={capStable}
                  setCapStable={setCapStable}
                  maxCostM={maxCostM}
                  setMaxCostM={setMaxCostM}
                  onOptimize={() => optimize.mutate()}
                  pending={optimize.isPending}
                />
              </div>
              <InlineError
                message={
                  optimize.isError
                    ? `Optimize failed: ${errorMessage(optimize.error)}`
                    : null
                }
              />
              {unmetConstraints && (
                <div className="mb-2 flex items-center justify-between gap-2 rounded border border-amber-700/50 bg-amber-950/20 px-2 py-1">
                  <InlineError
                    message={`Optimizer couldn't meet ${unmetConstraints.join(" + ")} — showing the closest fit.`}
                    className="text-xs text-amber-400"
                  />
                  <button
                    onClick={() => setUnmetConstraints(null)}
                    title="Dismiss"
                    className="shrink-0 text-zinc-500 hover:text-zinc-300"
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
              )}

              {/* Prefer the resolved layout (T3 subsystems grant slots). */}
              {resolvedLayout && (
                <SlotGrid
                  fit={fit}
                  layout={resolvedLayout}
                  nameOf={nameOf}
                  onRemove={editor.removeItem}
                  onAddToSlot={setSlotFilter}
                  onSetCharge={editor.setCharge}
                  onSetChargeForType={editor.setChargeForType}
                  onSetState={editor.setModuleState}
                  onSetQuantity={editor.setQuantity}
                  onSetActiveDrones={editor.setActiveDrones}
                  droneActive={stats.data?.droneActive}
                  droneMaxActive={stats.data?.droneMaxActive}
                  rangeOf={rangeOf}
                  activatable={activatable}
                  ammoStats={ammoStats}
                  onFitAmmo={(typeId) => loadAmmo.mutate(typeId)}
                />
              )}
              <InlineError
                message={
                  loadAmmo.isError
                    ? `Couldn't load ammo: ${errorMessage(loadAmmo.error)}`
                    : null
                }
              />

              <ModuleBrowser
                onAdd={(typeId) => editor.addItem.mutate(typeId)}
                pending={editor.addItem.isPending}
                slotFilter={slotFilter}
                onSlotFilter={setSlotFilter}
                fitContext={fitContext}
                shipTypeId={fit.shipTypeId}
                skillSource={editor.skillSource}
              />
              <InlineError
                message={
                  editor.addItem.isError
                    ? `Couldn't add module: ${errorMessage(editor.addItem.error)}`
                    : null
                }
              />

              <ProjectedPanel
                projected={fit.projected ?? []}
                nameOf={nameOf}
                onAdd={editor.addProjected}
                onRemove={editor.removeProjected}
              />
              <EnvironmentEffectSelector
                value={editor.environmentEffect}
                onChange={editor.setEnvironmentEffect}
                abyssalWeather={editor.abyssalWeather}
                onAbyssalWeather={editor.setAbyssalWeather}
              />
              <TargetProfileBox
                value={editor.targetProfile}
                onChange={editor.setTargetProfile}
              />
            </section>

            {/* Right: stats */}
            <StatsAside
              stats={stats}
              skillLabel={editor.skillLabel}
              jammed={editor.jammed}
              onJam={editor.setJammed}
              jammedActive={editor.jammedActive}
              price={price}
              damageProfile={editor.damageProfile}
              onDamageProfile={editor.setDamageProfile}
              neutGjs={editor.neutGjs}
              onNeutGjs={editor.setNeutGjs}
              fleetBoosts={editor.fleetBoosts}
              onAddFleetBoost={editor.addFleetBoost}
              onRemoveFleetBoost={editor.removeFleetBoost}
              nameOf={nameOf}
            />
          </div>
        )}
      </div>
    </Page>
  );
}

/**
 * Collapsible paste-to-import control (#710): a button that opens a small
 * textarea popover. Used for both EFT fits and loose item lists — the parse
 * happens in the caller's `onImport`. Closes on Import; errors surface via the
 * caller's InlineError.
 */
function PasteImportControl({
  label,
  title,
  placeholder,
  value,
  setValue,
  onImport,
  pending,
  mono = false,
}: {
  label: string;
  title: string;
  placeholder: string;
  value: string;
  setValue: (v: string) => void;
  onImport: () => void;
  pending: boolean;
  mono?: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        title={title}
        className={`flex items-center gap-1.5 rounded border px-2 py-1 text-xs ${
          open
            ? "border-zinc-600 bg-zinc-800 text-zinc-200"
            : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"
        }`}
      >
        <ClipboardPaste size={13} />
        {label}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute left-0 z-20 mt-1 w-96 rounded border border-zinc-700 bg-zinc-900 p-2 shadow-lg">
            <textarea
              value={value}
              onChange={(e) => setValue(e.currentTarget.value)}
              placeholder={placeholder}
              autoFocus
              className={`h-32 w-full rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-100 outline-none placeholder:text-zinc-500 ${
                mono ? "font-mono" : ""
              }`}
            />
            <div className="mt-2 flex justify-end gap-2">
              <button
                onClick={() => setOpen(false)}
                className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-400 hover:bg-zinc-800"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  onImport();
                  setOpen(false);
                }}
                disabled={value.trim().length === 0 || pending}
                className="rounded bg-indigo-600 px-3 py-1 text-xs font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
              >
                {pending ? "Importing…" : "Import"}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Optimizer controls (#710): collapsed behind an "Optimize…" button instead
 * of a permanently-visible dense strip. Running it applies immediately to the
 * loaded fit (visible in the slot grid behind the popover); any unmet
 * constraint is surfaced separately as a persistent banner (#825), not here.
 */
function OptimizeControl({
  objective,
  setObjective,
  optimizeMode,
  setOptimizeMode,
  meta,
  setMeta,
  capStable,
  setCapStable,
  maxCostM,
  setMaxCostM,
  onOptimize,
  pending,
}: {
  objective: OptimizeObjective;
  setObjective: (v: OptimizeObjective) => void;
  optimizeMode: OptimizeMode;
  setOptimizeMode: (v: OptimizeMode) => void;
  meta: Record<number, boolean>;
  setMeta: (
    fn: (m: Record<number, boolean>) => Record<number, boolean>,
  ) => void;
  capStable: boolean;
  setCapStable: (v: boolean) => void;
  maxCostM: string;
  setMaxCostM: (v: string) => void;
  onOptimize: () => void;
  pending: boolean;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1.5 rounded border px-2 py-1 text-xs ${
          open
            ? "border-zinc-600 bg-zinc-800 text-zinc-200"
            : "border-zinc-700 text-zinc-300 hover:bg-zinc-800"
        }`}
      >
        <SlidersHorizontal size={13} />
        Optimize…
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        aria-label="Fitting optimizer settings"
        backdropClassName="fixed inset-0 z-10"
        portal={false}
        className="absolute right-0 z-20 mt-1 w-80 space-y-2 rounded border border-zinc-700 bg-zinc-900 p-3 text-xs shadow-lg"
      >
        <label className="flex flex-col gap-1 text-zinc-400">
          Objective
          <select
            value={objective}
            onChange={(e) =>
              setObjective(e.currentTarget.value as OptimizeObjective)
            }
            className="rounded bg-zinc-800 px-2 py-1 text-zinc-100 outline-none"
          >
            <option value="tank">Tank</option>
            <option value="damage">Damage</option>
            <option value="repair">Repair</option>
            <option value="yield">Yield (mining)</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-zinc-400">
          Slots
          <select
            value={optimizeMode}
            onChange={(e) =>
              setOptimizeMode(e.currentTarget.value as OptimizeMode)
            }
            title="Rework all relevant slots, or only fill empty ones"
            className="rounded bg-zinc-800 px-2 py-1 text-zinc-100 outline-none"
          >
            <option value="all">All modules</option>
            <option value="empty">Empty modules only</option>
          </select>
        </label>
        <div>
          <div className="mb-1 text-zinc-500">Meta groups</div>
          <div className="flex flex-wrap gap-x-3 gap-y-1">
            {META_TIERS.map(([id, label]) => (
              <label key={id} className="flex items-center gap-1 text-zinc-400">
                <input
                  type="checkbox"
                  checked={!!meta[id]}
                  onChange={(e) => {
                    const checked = e.currentTarget.checked;
                    setMeta((m) => ({ ...m, [id]: checked }));
                  }}
                />
                {label}
              </label>
            ))}
          </div>
        </div>
        <label
          className="flex items-center gap-1 text-zinc-400"
          title="Keep the result capacitor-stable"
        >
          <input
            type="checkbox"
            checked={capStable}
            onChange={(e) => setCapStable(e.currentTarget.checked)}
          />
          Cap-stable
        </label>
        <label
          className="flex items-center gap-1 text-zinc-400"
          title="Cap total fit cost"
        >
          Max
          <input
            type="number"
            min={0}
            value={maxCostM}
            onChange={(e) => setMaxCostM(e.currentTarget.value)}
            placeholder="∞"
            className="w-16 rounded bg-zinc-800 px-1 py-0.5 text-zinc-100 outline-none"
          />
          M ISK
        </label>
        <PrimaryButton
          onClick={onOptimize}
          disabled={pending}
          pending={pending}
          pendingLabel="Optimizing…"
        >
          Optimize
        </PrimaryButton>
      </Modal>
    </div>
  );
}
