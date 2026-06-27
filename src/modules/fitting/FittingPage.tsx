import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fittingDeleteLocal,
  fittingEsiList,
  fittingExportEft,
  fittingImportEft,
  fittingListLocal,
  fittingOptimize,
  fittingPrice,
  fittingSaveLocal,
  fittingShipLayout,
  fittingSimulate,
  marketRegions,
  sdeSearchShips,
  sdeStatus,
  sdeTypeInfos,
  sdeTypeNames,
  type CapStats,
  type Fit,
  type OptimizeMode,
  type OptimizeObjective,
  type SkillSource,
  type SlotKind,
} from "../../lib/api";
import { SdeSetup } from "../production/SdeSetup";
import { formatDuration, formatIsk } from "../../lib/format";

const FORGE = 10000002;

/** Gate the editor on the SDE being installed (like the other SDE-backed pages). */
export function FittingPage() {
  const status = useQuery({ queryKey: ["sde", "status"], queryFn: sdeStatus });
  if (status.isLoading) return <Centered>Checking static data…</Centered>;
  if (!status.data?.installed) {
    return <SdeSetup onInstalled={() => status.refetch()} />;
  }
  return <Workbench />;
}

function Workbench() {
  const qc = useQueryClient();
  const [fit, setFit] = useState<Fit | null>(null);
  const [query, setQuery] = useState("");
  const [regionId, setRegionId] = useState(FORGE);
  const [eft, setEft] = useState("");
  const [skillSource, setSkillSource] = useState<SkillSource>("allFive");
  const skillLabel = skillSource === "character" ? "character" : "all V";
  const [objective, setObjective] = useState<OptimizeObjective>("tank");
  const [optimizeMode, setOptimizeMode] = useState<OptimizeMode>("all");
  const [meta, setMeta] = useState<Record<number, boolean>>({
    1: true,
    2: true,
    4: false,
    6: false,
    5: false,
  });

  const regions = useQuery({ queryKey: ["market", "regions"], queryFn: marketRegions });
  // Ship-only search (no modules/charges/blueprints).
  const ships = useQuery({
    queryKey: ["fitting", "ships", query],
    queryFn: () => sdeSearchShips(query),
    enabled: query.trim().length >= 2,
  });
  const saved = useQuery({ queryKey: ["fitting", "saved"], queryFn: fittingListLocal });
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

  const importEft = useMutation({
    mutationFn: () => fittingImportEft(eft),
    onSuccess: (f) => {
      setFit(f);
      setEft("");
    },
    onError: (e) => alert(`Import failed: ${e}`),
  });
  const price = useMutation({ mutationFn: () => fittingPrice(fit!, regionId, null) });
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
  const exportEft = useMutation({
    mutationFn: () => fittingExportEft(fit!),
    onSuccess: (text) => {
      navigator.clipboard?.writeText(text).catch(() => {});
      setEft(text);
    },
  });
  const optimize = useMutation({
    mutationFn: () =>
      fittingOptimize(
        fit!,
        objective,
        Object.entries(meta)
          .filter(([, on]) => on)
          .map(([id]) => Number(id)),
        optimizeMode,
      ),
    onSuccess: (f) => setFit(f),
    onError: (e) => alert(`Optimize failed: ${e}`),
  });

  // All fits (local + in-game), each tagged with its source.
  const allFits = useMemo(() => {
    const local = (saved.data ?? []).map((f) => ({ fit: f, source: "saved" as const }));
    const esi = (esiFits.data ?? []).map((f) => ({ fit: f, source: "in-game" as const }));
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
      list.push({ key: `${source}:${f.id}:${i}`, hull, name: f.name, source, fit: f });
      byGroup.set(group, list);
    });
    return [...byGroup.entries()]
      .map(([group, fits]) => ({
        group,
        fits: fits.sort((a, b) => a.hull.localeCompare(b.hull) || a.name.localeCompare(b.name)),
      }))
      .sort((a, b) => a.group.localeCompare(b.group));
  }, [allFits, hullInfo]);
  const fitByKey = useMemo(() => {
    const m = new Map<string, Fit>();
    for (const g of fitGroups) for (const f of g.fits) m.set(f.key, f.fit);
    return m;
  }, [fitGroups]);

  function pickShip(id: number, name: string) {
    setQuery("");
    setFit({ id: "", name: `${name} fit`, shipTypeId: id, items: [] });
  }
  function removeItem(globalIndex: number) {
    setFit((f) =>
      f ? { ...f, items: f.items.filter((_, i) => i !== globalIndex) } : f,
    );
  }

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <header>
        <h1 className="text-lg font-semibold text-zinc-100">Fitting</h1>
        <p className="text-sm text-zinc-400">
          Build a fit, validate slots and resources, price it, and optimize. Import/export
          EFT or load your in-game fittings.
        </p>
      </header>

      {/* Controls: Ship · Skills · Price · (right) Fits */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="relative">
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Ship (hull)
            <input
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              placeholder="search a hull…"
              className="w-56 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
            />
          </label>
          {query.trim().length >= 2 && (ships.data?.length ?? 0) > 0 && (
            <div className="absolute z-20 mt-1 max-h-60 w-56 overflow-auto rounded border border-zinc-700 bg-zinc-900 text-sm shadow-lg">
              {ships.data!.map((r) => (
                <button
                  key={r.id}
                  onClick={() => pickShip(r.id, r.name)}
                  className="block w-full px-2 py-1 text-left text-zinc-300 hover:bg-zinc-800"
                >
                  {r.name}
                </button>
              ))}
            </div>
          )}
        </div>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Skills
          <select
            value={skillSource}
            onChange={(e) => setSkillSource(e.currentTarget.value as SkillSource)}
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
        <Centered>Pick a hull, load a saved/in-game fit, or import an EFT fit to begin.</Centered>
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
                onChange={(e) => setObjective(e.currentTarget.value as OptimizeObjective)}
                className="rounded bg-zinc-800 px-2 py-0.5 text-zinc-100 outline-none"
              >
                <option value="tank">Tank</option>
                <option value="damage">Damage</option>
                <option value="repair">Repair</option>
                <option value="yield">Yield (mining)</option>
              </select>
              <select
                value={optimizeMode}
                onChange={(e) => setOptimizeMode(e.currentTarget.value as OptimizeMode)}
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
              <button
                onClick={() => optimize.mutate()}
                disabled={optimize.isPending}
                className="rounded border border-zinc-700 px-2 py-0.5 text-zinc-200 hover:bg-zinc-800 disabled:opacity-50"
              >
                {optimize.isPending ? "Optimizing…" : "Optimize"}
              </button>
            </div>

            {layout.data && (
              <SlotGrid fit={fit} layout={layout.data} nameOf={nameOf} onRemove={removeItem} />
            )}
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
                Eval failed: {(stats.error as Error)?.message ?? String(stats.error)}
              </p>
            )}
            {!stats.data && !stats.isFetching && !stats.isError && (
              <p className="text-xs text-zinc-500">Add modules to see stats.</p>
            )}
            <div className={stats.isFetching ? "space-y-4 opacity-50 transition-opacity" : "space-y-4"}>
            {stats.data && (
              <div className="space-y-2">
                <h3 className="text-xs uppercase tracking-wide text-zinc-500">Fitting</h3>
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
                {stats.data.capacitor && <CapGauge cap={stats.data.capacitor} />}
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
                <h3 className="text-xs uppercase tracking-wide text-zinc-500">DPS ({skillLabel})</h3>
                <div className="text-sm text-zinc-300">{stats.data.dps.total.toFixed(1)} dps</div>
                {stats.data.dps.total > 0 && (
                  <div className="text-xs text-zinc-500">
                    {stats.data.dps.turret > 0 && `turret ${stats.data.dps.turret.toFixed(1)} `}
                    {stats.data.dps.missile > 0 && `· missile ${stats.data.dps.missile.toFixed(1)} `}
                    {stats.data.dps.drone > 0 && `· drone ${stats.data.dps.drone.toFixed(1)}`}
                  </div>
                )}
              </div>
            )}

            {stats.data?.tank && (
              <div className="space-y-1">
                <h3 className="text-xs uppercase tracking-wide text-zinc-500">Tank ({skillLabel})</h3>
                <div className="text-sm text-zinc-300">
                  {Math.round(stats.data.tank.ehp).toLocaleString()} EHP
                </div>
                <div className="text-xs text-zinc-500">
                  S {Math.round(stats.data.tank.shieldHp)} · A {Math.round(stats.data.tank.armorHp)} ·
                  H {Math.round(stats.data.tank.hullHp)}
                  {(stats.data.tank.shieldRepS > 0 || stats.data.tank.armorRepS > 0) && (
                    <> · reps {(stats.data.tank.shieldRepS + stats.data.tank.armorRepS).toFixed(1)}/s</>
                  )}
                </div>
              </div>
            )}

            {stats.data?.navigation && (
              <div className="space-y-1">
                <h3 className="text-xs uppercase tracking-wide text-zinc-500">Navigation</h3>
                <div className="text-xs text-zinc-400">
                  {Math.round(stats.data.navigation.maxVelocity)} m/s · align{" "}
                  {stats.data.navigation.alignTime.toFixed(1)}s · sig{" "}
                  {Math.round(stats.data.navigation.signatureRadius)}m
                </div>
              </div>
            )}
            </div>

            <div className="space-y-1">
              <div className="flex items-center justify-between">
                <h3 className="text-xs uppercase tracking-wide text-zinc-500">Price</h3>
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
  );
}

