import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  errorMessage,
  fittingDeleteLocal,
  fittingEsiPush,
  fittingOptimize,
  fittingPrice,
  sdeSearchShips,
  type OptimizeMode,
  type OptimizeObjective,
  type SlotKind,
} from "../../lib/api";
import { marketKeys } from "../../lib/queryKeys";
import { Page, PageHeader } from "../../components/page";
import { Combo } from "../../components/Combo";
import { SdeGate } from "../../components/SdeGate";
import {
  Centered,
  EsiFitStatus,
  ModuleBrowser,
  ProjectedPanel,
  SlotGrid,
} from "./components";
import { StatsAside } from "./StatsAside";
import { useFitEditor } from "./useFitEditor";
import { useFitLibrary } from "./useFitLibrary";

const FORGE = 10000002;

const TITLE = "Fitting";
const SUBTITLE =
  "Build a fit, validate slots and resources, price it, and optimize. Import/export EFT or load your in-game fittings.";

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
  const [regionId, setRegionId] = useState(FORGE);
  const [objective, setObjective] = useState<OptimizeObjective>("tank");
  const [optimizeMode, setOptimizeMode] = useState<OptimizeMode>("all");
  const [capStable, setCapStable] = useState(false);
  // ISK budget cap as a string (millions); empty = no budget.
  const [maxCostM, setMaxCostM] = useState("");
  const [optimizeNotice, setOptimizeNotice] = useState<string | null>(null);
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
    onError: (e) => alert(`Couldn't save to EVE: ${errorMessage(e)}`),
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
      editor.setFit(res.fit);
      const unmet: string[] = [];
      if (capStable && !res.capStable) unmet.push("cap-stable");
      if (maxCostM.trim() && !res.withinBudget) unmet.push("ISK budget");
      setOptimizeNotice(
        unmet.length
          ? `Couldn't meet ${unmet.join(" + ")} — showing the closest fit.`
          : null,
      );
    },
    onError: (e) => alert(`Optimize failed: ${errorMessage(e)}`),
  });

  const { fit, nameOf, layout, stats, rangeOf, activatable, fitContext } =
    editor;

  return (
    <Page>
      <PageHeader title={TITLE} subtitle={SUBTITLE} />
      <div className="flex h-full flex-col gap-4">
        {/* Controls: Ship · Skills · Price · (right) Fits */}
        <div className="flex flex-wrap items-end gap-3">
          <Combo
            value={
              fit ? { id: fit.shipTypeId, name: nameOf(fit.shipTypeId) } : null
            }
            onPick={(v) => (v ? editor.pickShip(v.id, v.name) : editor.setFit(null))}
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
              <EsiFitStatus esi={library.esiFits} refresh={library.refreshEsi} />
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

        <div className="flex items-start gap-2">
          <textarea
            value={editor.eft}
            onChange={(e) => editor.setEft(e.currentTarget.value)}
            placeholder="paste an EFT fit here…"
            className="h-16 w-96 rounded bg-zinc-800 px-2 py-1 font-mono text-xs text-zinc-100 outline-none placeholder:text-zinc-500"
          />
          <button
            onClick={() => editor.importEft.mutate()}
            disabled={editor.eft.trim().length === 0 || editor.importEft.isPending}
            className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          >
            {editor.importEft.isPending ? "Importing…" : "Import EFT"}
          </button>
        </div>

        {fit == null ? (
          <Centered>
            Pick a hull, load a saved/in-game fit, or import an EFT fit to
            begin.
          </Centered>
        ) : (
          <div className="flex min-h-0 flex-1 gap-4">
            {/* Left: editor */}
            <section className="min-w-0 flex-1 overflow-auto">
              <div className="mb-2 flex items-center gap-2">
                <h2 className="font-medium text-zinc-200">
                  {layout.data?.name ?? nameOf(fit.shipTypeId)} — {fit.name}
                </h2>
                <button
                  onClick={() => editor.save.mutate()}
                  className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
                >
                  {editor.save.isPending ? "Saving…" : "Save"}
                </button>
                <button
                  onClick={() => editor.exportEft.mutate()}
                  className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
                >
                  Export EFT
                </button>
                <button
                  onClick={() => pushEsi.mutate()}
                  disabled={pushEsi.isPending}
                  title="Save this fit to your in-game fittings (ESI)"
                  className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
                >
                  {pushEsi.isPending
                    ? "Saving…"
                    : pushEsi.isSuccess
                      ? "Saved to EVE ✓"
                      : "Save to EVE"}
                </button>
                {library.saved.data?.some((s) => s.id === fit.id) && (
                  <button
                    onClick={() => {
                      del.mutate(fit.id);
                      editor.setFit(null);
                    }}
                    className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 hover:text-rose-400"
                  >
                    Delete
                  </button>
                )}
              </div>

              {/* Optimize */}
              <div className="mb-3 flex flex-wrap items-center gap-2 rounded border border-zinc-800 bg-zinc-900/40 p-2 text-xs">
                <span className="text-zinc-500">Optimize</span>
                <select
                  value={objective}
                  onChange={(e) =>
                    setObjective(e.currentTarget.value as OptimizeObjective)
                  }
                  className="rounded bg-zinc-800 px-2 py-0.5 text-zinc-100 outline-none"
                >
                  <option value="tank">Tank</option>
                  <option value="damage">Damage</option>
                  <option value="repair">Repair</option>
                  <option value="yield">Yield (mining)</option>
                </select>
                <select
                  value={optimizeMode}
                  onChange={(e) =>
                    setOptimizeMode(e.currentTarget.value as OptimizeMode)
                  }
                  className="rounded bg-zinc-800 px-2 py-0.5 text-zinc-100 outline-none"
                  title="Rework all relevant slots, or only fill empty ones"
                >
                  <option value="all">All modules</option>
                  <option value="empty">Empty modules only</option>
                </select>
                <span className="text-zinc-700">·</span>
                {(
                  [
                    [1, "T1"],
                    [2, "T2"],
                    [4, "Faction"],
                    [6, "Deadspace"],
                    [5, "Officer"],
                  ] as [number, string][]
                ).map(([id, label]) => (
                  <label
                    key={id}
                    className="flex items-center gap-1 text-zinc-400"
                  >
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
                <span className="text-zinc-700">·</span>
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
                <button
                  onClick={() => optimize.mutate()}
                  disabled={optimize.isPending}
                  className="rounded border border-zinc-700 px-2 py-0.5 text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
                >
                  {optimize.isPending ? "Optimizing…" : "Optimize"}
                </button>
                {optimizeNotice && (
                  <span className="w-full text-amber-400">
                    {optimizeNotice}
                  </span>
                )}
              </div>

              {/* Prefer the resolved layout (T3 subsystems grant slots). */}
              {(stats.data?.layout ?? layout.data) && (
                <SlotGrid
                  fit={fit}
                  layout={stats.data?.layout ?? layout.data!}
                  nameOf={nameOf}
                  onRemove={editor.removeItem}
                  onAddToSlot={setSlotFilter}
                  onSetCharge={editor.setCharge}
                  onSetChargeForType={editor.setChargeForType}
                  onSetState={editor.setModuleState}
                  rangeOf={rangeOf}
                  activatable={activatable}
                />
              )}

              <ModuleBrowser
                onAdd={(typeId) => editor.addItem.mutate(typeId)}
                pending={editor.addItem.isPending}
                slotFilter={slotFilter}
                onSlotFilter={setSlotFilter}
                fitContext={fitContext}
                shipTypeId={fit.shipTypeId}
                skillSource={editor.skillSource}
              />

              <ProjectedPanel
                projected={fit.projected ?? []}
                nameOf={nameOf}
                onAdd={editor.addProjected}
                onRemove={editor.removeProjected}
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
            />
          </div>
        )}
      </div>
    </Page>
  );
}
