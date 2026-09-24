import { useMemo, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, X } from "lucide-react";
import {
  fittingDeleteTargetProfile,
  fittingSaveTargetProfile,
  fittingTargetProfiles,
  type NpcProfile,
  type TargetProfile,
} from "../../lib/api";
import { useFitState } from "./useFitEditorContext";

/** Generic hull-class presets: a starting point for a target with no
 *  specific NPC/ship identity — not fetched from the SDE, since they're not
 *  meant to represent any real ship, just "something frigate-sized". Grouped
 *  under "Generic" alongside the SDE-derived faction/content presets from
 *  `fittingTargetProfiles` (#873). `dronesKeepPace: true` matches PYFA's
 *  default "auto" drone mode. */
const GENERIC_PRESETS: [string, TargetProfile][] = [
  [
    "Frigate",
    {
      sigRadius: 40,
      speed: 400,
      angularVelocity: 0.04,
      dronesKeepPace: true,
      missilesNeedOvertake: false,
    },
  ],
  [
    "Destroyer",
    {
      sigRadius: 60,
      speed: 300,
      angularVelocity: 0.02,
      dronesKeepPace: true,
      missilesNeedOvertake: false,
    },
  ],
  [
    "Cruiser",
    {
      sigRadius: 130,
      speed: 250,
      angularVelocity: 0.01,
      dronesKeepPace: true,
      missilesNeedOvertake: false,
    },
  ],
  [
    "Battlecruiser",
    {
      sigRadius: 280,
      speed: 180,
      angularVelocity: 0.005142857142857143,
      dronesKeepPace: true,
      missilesNeedOvertake: false,
    },
  ],
  [
    "Battleship",
    {
      sigRadius: 450,
      speed: 120,
      angularVelocity: 0.0024,
      dronesKeepPace: true,
      missilesNeedOvertake: false,
    },
  ],
];

/** One flattened, filterable/groupable preset option. */
interface Option {
  kind: string;
  label: string;
  target: TargetProfile;
  custom?: NpcProfile;
}

/**
 * The target profile driving applied DPS and the DPS-vs-range curve (#701):
 * signature radius, velocity (compared against a missile's explosion
 * velocity), and angular velocity (rad/s, drives turret/drone tracking loss
 * directly — no more worst-case derivation from speed ÷ distance). Falloff
 * and missile-range gating come from the DPS-vs-range curve sweeping
 * distance separately, so this box has no distance field. The preset
 * dropdown (#873) is searchable and grouped by faction/content-type, sourced
 * from real SDE NPC ship data plus any user-saved custom presets; manual
 * entry (the number fields below) is always available and preserved as
 * "Custom" when saved.
 */
