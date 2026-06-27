import { useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fittingDeleteLocal,
  fittingExportEft,
  fittingImportEft,
  fittingListLocal,
  fittingLoadLocal,
  fittingPrice,
  fittingSaveLocal,
  fittingShipLayout,
  fittingSimulate,
  marketRegions,
  sdeSearch,
  sdeStatus,
  type Fit,
  type FitItem,
  type SlotKind,
} from "../../lib/api";
import { SdeSetup } from "../production/SdeSetup";
import { formatIsk } from "../../lib/format";

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

  const regions = useQuery({ queryKey: ["market", "regions"], queryFn: marketRegions });
  const results = useQuery({
    queryKey: ["fitting", "search", query],
    queryFn: () => sdeSearch(query),
    enabled: query.trim().length >= 2,
  });
  const saved = useQuery({ queryKey: ["fitting", "saved"], queryFn: fittingListLocal });

  const layout = useQuery({
    queryKey: ["fitting", "layout", fit?.shipTypeId],
    queryFn: () => fittingShipLayout(fit!.shipTypeId),
    enabled: fit != null,
  });

  // Re-run validation whenever the fit changes (its JSON is the cache key).
  const fitKey = useMemo(() => (fit ? JSON.stringify(fit) : ""), [fit]);
  const stats = useQuery({
    queryKey: ["fitting", "simulate", fitKey],
    queryFn: () => fittingSimulate(fit!),
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
  const exportEft = useMutation({
    mutationFn: () => fittingExportEft(fit!),
    onSuccess: (text) => {
      navigator.clipboard?.writeText(text).catch(() => {});
      setEft(text);
    },
  });

  function pickShip(id: number, name: string) {
    setQuery("");
    setFit({ id: "", name: `${name} fit`, shipTypeId: id, items: [] });
  }

  async function loadSaved(id: string) {
    const f = await fittingLoadLocal(id);
    if (f) setFit(f);
  }

  return (
    <div className="flex h-full flex-col gap-4 p-4">
      <header>
        <h1 className="text-lg font-semibold text-zinc-100">Fitting</h1>
        <p className="text-sm text-zinc-400">
          Build a fit, validate slots and resources, and price it. Import or export EFT.
        </p>
      </header>

      {/* Ship picker + EFT import */}
      <div className="flex flex-wrap items-end gap-3">
        <div className="relative">
          <label className="flex flex-col gap-1 text-xs text-zinc-400">
            Ship
            <input
              value={query}
              onChange={(e) => setQuery(e.currentTarget.value)}
              placeholder="search a hull…"
              className="w-56 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
            />
          </label>
          {query.trim().length >= 2 && (results.data?.length ?? 0) > 0 && (
            <div className="absolute z-10 mt-1 max-h-60 w-56 overflow-auto rounded border border-zinc-700 bg-zinc-900 text-sm shadow-lg">
              {results.data!.map((r) => (
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
      </div>

      <div className="flex items-start gap-2">
        <textarea
          value={eft}
          onChange={(e) => setEft(e.currentTarget.value)}
          placeholder="paste an EFT fit here…"
          className="h-20 w-96 rounded bg-zinc-800 px-2 py-1 font-mono text-xs text-zinc-100 outline-none placeholder:text-zinc-500"
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
        <Centered>Pick a hull or import an EFT fit to begin.</Centered>
      ) : (
        <div className="flex min-h-0 flex-1 gap-4">
          {/* Left: slots */}
          <section className="min-w-0 flex-1 overflow-auto">
            <div className="mb-2 flex items-center gap-2">
              <h2 className="font-medium text-zinc-200">
                {layout.data?.name ?? "Ship"} — {fit.name}
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
            {layout.data && (
              <SlotSummary fit={fit} layout={layout.data} />
            )}
          </section>

          {/* Right: stats */}
          <aside className="w-72 shrink-0 space-y-4 overflow-auto">
            {stats.data && (
              <div className="space-y-2">
                <h3 className="text-xs uppercase tracking-wide text-zinc-500">Resources</h3>
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
                <h3 className="text-xs uppercase tracking-wide text-zinc-500">
                  DPS (all V)
                </h3>
                <div className="text-sm text-zinc-300">
                  {stats.data.dps.total.toFixed(1)} dps
                </div>
                <div className="text-xs text-zinc-500">
                  {stats.data.dps.turret > 0 &&
                    `turret ${stats.data.dps.turret.toFixed(1)} `}
                  {stats.data.dps.missile > 0 &&
                    `· missile ${stats.data.dps.missile.toFixed(1)} `}
                  {stats.data.dps.drone > 0 &&
                    `· drone ${stats.data.dps.drone.toFixed(1)}`}
                </div>
              </div>
            )}

            {stats.data?.tank && (
              <div className="space-y-1">
                <h3 className="text-xs uppercase tracking-wide text-zinc-500">
                  Tank (all V)
                </h3>
                <div className="text-sm text-zinc-300">
                  {Math.round(stats.data.tank.ehp).toLocaleString()} EHP
                </div>
                <div className="text-xs text-zinc-500">
                  S {Math.round(stats.data.tank.shieldHp)} · A{" "}
                  {Math.round(stats.data.tank.armorHp)} · H{" "}
                  {Math.round(stats.data.tank.hullHp)}
                  {(stats.data.tank.shieldRepS > 0 ||
                    stats.data.tank.armorRepS > 0) && (
                    <>
                      {" "}
                      · reps{" "}
                      {(
                        stats.data.tank.shieldRepS + stats.data.tank.armorRepS
                      ).toFixed(1)}
                      /s
                    </>
                  )}
                </div>
              </div>
            )}

            {stats.data?.navigation && (
              <div className="space-y-1">
                <h3 className="text-xs uppercase tracking-wide text-zinc-500">
                  Navigation (all V)
                </h3>
                <div className="text-xs text-zinc-400">
                  {Math.round(stats.data.navigation.maxVelocity)} m/s · align{" "}
                  {stats.data.navigation.alignTime.toFixed(1)}s · sig{" "}
                  {Math.round(stats.data.navigation.signatureRadius)}m
                </div>
              </div>
            )}

            {stats.data?.capacitor && (
              <div className="space-y-1">
                <h3 className="text-xs uppercase tracking-wide text-zinc-500">
                  Capacitor (all V)
                </h3>
                <div className="text-sm text-zinc-300">
                  {stats.data.capacitor.stable ? (
                    <span className="text-emerald-400">
                      Stable at {stats.data.capacitor.stablePct?.toFixed(1)}%
                    </span>
                  ) : (
                    <span className="text-red-400">Unstable</span>
                  )}
                </div>
                <div className="text-xs text-zinc-500">
                  {stats.data.capacitor.capacity.toFixed(0)} GJ ·{" "}
                  {stats.data.capacitor.rechargeSeconds.toFixed(0)}s · peak{" "}
                  {stats.data.capacitor.peakRecharge.toFixed(1)} / drain{" "}
                  {stats.data.capacitor.drain.toFixed(1)} GJ/s
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

            {(saved.data?.length ?? 0) > 0 && (
              <div className="space-y-1">
                <h3 className="text-xs uppercase tracking-wide text-zinc-500">Saved fits</h3>
                {saved.data!.map((f) => (
                  <div key={f.id} className="flex items-center justify-between text-sm">
                    <button
                      onClick={() => loadSaved(f.id)}
                      className="truncate text-left text-zinc-300 hover:text-zinc-100"
                    >
                      {f.name}
                    </button>
                    <button
                      onClick={() => del.mutate(f.id)}
                      className="ml-2 text-xs text-zinc-500 hover:text-red-400"
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
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

/** Items grouped by slot, with the hull's slot counts for context. */
function SlotSummary({
  fit,
  layout,
}: {
  fit: Fit;
  layout: { highSlots: number; midSlots: number; lowSlots: number; rigSlots: number };
}) {
  const bySlot = (slot: SlotKind): FitItem[] =>
    fit.items.filter((i) => i.slot === slot).sort((a, b) => a.index - b.index);
  const counts: Partial<Record<SlotKind, number>> = {
    high: layout.highSlots,
    mid: layout.midSlots,
    low: layout.lowSlots,
    rig: layout.rigSlots,
  };
  return (
    <div className="space-y-3">
      {SLOT_LABELS.map(([slot, label]) => {
        const items = bySlot(slot);
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
                {items.map((it, i) => (
                  <li key={i}>
                    Type {it.typeId}
                    {it.chargeTypeId ? ` + ${it.chargeTypeId}` : ""}
                    {it.quantity > 1 ? ` x${it.quantity}` : ""}
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
