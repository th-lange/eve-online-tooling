import { useState } from "react";
import {
  errorMessage,
  piShowInGame,
  type ColonyView,
  type ExtractorView,
  type StorageView,
} from "../../lib/api";
import { InlineError } from "../../components/InlineError";
import { formatInt } from "../../lib/format";
import {
  EPS,
  countdown,
  extractionAdvice,
  fmt,
  programRemainingPct,
  runway,
  runwayThresholds,
  stockMaps,
} from "./balance";
import { ColonyNotes } from "./ColonyNotes";
import { ColonyReminderButton } from "./ColonyReminderButton";
import { Section } from "./Section";

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

function Balance({ colony }: { colony: ColonyView }) {
  const { stock } = stockMaps(colony);
  const thresholds = runwayThresholds(colony, Date.now());
  return (
    <table className="w-full text-xs">
      <thead className="text-zinc-500">
        <tr>
          <th className="py-0.5 text-left font-medium">Commodity</th>
          <th className="py-0.5 text-right font-medium">Made/h</th>
          <th className="py-0.5 text-right font-medium">Used/h</th>
          <th className="py-0.5 text-right font-medium">Net/h</th>
          <th className="py-0.5 text-right font-medium">On hand</th>
          <th className="py-0.5 text-right font-medium">Runway</th>
        </tr>
      </thead>
      <tbody>
        {colony.balance.map((r) => {
          const onHand = stock.get(r.typeId) ?? 0;
          const rw = runway(onHand, r.net, thresholds);
          return (
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
                  r.net < -EPS
                    ? "text-rose-400"
                    : r.net > EPS
                      ? "text-emerald-400"
                      : "text-zinc-500"
                }`}
              >
                {r.net > 0 ? "+" : ""}
                {fmt(r.net)}
              </td>
              <td className="py-0.5 text-right tabular-nums text-zinc-400">
                {formatInt(Math.round(onHand))}
              </td>
              <td
                className={`py-0.5 text-right tabular-nums font-medium ${rw.tone}`}
                title={rw.title}
              >
                {rw.label}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

function Colony({
  colony,
  now,
  lockedSet,
  onToggleLock,
  showCharacter,
  onSaveNotes,
}: {
  colony: ColonyView;
  now: number;
  lockedSet: Set<number>;
  onToggleLock: (typeId: number) => void;
  showCharacter: boolean;
  onSaveNotes: (
    characterId: number,
    planetId: number,
    notes: string,
    targetProductTypeIds: number[],
  ) => void;
}) {
  const [routeError, setRouteError] = useState<string | null>(null);
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
        {showCharacter && (
          <span className="text-[11px] text-zinc-500">
            {colony.characterName}
          </span>
        )}
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
        <div className="ml-auto flex items-center gap-2">
          <ColonyReminderButton colony={colony} />
          <button
            onClick={() =>
              piShowInGame(colony.systemId)
                .then(() => setRouteError(null))
                .catch((e) => {
                  console.error("Failed to set route to colony system", e);
                  setRouteError(`Couldn't set route: ${errorMessage(e)}`);
                })
            }
            title="Set autopilot to this colony's system — ESI can't open a planet/system Show Info window directly"
            className="rounded border border-zinc-700 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800"
          >
            Route here ↗
          </button>
        </div>
      </div>
      <InlineError
        message={routeError}
        className="mt-1 text-xs text-rose-400"
      />

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
        <Section title="Required vs available · runway">
          <Balance colony={colony} />
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

      <ColonyNotes colony={colony} onSave={onSaveNotes} />
    </div>
  );
}

export { Colony };