export function TargetProfileBox() {
  const {
    targetProfile: value,
    setTargetProfile: onChange,
    damageProfile,
  } = useFitState();
  const queryClient = useQueryClient();
  const library = useQuery({
    queryKey: ["fitting", "targetProfiles"],
    queryFn: fittingTargetProfiles,
  });
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [saveName, setSaveName] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const options: Option[] = [
      ...GENERIC_PRESETS.map(([label, target]) => ({
        kind: "Generic",
        label,
        target,
      })),
      ...(library.data?.builtIn ?? []).map((p) => ({
        kind: p.group,
        label: p.label,
        target: p.target,
      })),
      ...(library.data?.custom ?? []).map((p) => ({
        kind: "Custom",
        label: p.label,
        target: p.target,
        custom: p,
      })),
    ];
    const needle = q.trim().toLowerCase();
    const filtered = needle
      ? options.filter(
          (o) =>
            o.label.toLowerCase().includes(needle) ||
            o.kind.toLowerCase().includes(needle),
        )
      : options;
    const byKind = new Map<string, Option[]>();
    for (const o of filtered)
      byKind.set(o.kind, [...(byKind.get(o.kind) ?? []), o]);
    return [...byKind.entries()];
  }, [library.data, q]);

  function pick(o: Option) {
    onChange(o.target);
    setOpen(false);
  }
  function clear() {
    onChange(undefined);
    setOpen(false);
  }
  async function removeCustom(id: string) {
    await fittingDeleteTargetProfile(id);
    await queryClient.invalidateQueries({
      queryKey: ["fitting", "targetProfiles"],
    });
  }
  async function saveCurrent() {
    if (!saveName?.trim() || !value) return;
    await fittingSaveTargetProfile({
      id: "",
      label: saveName.trim(),
      group: "Custom",
      target: value,
      damageProfile: damageProfile ?? [0.25, 0.25, 0.25, 0.25],
    });
    setSaveName(null);
    await queryClient.invalidateQueries({
      queryKey: ["fitting", "targetProfiles"],
    });
  }

  const set = (patch: Partial<TargetProfile>) => {
    const base: TargetProfile = value ?? {
      sigRadius: 0,
      speed: 0,
      angularVelocity: 0,
      dronesKeepPace: true,
      missilesNeedOvertake: false,
    };
    onChange({ ...base, ...patch });
  };

  return (
    <div className="relative mt-4 rounded border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="mb-2 flex items-center justify-between text-xs uppercase tracking-wide text-zinc-500">
        Target
        <button
          onClick={() => setOpen((o) => !o)}
          className={`flex items-center gap-1 rounded px-1.5 py-0.5 normal-case ${
            value != null
              ? "text-amber-400 hover:text-amber-300"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          <span className="max-w-32 truncate">
            {value != null ? "Preset / Custom" : "None"}
          </span>
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
              placeholder="filter (guristas, sleeper, frigate…)"
              className="mb-1 w-full rounded bg-zinc-800 px-2 py-1 text-xs text-zinc-100 outline-none placeholder:text-zinc-500"
            />
            {value != null && (
              <button
                onClick={clear}
                className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-zinc-400 hover:bg-zinc-800"
              >
                <X size={12} /> None
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
                      key={`${o.kind}-${o.label}`}
                      className="flex items-center"
                    >
                      <button
                        onClick={() => pick(o)}
                        className="block w-full truncate rounded px-2 py-1 text-left text-xs text-zinc-200 hover:bg-zinc-800"
                      >
                        {o.label}
                      </button>
                      {o.custom && (
                        <button
                          onClick={() => removeCustom(o.custom!.id)}
                          title="Delete this custom preset"
                          className="shrink-0 rounded px-1 text-zinc-600 hover:text-red-400"
                        >
                          <X size={10} />
                        </button>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            ))}
            {library.isFetched && grouped.length === 0 && (
              <div className="px-2 py-1 text-xs text-zinc-500">No matches.</div>
            )}
          </div>
        </>
      )}
      {value == null ? (
        <p className="text-xs text-zinc-500">
          No target — pick a preset or set custom fields to see applied DPS.
        </p>
      ) : (
        <div className="grid grid-cols-3 gap-2 text-xs">
          <Field label="Sig radius (m)">
            <input
              type="number"
              min="0"
              value={value.sigRadius}
              onChange={(e) =>
                set({ sigRadius: Number(e.currentTarget.value) })
              }
              className="w-full rounded bg-zinc-800 px-2 py-1 text-zinc-100 outline-none"
            />
          </Field>
          <Field label="Velocity (m/s)">
            <input
              type="number"
              min="0"
              value={value.speed}
              onChange={(e) => set({ speed: Number(e.currentTarget.value) })}
              className="w-full rounded bg-zinc-800 px-2 py-1 text-zinc-100 outline-none"
            />
          </Field>
          <Field
            label="Angular vel. (rad/s)"
            title="Drives tracking loss directly — falloff comes from the DPS-vs-range curve, not this box."
          >
            <input
              type="number"
              min="0"
              step="0.001"
              value={value.angularVelocity}
              onChange={(e) =>
                set({ angularVelocity: Number(e.currentTarget.value) })
              }
              className="w-full rounded bg-zinc-800 px-2 py-1 text-zinc-100 outline-none"
            />
          </Field>
        </div>
      )}
      {value != null && (
        <div className="mt-2 space-y-1 text-xs text-zinc-400">
          <label
            className="flex items-center gap-2"
            title="Drones at or above the target's speed assume perfect application instead of running the tracking formula — PYFA's &quot;auto&quot; drone mode."
          >
            <input
              type="checkbox"
              checked={value.dronesKeepPace}
              onChange={(e) => set({ dronesKeepPace: e.currentTarget.checked })}
              className="accent-amber-500"
            />
            Drones keep pace with the target
          </label>
          <label
            className="flex items-center gap-2"
            title="Missiles slower than the target's own speed can never catch it — zero application. Not modeled by PYFA."
          >
            <input
              type="checkbox"
              checked={value.missilesNeedOvertake}
              onChange={(e) =>
                set({ missilesNeedOvertake: e.currentTarget.checked })
              }
              className="accent-amber-500"
            />
            Missiles must outrun the target
          </label>
          {saveName == null ? (
            <button
              onClick={() => setSaveName("")}
              className="text-zinc-500 underline decoration-dotted hover:text-zinc-300"
            >
              Save current as custom preset…
            </button>
          ) : (
            <div className="flex items-center gap-1">
              <input
                autoFocus
                value={saveName}
                onChange={(e) => setSaveName(e.currentTarget.value)}
                onKeyDown={(e) => e.key === "Enter" && saveCurrent()}
                placeholder="preset name"
                className="w-full rounded bg-zinc-800 px-2 py-1 text-zinc-100 outline-none placeholder:text-zinc-500"
              />
              <button
                onClick={saveCurrent}
                className="shrink-0 rounded bg-amber-600/80 px-2 py-1 text-zinc-100 hover:bg-amber-600"
              >
                Save
              </button>
              <button
                onClick={() => setSaveName(null)}
                className="shrink-0 text-zinc-500 hover:text-zinc-300"
              >
                <X size={12} />
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Field({
  label,
  title,
  children,
}: {
  label: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-0.5" title={title}>
      <span className="text-[10px] uppercase tracking-wide text-zinc-500">
        {label}
      </span>
      {children}
    </label>
  );
}
