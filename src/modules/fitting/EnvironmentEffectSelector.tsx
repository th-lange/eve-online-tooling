import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, X } from "lucide-react";
import {
  fittingEnvironmentEffects,
  type AbyssalWeather,
  type AbyssalWeatherSelection,
} from "../../lib/api";

/** Split a beacon's raw SDE name into a display group + short label:
 *  "Class 3 Pulsar Effects" -> Wormhole / "Class 3 Pulsar";
 *  "Strong Metaliminal Electrical Storm" -> Pochven: / "Electrical — Strong".
 *  Metaliminal storms are a Pochven/nullsec mechanic, not Abyssal Deadspace
 *  weather (which has no static dogma data — see [`ABYSSAL_WEATHERS`] below,
 *  a hardcoded path).
 *  Note "Plasma Firestorm" has no trailing " Storm" word (it's baked into
 *  "Firestorm" itself) — strip a trailing " Storm" only if present, don't
 *  require it, or Firestorm silently falls out of the group. */
function classify(name: string): { kind: string; label: string } {
  const wormhole = /^Class (\d) (.+) Effects$/.exec(name);
  if (wormhole)
    return { kind: "Wormhole", label: `Class ${wormhole[1]} ${wormhole[2]}` };
  const pochven = /^(Weak|Strong) Metaliminal (.+)$/.exec(name);
  if (pochven) {
    const weather = pochven[2].replace(/ Storm$/, "");
    return { kind: "Pochven:", label: `${weather} — ${pochven[1]}` };
  }
  return { kind: "Other", label: name };
}

/** Abyssal Deadspace weather + its three filament-tier penalty magnitudes
 *  (30/50/70%) — hardcoded from community reference data, not the SDE (see
 *  [`AbyssalWeatherSelection`]'s doc for the full bonus/penalty table). */
const ABYSSAL_WEATHERS: { id: AbyssalWeather; label: string }[] = [
  { id: "dark", label: "Dark" },
  { id: "electrical", label: "Electrical" },
  { id: "exotic", label: "Exotic" },
  { id: "firestorm", label: "Firestorm" },
  { id: "gamma", label: "Gamma" },
];
const ABYSSAL_TIERS = [30, 50, 70];

/** One entry in the flattened, filterable option list — either an SDE-backed
 *  beacon (wormhole/Pochven) or a static Abyssal weather+tier pair. */
type Option =
  | { source: "sde"; id: number; kind: string; label: string }
  | {
      source: "abyssal";
      weather: AbyssalWeather;
      tierPct: number;
      kind: "Abyssal:";
      label: string;
    };

/**
 * Selects the "environment" a fit is sitting in — a wormhole class, a
 * Pochven metaliminal storm (both dogma-driven beacon effects fetched from
 * the SDE), or an Abyssal Deadspace weather (a separate, hardcoded
 * bonus/penalty pair — Abyssal weather has no dogma-attribute data in the
 * SDE at all). The two are mutually exclusive: a fit is never in two spaces
 * at once, so this is a single-choice picker, not a growable list like
 * [`FleetBoostsPanel`].
 */
export function EnvironmentEffectSelector({
  value,
  onChange,
  abyssalWeather,
  onAbyssalWeather,
}: {
  value: number | null;
  onChange: (id: number | null) => void;
  abyssalWeather: AbyssalWeatherSelection | null;
  onAbyssalWeather: (selection: AbyssalWeatherSelection | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const options = useQuery({
    queryKey: ["fitting", "environmentEffects"],
    queryFn: fittingEnvironmentEffects,
  });
  const all = options.data ?? [];
  const selectedName =
    value != null
      ? (all.find((o) => o.id === value)?.name ?? `#${value}`)
      : abyssalWeather != null
        ? `${abyssalWeather.weather} — ${abyssalWeather.tierPct}%`
        : "None";

  const grouped = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const sdeOptions: Option[] = (options.data ?? []).map((o) => ({
      source: "sde",
      id: o.id,
      ...classify(o.name),
    }));
    const abyssalOptions: Option[] = ABYSSAL_WEATHERS.flatMap((w) =>
      ABYSSAL_TIERS.map((tierPct) => ({
        source: "abyssal" as const,
        weather: w.id,
        tierPct,
        kind: "Abyssal:" as const,
        label: `${w.label} — ${tierPct}%`,
      })),
    );
    const classified = [...sdeOptions, ...abyssalOptions];
    const filtered = needle
      ? classified.filter(
          (o) =>
            o.label.toLowerCase().includes(needle) ||
            o.kind.toLowerCase().includes(needle),
        )
      : classified;
    const byKind = new Map<string, typeof filtered>();
    for (const o of filtered)
      byKind.set(o.kind, [...(byKind.get(o.kind) ?? []), o]);
    for (const opts of byKind.values())
      opts.sort((a, b) => a.label.localeCompare(b.label));
    return [...byKind.entries()];
  }, [options.data, q]);

  function pick(o: Option) {
    if (o.source === "sde") onChange(o.id);
    else onAbyssalWeather({ weather: o.weather, tierPct: o.tierPct });
    setOpen(false);
  }
  function clear() {
    onChange(null);
    onAbyssalWeather(null);
    setOpen(false);
  }
  const isSelected = (o: Option) =>
    o.source === "sde"
      ? o.id === value
      : abyssalWeather?.weather === o.weather &&
        abyssalWeather?.tierPct === o.tierPct;

  return (
    <div className="relative mt-4 rounded border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="flex items-center justify-between text-xs uppercase tracking-wide text-zinc-500">
        Environment
        <button
          onClick={() => setOpen((o) => !o)}
          title="Simulate a wormhole, Pochven metaliminal storm, or Abyssal Deadspace weather effect on this fit"
          className={`flex items-center gap-1 rounded px-1.5 py-0.5 normal-case ${
            value != null || abyssalWeather != null
              ? "text-amber-400 hover:text-amber-300"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          <span className="max-w-40 truncate">{selectedName}</span>
          <ChevronDown size={12} />
        </button>
      </div>
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-3 z-20 mt-1 max-h-80 w-72 overflow-y-auto rounded border border-zinc-700 bg-zinc-900 p-1 shadow-lg">
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.currentTarget.value)}
              placeholder="filter (pulsar, magnetar, electrical…)"
              className="mb-1 w-full rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-100 outline-none placeholder:text-zinc-500"
            />
            {(value != null || abyssalWeather != null) && (
              <button
                onClick={clear}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-zinc-400 hover:bg-zinc-800"
              >
                <X size={12} /> None (no environment)
              </button>
            )}
            {grouped.map(([kind, opts]) => (
              <div key={kind}>
                <div className="mt-1 px-2 text-[10px] uppercase tracking-wide text-zinc-500">
                  {kind}
                </div>
                <ul>
                  {opts.map((o) => (
                    <li
                      key={
                        o.source === "sde"
                          ? `sde-${o.id}`
                          : `${o.weather}-${o.tierPct}`
                      }
                    >
                      <button
                        onClick={() => pick(o)}
                        className={`block w-full truncate rounded px-2 py-1 text-left text-xs hover:bg-zinc-800 ${
                          isSelected(o) ? "text-amber-400" : "text-zinc-200"
                        }`}
                      >
                        {o.label}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {options.isFetched && grouped.length === 0 && (
              <div className="px-2 py-1 text-xs text-zinc-500">No matches.</div>
            )}
          </div>
        </>
      )}
    </div>
  );
}
