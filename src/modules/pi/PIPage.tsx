import { useEffect, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  errorMessage,
  isAuthRequired,
  piLockedGet,
  piLockedSet,
  piOverview,
  piShowInGame,
  sdeStatus,
  type BalanceRow,
  type ColonyView,
  type ExtractorView,
  type StorageView,
} from "../../lib/api";
import { SdeSetup } from "../production/SdeSetup";
import { formatInt } from "../../lib/format";

export function PIPage() {
  const status = useQuery({ queryKey: ["sde", "status"], queryFn: sdeStatus });
  if (status.isLoading) return <Centered>Checking static data…</Centered>;
  if (!status.data?.installed)
    return <SdeSetup onInstalled={() => status.refetch()} />;
  return <Workbench />;
}

function Workbench() {
  const qc = useQueryClient();
  const colonies = useQuery({
    queryKey: ["pi", "overview"],
    queryFn: piOverview,
  });
  const locked = useQuery({ queryKey: ["pi", "locked"], queryFn: piLockedGet });
  const lockedSet = new Set(locked.data ?? []);

  const setLock = useMutation({
    mutationFn: (ids: number[]) => piLockedSet(ids),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pi", "locked"] }),
  });
  const toggleLock = (typeId: number) => {
    const next = new Set(lockedSet);
    next.has(typeId) ? next.delete(typeId) : next.add(typeId);
    setLock.mutate([...next]);
  };

  // Tick so extractor restart countdowns stay live (minute granularity is plenty).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(id);
  }, []);

  const rows = colonies.data ?? [];

  return (
    <div className="p-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-100">
            Planetary Interaction
          </h1>
          <p className="mt-1 text-sm text-zinc-400">
            Your colonies — what's extracting/producing, when extractors need a
            restart, storage usage, and where inputs fall short.
          </p>
        </div>
        <button
          onClick={() => colonies.refetch()}
          disabled={colonies.isFetching}
          className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {colonies.isFetching ? "Loading…" : "Refresh"}
        </button>
      </div>

      {colonies.isError &&
        (isAuthRequired(colonies.error) ? (
          <div className="mt-4 text-sm text-zinc-400">
            Log in a character first to view your colonies.
          </div>
        ) : (
          <div className="mt-4 text-sm text-rose-400">
            {errorMessage(colonies.error)}
            <span className="ml-1 text-zinc-500">
              (needs <code>esi-planets.manage_planets.v1</code> — re-login if
              just enabled)
            </span>
          </div>
        ))}

      {!colonies.isError && rows.length === 0 && !colonies.isFetching && (
        <Centered>No colonies found for this character.</Centered>
      )}

      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        {rows.map((c) => (
          <Colony
            key={c.planetId}
            colony={c}
            now={now}
            lockedSet={lockedSet}
            onToggleLock={toggleLock}
          />
        ))}
      </div>
    </div>
  );
}

function Colony({
  colony,
  now,
  lockedSet,
  onToggleLock,
}: {
  colony: ColonyView;
  now: number;
  lockedSet: Set<number>;
  onToggleLock: (typeId: number) => void;
}) {
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
          onClick={() => piShowInGame(colony.systemId).catch(() => {})}
          title="Set autopilot to this colony's system — ESI can't open a planet/system Show Info window directly"
          className="ml-auto rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800"
        >
          Route here ↗
        </button>
      </div>

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
        <Section title="Required vs available (per hour)">
          <Balance rows={colony.balance} />
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
    </div>
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

const EPS = 0.0001;

/** Total units and stored volume of a type id across a colony's storage pins. */
function stockMaps(colony: ColonyView) {
  const stock = new Map<number, number>();
  const volume = new Map<number, number>();
  for (const s of colony.storage) {
    for (const c of s.contents) {
      stock.set(c.typeId, (stock.get(c.typeId) ?? 0) + c.amount);
      volume.set(c.typeId, (volume.get(c.typeId) ?? 0) + c.volume);
    }
  }
  return { stock, volume };
}

/** A commodity is "banking" (worth easing off) once it alone ties up this much
 *  of the colony's total storage capacity, even if its instantaneous balance
 *  isn't net-positive (e.g. a starved factory stopped consuming it). */
const BANK_VOLUME_SHARE = 0.15;

/** Recommend how to re-aim extraction next cycle. Balance `net` (produced −
 *  consumed per hour) alone only says which way a commodity is trending — it
 *  misses that PI is bursty: what actually matters next cycle is what's about
 *  to run OUT (a near-empty stock drains fast even off a mild deficit) versus
 *  what's already piled up (a big stockpile means "stop feeding it" even if
 *  its rate looks balanced, e.g. a factory stalled on a missing input). So:
 *  - "feed": net-negative inputs, ranked by runway (stock ÷ deficit) — lowest
 *    runway (closest to empty) first, regardless of how large the deficit is.
 *  - "ease off": extracted P0s that are either net-positive OR already
 *    hogging a big share of colony storage, ranked by stockpile size.
 */
export function extractionAdvice(colony: ColonyView) {
  const extracted = new Set(colony.extractors.map((e) => e.productTypeId));
  const { stock, volume } = stockMaps(colony);
  const totalCapacity =
    colony.storage.reduce((sum, s) => sum + s.capacity, 0) || 1;

  const short = colony.balance
    .filter((b) => b.net < -EPS)
    .map((b) => {
      const onHand = stock.get(b.typeId) ?? 0;
      return { ...b, stock: onHand, runwayHours: onHand / -b.net };
    })
    .sort((a, b) => a.runwayHours - b.runwayHours);

  const over = colony.balance
    .filter((b) => {
      if (!extracted.has(b.typeId)) return false;
      const share = (volume.get(b.typeId) ?? 0) / totalCapacity;
      return b.net > EPS || share > BANK_VOLUME_SHARE;
    })
    .map((b) => ({ ...b, stock: stock.get(b.typeId) ?? 0 }))
    .sort((a, b) => b.stock - a.stock || b.net - a.net);

  return { short, over };
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

function Balance({ rows }: { rows: BalanceRow[] }) {
  return (
    <table className="w-full text-xs">
      <thead className="text-zinc-500">
        <tr>
          <th className="py-0.5 text-left font-medium">Commodity</th>
          <th className="py-0.5 text-right font-medium">Made</th>
          <th className="py-0.5 text-right font-medium">Used</th>
          <th className="py-0.5 text-right font-medium">Net</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
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
                r.net < -0.0001
                  ? "text-rose-400"
                  : r.net > 0.0001
                    ? "text-emerald-400"
                    : "text-zinc-500"
              }`}
            >
              {r.net > 0 ? "+" : ""}
              {fmt(r.net)}
            </td>
          </tr>
        ))}
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

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="p-10 text-center text-sm text-zinc-500">{children}</div>
  );
}
