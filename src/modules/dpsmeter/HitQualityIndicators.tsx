import type { HitQuality } from "../../lib/api";
import { formatInt } from "../../lib/format";

/** Hit-quality tiers worst→best, with the colour each segment gets in the
 *  per-combatant distribution bar. Keys match {@link HitQuality}. */
export const QUALITY_TIERS = [
  { key: "misses", label: "Miss", color: "#6b7280" },
  { key: "glances", label: "Glance", color: "#94a3b8" },
  { key: "grazes", label: "Graze", color: "#38bdf8" },
  { key: "hits", label: "Hit", color: "#22d3ee" },
  { key: "penetrates", label: "Pen", color: "#34d399" },
  { key: "smashes", label: "Smash", color: "#a3e635" },
  { key: "wrecks", label: "Wreck", color: "#f472b6" },
] as const satisfies readonly {
  key: keyof HitQuality;
  label: string;
  color: string;
}[];

/** Compact stacked bar of a combatant's hit-quality distribution, worst
 *  (left) → best (right), with a labelled legend of the present tiers below
 *  (colour dot + name + count) so the tiers read clearly and aren't mistaken
 *  for damage-type badges. Renders nothing when there were no tracked hits. */
export function QualityBar({ q }: { q?: HitQuality }) {
  if (!q) return null;
  const total = QUALITY_TIERS.reduce((s, t) => s + q[t.key], 0);
  if (total === 0) return null;
  const present = QUALITY_TIERS.filter((t) => q[t.key] > 0);
  return (
    <div className="mt-1">
      <span className="flex h-2 w-full overflow-hidden rounded-sm bg-zinc-800">
        {present.map((t) => (
          <span
            key={t.key}
            style={{
              width: `${(q[t.key] / total) * 100}%`,
              background: t.color,
            }}
          />
        ))}
      </span>
      <span className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[10px] tabular-nums text-zinc-400">
        {present.map((t) => (
          <span key={t.key} className="flex items-center gap-1">
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-[2px]"
              style={{ background: t.color }}
            />
            {t.label} {q[t.key]}
          </span>
        ))}
      </span>
    </div>
  );
}

/** Session peak + hit-quality indicators under a primary DPS readout.
 *  "pen"/"smash"/"wreck" count the high-quality hits inside the rolling
 *  window (from the gamelog's hit-quality suffix); dim when zero. */
export function PrimaryExtras({
  peak,
  quality,
}: {
  peak: number;
  quality?: HitQuality;
}) {
  const q = quality ?? { penetrates: 0, smashes: 0, wrecks: 0 };
  // The notable high-end tiers, drawn with the same colours as the QualityBar
  // so quality reads consistently and never like a damage-type badge.
  const notable = QUALITY_TIERS.filter(
    (t) => t.key === "penetrates" || t.key === "smashes" || t.key === "wrecks",
  );
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[11px] tabular-nums">
      <span className="text-zinc-500" title="Session peak">
        max {formatInt(Math.round(peak))}
      </span>
      {notable.map((t) => {
        const n = q[t.key];
        return (
          <span
            key={t.key}
            className={`flex items-center gap-1 ${n > 0 ? "text-zinc-300" : "text-zinc-600"}`}
            title={`${t.label}ing hits in the window`}
          >
            <span
              className="inline-block h-2 w-2 shrink-0 rounded-[2px]"
              style={{ background: n > 0 ? t.color : "#3f3f46" }}
            />
            {t.label} {n}
          </span>
        );
      })}
    </div>
  );
}