const SLOT_LABELS: [SlotKind, string][] = [
  ["high", "High"],
  ["mid", "Mid"],
  ["low", "Low"],
  ["rig", "Rig"],
  ["subsystem", "Subsystem"],
  ["drone", "Drones"],
  ["cargo", "Cargo"],
];

/** Items grouped by slot (by name), with the hull's slot counts and a remove ✕. */
function SlotGrid({
  fit,
  layout,
  nameOf,
  onRemove,
}: {
  fit: Fit;
  layout: { highSlots: number; midSlots: number; lowSlots: number; rigSlots: number };
  nameOf: (id: number) => string;
  onRemove: (globalIndex: number) => void;
}) {
  const counts: Partial<Record<SlotKind, number>> = {
    high: layout.highSlots,
    mid: layout.midSlots,
    low: layout.lowSlots,
    rig: layout.rigSlots,
  };
  return (
    <div className="space-y-3">
      {SLOT_LABELS.map(([slot, label]) => {
        const items = fit.items
          .map((it, i) => ({ it, i }))
          .filter((x) => x.it.slot === slot)
          .sort((a, b) => a.it.index - b.it.index);
        const cap = counts[slot];
        if (items.length === 0 && cap == null) return null;
        return (
          <div key={slot}>
            <div className="text-xs uppercase tracking-wide text-zinc-500">
              {label}
              {cap != null ? ` (${items.length}/${cap})` : ""}
            </div>
            {items.length === 0 ? (
              <div className="text-sm text-zinc-600">—</div>
            ) : (
              <ul className="text-sm text-zinc-300">
                {items.map(({ it, i }) => (
                  <li
                    key={i}
                    className="group flex items-center gap-2 rounded px-1 py-0.5 hover:bg-zinc-800/70"
                  >
                    <button
                      onClick={() => onRemove(i)}
                      className="shrink-0 text-zinc-600 group-hover:text-red-400"
                      title="Remove from slot"
                      aria-label={`Remove ${nameOf(it.typeId)}`}
                    >
                      ✕
                    </button>
                    <span className="truncate">
                      {nameOf(it.typeId)}
                      {it.chargeTypeId ? ` + ${nameOf(it.chargeTypeId)}` : ""}
                      {it.quantity > 1 ? ` x${it.quantity}` : ""}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** Capacitor gauge: a 0–100% fill when stable, or the time-to-empty when not. */
function CapGauge({ cap }: { cap: CapStats }) {
  if (cap.stable) {
    const pct = Math.max(0, Math.min(100, cap.stablePct ?? 100));
    return (
      <div>
        <div className="flex justify-between text-xs">
          <span className="text-zinc-400">Capacitor</span>
          <span className="text-emerald-400">stable · {pct.toFixed(0)}%</span>
        </div>
        <div className="mt-0.5 h-2 w-full overflow-hidden rounded bg-zinc-800">
          <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
        </div>
      </div>
    );
  }
  return (
    <div>
      <div className="flex justify-between text-xs">
        <span className="text-zinc-400">Capacitor</span>
        <span className="text-red-400">
          empties in {formatDuration(cap.depletionSeconds ?? 0)}
        </span>
      </div>
      <div className="mt-0.5 h-2 w-full overflow-hidden rounded bg-zinc-800">
        <div className="h-full bg-red-500" style={{ width: "100%" }} />
      </div>
    </div>
  );
}

function ResourceBar({
  label,
  used,
  max,
  unit,
}: {
  label: string;
  used: number;
  max: number;
  unit: string;
}) {
  const frac = max > 0 ? Math.min(used / max, 1) : 0;
  const over = used > max + 1e-6;
  return (
    <div>
      <div className="flex justify-between text-xs text-zinc-400">
        <span>{label}</span>
        <span className={over ? "text-red-400" : ""}>
          {used.toFixed(1)} / {max.toFixed(0)} {unit}
        </span>
      </div>
      <div className="mt-0.5 h-1.5 w-full overflow-hidden rounded bg-zinc-800">
        <div
          className={`h-full ${over ? "bg-red-500" : "bg-emerald-500"}`}
          style={{ width: `${frac * 100}%` }}
        />
      </div>
    </div>
  );
}

/** In-game fittings status: an error (e.g. missing scope) or "none found". */
function EsiFitStatus({
  esi,
  refresh,
}: {
  esi: { data?: Fit[]; error: unknown; isFetched: boolean };
  refresh: { error: unknown };
}) {
  const err = refresh.error ?? esi.error;
  if (err) {
    return (
      <span className="mt-0.5 block w-72 text-[11px] text-rose-400">{String(err)}</span>
    );
  }
  if (esi.isFetched && (esi.data?.length ?? 0) === 0) {
    return (
      <span className="mt-0.5 block text-[11px] text-zinc-500">
        No in-game fittings for this character.
      </span>
    );
  }
  return null;
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-zinc-500">
      {children}
    </div>
  );
}
