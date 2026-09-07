import type { ReactNode } from "react";
import type { TargetProfile } from "../../lib/api";

/** Presets: [label, profile]. `angularVelocity` is the old speed÷distance
 *  worst-case derivation, kept as a starting point for the custom fields.
 *  `dronesKeepPace: true` matches PYFA's default "auto" drone mode. */
const TARGET_PRESETS: [string, TargetProfile | null][] = [
  ["None", null],
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

/**
 * The target profile driving applied DPS and the DPS-vs-range curve (#701):
 * signature radius, velocity (compared against a missile's explosion
 * velocity), and angular velocity (rad/s, drives turret/drone tracking loss
 * directly — no more worst-case derivation from speed ÷ distance). Falloff
 * and missile-range gating come from the DPS-vs-range curve sweeping
 * distance separately, so this box has no distance field.
 */
export function TargetProfileBox({
  value,
  onChange,
}: {
  value: TargetProfile | undefined;
  onChange: (t: TargetProfile | undefined) => void;
}) {
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
    <div className="mt-4 rounded border border-zinc-800 bg-zinc-900/40 p-3">
      <div className="mb-2 flex items-center justify-between text-xs uppercase tracking-wide text-zinc-500">
        Target
        <select
          value={value ? JSON.stringify(value) : ""}
          onChange={(e) =>
            onChange(
              e.currentTarget.value
                ? (JSON.parse(e.currentTarget.value) as TargetProfile)
                : undefined,
            )
          }
          className="rounded bg-zinc-800 px-2 py-1 normal-case text-zinc-100"
        >
          {TARGET_PRESETS.map(([label, profile]) => (
            <option key={label} value={profile ? JSON.stringify(profile) : ""}>
              {label}
            </option>
          ))}
        </select>
      </div>
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
    <label className="space-y-0.5" title={title}>
      <div className="text-[10px] uppercase tracking-wide text-zinc-500">
        {label}
      </div>
      {children}
    </label>
  );
}
