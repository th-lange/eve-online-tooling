import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  errorMessage,
  fittingAddItem,
  fittingDeleteLocal,
  fittingEsiList,
  fittingEsiPush,
  fittingExportEft,
  fittingImportEft,
  fittingListLocal,
  fittingOptimize,
  fittingPrice,
  fittingSaveLocal,
  fittingShipLayout,
  fittingSimulate,
  sdeSearchShips,
  sdeTypeInfos,
  sdeTypeNames,
  type Fit,
  type ModuleState,
  type OptimizeMode,
  type OptimizeObjective,
  type SkillSource,
  type SlotKind,
  type WeaponRange,
} from "../../lib/api";
import { marketKeys } from "../../lib/queryKeys";
import { Page, PageHeader } from "../../components/page";
import { Combo } from "../../components/Combo";
import { SdeGate } from "../../components/SdeGate";
import { formatInt, formatIsk } from "../../lib/format";
import { copyToClipboard } from "../../lib/useCopyToClipboard";
import {
  CapGauge,
  Centered,
  EsiFitStatus,
  EwPanel,
  ModuleBrowser,
  ProjectedPanel,
  ResourceBar,
  SlotGrid,
  TankResists,
  type FitContext,
} from "./components";

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
  const [fit, setFit] = useState<Fit | null>(null);
  // When set (from clicking a free slot), the add-module browser filters to it.
  const [slotFilter, setSlotFilter] = useState<SlotKind | null>(null);
  const [regionId, setRegionId] = useState(FORGE);
  const [eft, setEft] = useState("");
  const [skillSource, setSkillSource] = useState<SkillSource>("allFive");
  const skillLabel = skillSource === "character" ? "character" : "all V";
  const [objective, setObjective] = useState<OptimizeObjective>("tank");
  const [optimizeMode, setOptimizeMode] = useState<OptimizeMode>("all");
  const [capStable, setCapStable] = useState(false);
  // ECM is a chance-to-jam, not a continuous effect — so it's an opt-in "what if
  // the jam lands" view (targeting disabled), never a passive stat (#265).
  const [jammed, setJammed] = useState(false);
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
  const saved = useQuery({
    queryKey: ["fitting", "saved"],
    queryFn: fittingListLocal,
  });
  // In-game (ESI) fittings — fetched on demand (cached server-side), not on mount.
  // Auto-load in-game fits (cached server-side 30m); "Refresh" forces a fetch.
  const esiFits = useQuery({
    queryKey: ["fitting", "esi"],
    queryFn: () => fittingEsiList(),
  });

  const layout = useQuery({
    queryKey: ["fitting", "layout", fit?.shipTypeId],
    queryFn: () => fittingShipLayout(fit!.shipTypeId),
    enabled: fit != null,
  });

  // Names for every fitted type id (+ charges), to show names not ids.
  const itemIds = useMemo(() => {
    if (!fit) return [];
    const s = new Set<number>([fit.shipTypeId]);
    for (const it of fit.items) {
      s.add(it.typeId);
      if (it.chargeTypeId) s.add(it.chargeTypeId);
    }
    for (const it of fit.projected ?? []) s.add(it.typeId);
    return [...s];
  }, [fit]);
  const names = useQuery({
    queryKey: ["fitting", "names", itemIds],
    queryFn: () => sdeTypeNames(itemIds),
    enabled: itemIds.length > 0,
  });
  const nameMap = useMemo(
    () => new Map((names.data ?? []).map((n) => [n.id, n.name])),
    [names.data],
  );
  const nameOf = (id: number) => nameMap.get(id) ?? `#${id}`;

  const fitKey = useMemo(() => (fit ? JSON.stringify(fit) : ""), [fit]);
  const stats = useQuery({
    queryKey: ["fitting", "simulate", fitKey, skillSource],
    queryFn: () => fittingSimulate(fit!, skillSource),
    enabled: fit != null,
  });
  // The jammed view only applies while ECM is actually projected onto the fit.
  const jammedActive = jammed && !!stats.data?.projectedEw?.some((t) => t.jam);

  // Per-weapon ranges keyed by (typeId, chargeTypeId), for the slot grid.
  const rangeOf = useMemo(() => {
    const m = new Map<string, WeaponRange>();
    for (const r of stats.data?.weaponRanges ?? [])
      m.set(`${r.typeId}:${r.chargeTypeId ?? 0}`, r);
    return m;
  }, [stats.data?.weaponRanges]);
  // Module type ids that can be activated (others are passive — no active state).
  const activatable = useMemo(
    () => new Set(stats.data?.activatableTypes ?? []),
    [stats.data?.activatableTypes],
  );

  // What the hull has free right now — drives fit-aware ranking/filtering in the
  // add-module browser. Prefer the resolved (skill-adjusted) layout/resources.
  const fitContext = useMemo<FitContext | null>(() => {
    if (!fit) return null;
    const ship = stats.data?.layout ?? layout.data;
    if (!ship) return null;
    const used: Partial<Record<SlotKind, number>> = {};
    for (const it of fit.items) used[it.slot] = (used[it.slot] ?? 0) + 1;
    const free = (kind: SlotKind, total: number) =>
      Math.max(0, total - (used[kind] ?? 0));
    const res = stats.data?.resources;
    return {
      freeSlots: {
        high: free("high", ship.highSlots),
        mid: free("mid", ship.midSlots),
        low: free("low", ship.lowSlots),
        rig: free("rig", ship.rigSlots),
        subsystem: free("subsystem", ship.subsystemSlots),
      },
      cpu: (res?.cpuOutput ?? ship.cpuOutput) - (res?.cpuUsed ?? 0),
      pg:
        (res?.powergridOutput ?? ship.powergridOutput) -
        (res?.powergridUsed ?? 0),
      calibration:
        (res?.calibrationOutput ?? ship.calibration) -
        (res?.calibrationUsed ?? 0),
    };
  }, [fit, stats.data, layout.data]);

  const importEft = useMutation({
    mutationFn: () => fittingImportEft(eft),
    onSuccess: (f) => {
      setFit(f);
      setEft("");
    },
    onError: (e) => alert(`Import failed: ${errorMessage(e)}`),
  });
  const price = useMutation({
    mutationFn: () => fittingPrice(fit!, regionId, null),
  });
  const save = useMutation({
    mutationFn: () => fittingSaveLocal(fit!),
    onSuccess: (id) => {
      setFit((f) => (f ? { ...f, id } : f));
      qc.invalidateQueries({ queryKey: ["fitting", "saved"] });
    },
  });
  const del = useMutation({
    mutationFn: (id: string) => fittingDeleteLocal(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["fitting", "saved"] }),
  });
  // Force-refresh in-game fits past the server cache and update the query.
  const refreshEsi = useMutation({
    mutationFn: () => fittingEsiList(true),
    onSuccess: (fits) => qc.setQueryData(["fitting", "esi"], fits),
  });
  // Save the current fit to the active character's in-game fittings via ESI.
  const pushEsi = useMutation({
    mutationFn: () => fittingEsiPush(fit!),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["fitting", "esi"] }),
    onError: (e) => alert(`Couldn't save to EVE: ${errorMessage(e)}`),
  });
  const exportEft = useMutation({
    mutationFn: () => fittingExportEft(fit!),
    onSuccess: (text) => {
      copyToClipboard(text);
      setEft(text);
    },
  });
  const optimize = useMutation({
    mutationFn: () => {
      const maxCost = maxCostM.trim() ? Number(maxCostM) * 1_000_000 : null;
      return fittingOptimize(
        fit!,
        objective,
        Object.entries(meta)
          .filter(([, on]) => on)
          .map(([id]) => Number(id)),
        optimizeMode,
        { capStable, maxCost, regionId },
      );
    },
    onSuccess: (res) => {
      setFit(res.fit);
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

  // All fits (local + in-game), each tagged with its source.
  const allFits = useMemo(() => {
    const local = (saved.data ?? []).map((f) => ({
      fit: f,
      source: "saved" as const,
    }));
    const esi = (esiFits.data ?? []).map((f) => ({
      fit: f,
      source: "in-game" as const,
    }));
    return [...local, ...esi];
  }, [saved.data, esiFits.data]);

  // Resolve each fit's hull to its name + ship group, for grouping the dropdown.
  const hullIds = useMemo(
    () => [...new Set(allFits.map((f) => f.fit.shipTypeId))],
    [allFits],
  );
  const hulls = useQuery({
    queryKey: ["fitting", "hullInfos", hullIds],
    queryFn: () => sdeTypeInfos(hullIds),
    enabled: hullIds.length > 0,
  });
  const hullInfo = useMemo(
    () => new Map((hulls.data ?? []).map((h) => [h.id, h])),
    [hulls.data],
  );

  // Group fits by ship group → (hull, fit name), sorted, for the dropdown.
  const fitGroups = useMemo(() => {
    const byGroup = new Map<
      string,
      { key: string; hull: string; name: string; source: string; fit: Fit }[]
    >();
    allFits.forEach(({ fit: f, source }, i) => {
      const info = hullInfo.get(f.shipTypeId);
      const group = info?.group || "Other";
      const hull = info?.name || `#${f.shipTypeId}`;
      const list = byGroup.get(group) ?? [];
      list.push({
        key: `${source}:${f.id}:${i}`,
        hull,
        name: f.name,
        source,
        fit: f,
      });
      byGroup.set(group, list);
    });
    return [...byGroup.entries()]
      .map(([group, fits]) => ({
        group,
        fits: fits.sort(
          (a, b) =>
            a.hull.localeCompare(b.hull) || a.name.localeCompare(b.name),
        ),
      }))
      .sort((a, b) => a.group.localeCompare(b.group));
  }, [allFits, hullInfo]);
  const fitByKey = useMemo(() => {
    const m = new Map<string, Fit>();
    for (const g of fitGroups) for (const f of g.fits) m.set(f.key, f.fit);
    return m;
  }, [fitGroups]);

  function pickShip(id: number, name: string) {
    setFit({ id: "", name: `${name} fit`, shipTypeId: id, items: [] });
  }
  function removeItem(globalIndex: number) {
    setFit((f) =>
      f ? { ...f, items: f.items.filter((_, i) => i !== globalIndex) } : f,
    );
  }
  // Load/clear a weapon's charge (re-simulates: fitKey is the serialized fit).
  function setCharge(globalIndex: number, chargeTypeId: number | null) {
    setFit((f) =>
      f
        ? {
            ...f,
            items: f.items.map((it, i) =>
              i === globalIndex ? { ...it, chargeTypeId } : it,
            ),
          }
        : f,
    );
  }
  // Toggle a module's state (active ↔ offline) — re-simulates off the new fit.
  function setModuleState(globalIndex: number, state: ModuleState) {
    setFit((f) =>
      f
        ? {
            ...f,
            items: f.items.map((it, i) =>
              i === globalIndex ? { ...it, state } : it,
            ),
          }
        : f,
    );
  }
  // Load/clear a charge on *every* fitted weapon of the given type at once.
  function setChargeForType(weaponTypeId: number, chargeTypeId: number | null) {
    setFit((f) =>
      f
        ? {
            ...f,
            items: f.items.map((it) =>
              it.typeId === weaponTypeId ? { ...it, chargeTypeId } : it,
            ),
          }
        : f,
    );
  }
  // Projected modules (webs/paints/…) live in `fit.projected`; their slot/index
  // are irrelevant to projection, so they're added/removed client-side.
  function addProjected(typeId: number) {
    setFit((f) =>
      f
        ? {
            ...f,
            projected: [
              ...(f.projected ?? []),
              { typeId, slot: "mid", index: 0, state: "active", quantity: 1 },
            ],
          }
        : f,
    );
  }
  function removeProjected(idx: number) {
    setFit((f) =>
      f
        ? { ...f, projected: (f.projected ?? []).filter((_, i) => i !== idx) }
        : f,
    );
  }

  // Add a module/drone the user picked: the backend classifies its slot and
  // places it at the next free index, then we re-simulate off the new fit.
  const addItem = useMutation({
    mutationFn: (typeId: number) => fittingAddItem(fit!, typeId),
    onSuccess: (f) => setFit(f),
    onError: (e) => alert(`Couldn't add module: ${errorMessage(e)}`),
  });

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
            onPick={(v) => (v ? pickShip(v.id, v.name) : setFit(null))}
            search={sdeSearchShips}
            label="Ship (hull)"
            placeholder="search a hull…"
            width="w-56"
          />
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Skills
            <select
              value={skillSource}
              onChange={(e) =>
                setSkillSource(e.currentTarget.value as SkillSource)
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
              Fits ({allFits.length} saved + in-game)
              <select
                value=""
                onChange={(e) => {
                  const f = fitByKey.get(e.currentTarget.value);
                  if (f) setFit(f);
                }}
                className="w-72 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
              >
                <option value="">load a fit…</option>
                {fitGroups.map((g) => (
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
              <EsiFitStatus esi={esiFits} refresh={refreshEsi} />
            </label>
            <button
              onClick={() => refreshEsi.mutate()}
              disabled={refreshEsi.isPending}
              title="Refresh in-game fittings from EVE (bypasses the cache)"
              className="rounded border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
            >
              {refreshEsi.isPending ? "…" : "Refresh"}
            </button>
          </div>
        </div>

        <div className="flex items-start gap-2">
          <textarea
            value={eft}
            onChange={(e) => setEft(e.currentTarget.value)}
            placeholder="paste an EFT fit here…"
            className="h-16 w-96 rounded bg-zinc-800 px-2 py-1 font-mono text-xs text-zinc-100 outline-none placeholder:text-zinc-500"
          />
          <button
            onClick={() => importEft.mutate()}
            disabled={eft.trim().length === 0 || importEft.isPending}
            className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
          >
            {importEft.isPending ? "Importing…" : "Import EFT"}
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
                  onClick={() => save.mutate()}
                  className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
                >
                  {save.isPending ? "Saving…" : "Save"}
                </button>
                <button
                  onClick={() => exportEft.mutate()}
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
                {saved.data?.some((s) => s.id === fit.id) && (
                  <button
                    onClick={() => {
                      del.mutate(fit.id);
                      setFit(null);
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
                  onRemove={removeItem}
                  onAddToSlot={setSlotFilter}
                  onSetCharge={setCharge}
                  onSetChargeForType={setChargeForType}
                  onSetState={setModuleState}
                  rangeOf={rangeOf}
                  activatable={activatable}
                />
              )}

              <ModuleBrowser
                onAdd={(typeId) => addItem.mutate(typeId)}
                pending={addItem.isPending}
                slotFilter={slotFilter}
                onSlotFilter={setSlotFilter}
                fitContext={fitContext}
                shipTypeId={fit.shipTypeId}
                skillSource={skillSource}
              />

              <ProjectedPanel
                projected={fit.projected ?? []}
                nameOf={nameOf}
                onAdd={addProjected}
                onRemove={removeProjected}
              />
            </section>

            {/* Right: stats */}
            <aside className="w-72 shrink-0 space-y-4 overflow-auto">
              <div className="flex h-5 items-center justify-between">
                <h2 className="text-sm font-medium text-zinc-200">Stats</h2>
                {stats.isFetching && (
                  <span className="flex items-center gap-1.5 text-xs text-zinc-400">
                    <span className="h-3 w-3 animate-spin rounded-full border-2 border-zinc-600 border-t-zinc-300" />
                    Evaluating…
                  </span>
                )}
              </div>
              {stats.isError && (
                <p className="text-xs text-red-400">
                  Eval failed:{" "}
                  {errorMessage(stats.error)}
                </p>
              )}
              {!stats.data && !stats.isFetching && !stats.isError && (
                <p className="text-xs text-zinc-500">
                  Add modules to see stats.
                </p>
              )}
              <div
                className={
                  stats.isFetching
                    ? "space-y-4 opacity-50 transition-opacity"
                    : "space-y-4"
                }
              >
                {stats.data && (
                  <div className="space-y-2">
                    <h3 className="text-xs uppercase tracking-wide text-zinc-500">
                      Fitting
                    </h3>
                    <ResourceBar
                      label="CPU"
                      used={stats.data.resources.cpuUsed}
                      max={stats.data.resources.cpuOutput}
                      unit="tf"
                    />
                    <ResourceBar
                      label="Powergrid"
                      used={stats.data.resources.powergridUsed}
                      max={stats.data.resources.powergridOutput}
                      unit="MW"
                    />
                    <ResourceBar
                      label="Calibration"
                      used={stats.data.resources.calibrationUsed}
                      max={stats.data.resources.calibrationOutput}
                      unit=""
                    />
                    {stats.data.capacitor && (
                      <CapGauge cap={stats.data.capacitor} />
                    )}
                    {stats.data.validation.length > 0 && (
                      <ul className="mt-2 space-y-1">
                        {stats.data.validation.map((p, i) => (
                          <li key={i} className="text-xs text-red-400">
                            ⚠ {p.message}
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                )}

                {stats.data?.dps && (
                  <div className="space-y-1">
                    <h3 className="text-xs uppercase tracking-wide text-zinc-500">
                      DPS ({skillLabel})
                    </h3>
                    {jammedActive ? (
                      <div className="text-sm text-amber-400">
                        Jammed — 0 applied (no lock)
                      </div>
                    ) : (
                      <>
                        <div className="text-sm text-zinc-300">
                          {stats.data.dps.total.toFixed(1)} dps
                        </div>
                        {stats.data.dps.total > 0 && (
                          <div className="text-xs text-zinc-500">
                            {stats.data.dps.turret > 0 &&
                              `turret ${stats.data.dps.turret.toFixed(1)} `}
                            {stats.data.dps.missile > 0 &&
                              `· missile ${stats.data.dps.missile.toFixed(1)} `}
                            {stats.data.dps.drone > 0 &&
                              `· drone ${stats.data.dps.drone.toFixed(1)}`}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )}

                {stats.data?.projectedEw &&
                  stats.data.projectedEw.length > 0 && (
                    <EwPanel
                      tags={stats.data.projectedEw}
                      jammed={jammed}
                      onJam={setJammed}
                    />
                  )}

                {stats.data?.tank && (
                  <div className="space-y-1">
                    <h3 className="text-xs uppercase tracking-wide text-zinc-500">
                      Tank ({skillLabel})
                    </h3>
                    <div className="text-sm text-zinc-300">
                      {formatInt(Math.round(stats.data.tank.ehp))} EHP
                    </div>
                    {(stats.data.tank.shieldRepS > 0 ||
                      stats.data.tank.armorRepS > 0 ||
                      stats.data.tank.passiveShieldS > 0) && (
                      <div className="flex flex-wrap gap-x-3 text-xs text-zinc-500">
                        {stats.data.tank.shieldRepS > 0 && (
                          <span>
                            shield boost{" "}
                            <span className="tabular-nums text-sky-400">
                              {stats.data.tank.shieldRepS.toFixed(1)}/s
                            </span>
                          </span>
                        )}
                        {stats.data.tank.armorRepS > 0 && (
                          <span>
                            armor rep{" "}
                            <span className="tabular-nums text-amber-400">
                              {stats.data.tank.armorRepS.toFixed(1)}/s
                            </span>
                          </span>
                        )}
                        {stats.data.tank.passiveShieldS > 0 && (
                          <span>
                            passive shield{" "}
                            <span className="tabular-nums text-sky-300">
                              {stats.data.tank.passiveShieldS.toFixed(1)}/s
                            </span>
                          </span>
                        )}
                      </div>
                    )}
                    <TankResists tank={stats.data.tank} />
                  </div>
                )}

                {stats.data?.navigation && (
                  <div className="space-y-1">
                    <h3 className="text-xs uppercase tracking-wide text-zinc-500">
                      Navigation
                    </h3>
                    <div className="text-xs text-zinc-400">
                      {Math.round(stats.data.navigation.maxVelocity)} m/s ·
                      align {stats.data.navigation.alignTime.toFixed(1)}s · sig{" "}
                      {Math.round(stats.data.navigation.signatureRadius)}m
                    </div>
                  </div>
                )}
              </div>

              <div className="space-y-1">
                <div className="flex items-center justify-between">
                  <h3 className="text-xs uppercase tracking-wide text-zinc-500">
                    Price
                  </h3>
                  <button
                    onClick={() => price.mutate()}
                    className="rounded border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
                  >
                    {price.isPending ? "…" : "Price fit"}
                  </button>
                </div>
                {price.data && (
                  <div className="text-sm text-zinc-300">
                    <div>Buy: {formatIsk(price.data.buyTotal)}</div>
                    <div>Sell: {formatIsk(price.data.sellTotal)}</div>
                  </div>
                )}
              </div>
            </aside>
          </div>
        )}
      </div>
    </Page>
  );
}
