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

  // --- Fit picker (top-right): search local + in-game fits by name ---
  const [fitQuery, setFitQuery] = useState("");
  const [fitsOpen, setFitsOpen] = useState(false);

  const regions = useQuery({ queryKey: ["market", "regions"], queryFn: marketRegions });
  // Ship-only search (no modules/charges/blueprints).
  const ships = useQuery({
    queryKey: ["fitting", "ships", query],
    queryFn: () => sdeSearchShips(query),
    enabled: query.trim().length >= 2,
  });
  const saved = useQuery({ queryKey: ["fitting", "saved"], queryFn: fittingListLocal });
  // In-game (ESI) fittings — fetched on demand (cached server-side), not on mount.
  const esiFits = useQuery({
    queryKey: ["fitting", "esi"],
    queryFn: () => fittingEsiList(),
    enabled: false,
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

  // Combined, searchable fit list (local + in-game).
  const allFits = useMemo(() => {
    const local = (saved.data ?? []).map((f) => ({ fit: f, source: "saved" as const }));
    const esi = (esiFits.data ?? []).map((f) => ({ fit: f, source: "in-game" as const }));
    return [...local, ...esi];
  }, [saved.data, esiFits.data]);
  const filteredFits = useMemo(() => {
    const q = fitQuery.trim().toLowerCase();
    return allFits.filter(({ fit }) => !q || fit.name.toLowerCase().includes(q));
  }, [allFits, fitQuery]);

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

        {/* Fits picker — independent of the hull selection */}
        <div className="relative ml-auto">
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Fits (saved + in-game)
            <input
              value={fitQuery}
              onChange={(e) => setFitQuery(e.currentTarget.value)}
              onFocus={() => setFitsOpen(true)}
              onBlur={() => setTimeout(() => setFitsOpen(false), 150)}
              placeholder="search your fits by name…"
              className="w-64 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
            />
          </label>
          {fitsOpen && (
            <div className="absolute right-0 z-20 mt-1 max-h-72 w-72 overflow-auto rounded border border-zinc-700 bg-zinc-900 text-sm shadow-lg">
              <div className="flex items-center justify-between border-b border-zinc-800 px-2 py-1 text-[11px] text-zinc-500">
                <span>{filteredFits.length} fit(s)</span>
                <button
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => esiFits.refetch()}
                  className="rounded border border-zinc-700 px-1.5 text-zinc-300 hover:bg-zinc-800"
                >
                  {esiFits.isFetching ? "…" : "Load from EVE"}
                </button>
              </div>
              {filteredFits.length === 0 ? (
                <div className="px-2 py-2 text-xs text-zinc-600">
                  No fits. Save one, or “Load from EVE” (needs the esi-fittings scope).
                </div>
              ) : (
                filteredFits.map(({ fit: f, source }) => (
                  <div
                    key={`${source}:${f.id}`}
                    className="group flex items-center gap-1 px-2 py-1 hover:bg-zinc-800"
                  >
                    <button
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setFit(f);
                        setFitsOpen(false);
                      }}
                      className="min-w-0 flex-1 truncate text-left text-zinc-300"
                      title={f.name}
                    >
                      {f.name}
                    </button>
                    <span className="shrink-0 text-[10px] text-zinc-600">{source}</span>
                    {source === "saved" && (
                      <button
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => del.mutate(f.id)}
                        className="shrink-0 text-zinc-600 opacity-0 hover:text-rose-400 group-hover:opacity-100"
                        title="Delete saved fit"
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
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
                    onChange={(e) => setMeta((m) => ({ ...m, [id]: e.currentTarget.checked }))}
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

            {stats.data?.dps && stats.data.dps.total > 0 && (
              <div className="space-y-1">
                <h3 className="text-xs uppercase tracking-wide text-zinc-500">DPS ({skillLabel})</h3>
                <div className="text-sm text-zinc-300">{stats.data.dps.total.toFixed(1)} dps</div>
                <div className="text-xs text-zinc-500">
                  {stats.data.dps.turret > 0 && `turret ${stats.data.dps.turret.toFixed(1)} `}
                  {stats.data.dps.missile > 0 && `· missile ${stats.data.dps.missile.toFixed(1)} `}
                  {stats.data.dps.drone > 0 && `· drone ${stats.data.dps.drone.toFixed(1)}`}
                </div>
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
                  <li key={i} className="group flex items-center justify-between">
                    <span className="truncate">
                      {nameOf(it.typeId)}
                      {it.chargeTypeId ? ` + ${nameOf(it.chargeTypeId)}` : ""}
                      {it.quantity > 1 ? ` x${it.quantity}` : ""}
                    </span>
                    <button
                      onClick={() => onRemove(i)}
                      className="ml-2 shrink-0 text-zinc-600 opacity-0 hover:text-red-400 group-hover:opacity-100"
                      title="Remove from slot"
                    >
                      ✕
                    </button>
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

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center text-sm text-zinc-500">
      {children}
    </div>
  );
}
