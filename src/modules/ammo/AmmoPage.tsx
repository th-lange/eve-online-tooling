import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ammoReference,
  type AmmoFamily,
  type AmmoChargeRow,
  type AmmoTier,
} from "../../lib/api";
import { ammoKeys } from "../../lib/queryKeys";
import { QueryResult } from "../../components/QueryResult";
import { formatSignedPercent } from "../../lib/format";
import { usePersistentSort } from "../../lib/usePersistentSort";
import { DataTable, type SortColumn } from "../../components/DataTable";
import { Page, PageHeader } from "../../components/page";
import { SdeGate } from "../../components/SdeGate";

const TITLE = "Ammo";
const SUBTITLE =
  "Reference: small turret charges — damage, range and tracking multipliers.";

const FAMILIES: { value: AmmoFamily; label: string }[] = [
  { value: "hybrid", label: "Hybrid" },
  { value: "projectile", label: "Projectile" },
  { value: "laser", label: "Laser" },
];

const TIERS: { value: AmmoTier | "all"; label: string }[] = [
  { value: "all", label: "All" },
  { value: "T1", label: "T1" },
  { value: "Navy", label: "Navy" },
  { value: "T2", label: "T2" },
];

type RangeProfile = "all" | "long" | "neutral" | "short";
const RANGE_PROFILES: { value: RangeProfile; label: string }[] = [
  { value: "all", label: "All" },
  { value: "long", label: "Long range" },
  { value: "neutral", label: "Neutral" },
  { value: "short", label: "Short range" },
];

type TrackingProfile = "all" | "plus" | "neutral" | "minus";
const TRACKING_PROFILES: { value: TrackingProfile; label: string }[] = [
  { value: "all", label: "All" },
  { value: "plus", label: "Tracking +" },
  { value: "neutral", label: "Neutral" },
  { value: "minus", label: "Tracking −" },
];

/** Multipliers come from the SDE in clean steps (0.25, 0.5, 0.62, …), so a
 * small epsilon is enough to tell "exactly 1.0" from a real +/- bonus. */
const PROFILE_EPS = 0.01;

function rangeProfileOf(r: AmmoChargeRow): "long" | "neutral" | "short" {
  if (r.optimalMult > 1 + PROFILE_EPS) return "long";
  if (r.optimalMult < 1 - PROFILE_EPS) return "short";
  return "neutral";
}

function trackingProfileOf(r: AmmoChargeRow): "plus" | "neutral" | "minus" {
  if (r.trackingMult > 1 + PROFILE_EPS) return "plus";
  if (r.trackingMult < 1 - PROFILE_EPS) return "minus";
  return "neutral";
}

/** Short, family-specific gotchas that don't fit any column. */
const NOTES: Record<AmmoFamily, string[]> = {
  hybrid: [
    "Void and Null add a flat cap-use bonus on top of the shot's own capacitor cost — watch your cap chain when loading them.",
    "Blasters trade range for raw damage; railguns trade damage for range. Both share the same T1/Navy charge, but T2 (Void/Null, Javelin/Spike) locks a charge to one turret type.",
  ],
  projectile: [
    "T1 projectile ammo's range bonus (Hail, Barrage, …) only affects optimal range — autocannons have no optimal range to begin with, so it's a falloff-only change for them in practice.",
    "Projectile ammo never uses capacitor, so there's no cap-need column for this family.",
  ],
  laser: [
    "Crystals swap instantly (no reload animation) — T1 crystals never wear out, but T2 and faction crystals degrade with use and eventually break.",
    "Conflagration and Scorch add a flat cap-use bonus, same mechanic as the hybrid Void/Null pair.",
  ],
};

type SortKey =
  | "tier"
  | "name"
  | "totalDamage"
  | "optimalMult"
  | "falloffMult"
  | "trackingMult"
  | "capNeedBonusPct";

const COLUMNS: SortColumn<SortKey>[] = [
  {
    key: "tier",
    label: "Tier",
    numeric: false,
    description:
      "T1 (base), Navy (empire faction) or T2. Click to return to the default tier-grouped view.",
  },
  {
    key: "name",
    label: "Charge",
    numeric: false,
    description:
      "The charge's name, and the turret class it's restricted to (T2 only).",
  },
  {
    key: "totalDamage",
    label: "Damage",
    numeric: true,
    description:
      "Total base damage per shot (pre-skills, pre-modules) and its EM/Thermal/Kinetic/Explosive split.",
  },
  {
    key: "optimalMult",
    label: "Optimal",
    numeric: true,
    description: "Multiplier applied to the turret's base optimal range.",
  },
  {
    key: "falloffMult",
    label: "Falloff",
    numeric: true,
    description: "Multiplier applied to the turret's base falloff range.",
  },
  {
    key: "trackingMult",
    label: "Tracking",
    numeric: true,
    description: "Multiplier applied to the turret's base tracking speed.",
  },
];

const KEYS = COLUMNS.map((c) => c.key);

const TIER_ORDER: Record<AmmoTier, number> = { T1: 0, Navy: 1, T2: 2 };

const DMG_TYPES = ["em", "thermal", "kinetic", "explosive"] as const;
type DmgType = (typeof DMG_TYPES)[number];
const DMG_COLOR: Record<DmgType, string> = {
  em: "bg-sky-500",
  thermal: "bg-red-500",
  kinetic: "bg-zinc-400",
  explosive: "bg-amber-500",
};
const DMG_LABEL: Record<DmgType, string> = {
  em: "EM",
  thermal: "Th",
  kinetic: "Kin",
  explosive: "Exp",
};

function formatMult(v: number): string {
  return `×${v.toFixed(2)}`;
}

/** A small stacked damage-split bar, with a text breakdown alongside (not
 * color alone, #848) and the same breakdown as the hover tooltip. */
function DamageBar({ row }: { row: AmmoChargeRow }) {
  const total = row.totalDamage;
  const parts = DMG_TYPES.filter((k) => row[k] > 0);
  const breakdown = parts
    .map((k) => `${DMG_LABEL[k]} ${row[k].toFixed(1)}`)
    .join(" / ");
  return (
    <div className="flex flex-col gap-0.5" title={breakdown || "No damage"}>
      <div className="flex items-baseline gap-1.5">
        <span className="tabular-nums text-zinc-200">{total.toFixed(1)}</span>
        <span className="text-[11px] text-zinc-500">{breakdown}</span>
      </div>
      {total > 0 && (
        <div className="flex h-1.5 w-24 overflow-hidden rounded-sm bg-zinc-800">
          {parts.map((k) => (
            <div
              key={k}
              className={DMG_COLOR[k]}
              style={{ width: `${(row[k] / total) * 100}%` }}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function AmmoPage() {
  return (
    <SdeGate title={TITLE} subtitle={SUBTITLE}>
      <Workbench />
    </SdeGate>
  );
}

function FilterGroup<T extends string>({
  options,
  value,
  onChange,
  compact = false,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  /** Smaller padding/text — used for the secondary (tier/range/tracking) filters. */
  compact?: boolean;
}) {
  return (
    <div
      className={`flex overflow-hidden rounded border border-zinc-800 ${compact ? "text-xs" : "text-sm"}`}
    >
      {options.map(({ value: v, label }) => (
        <button
          key={v}
          onClick={() => onChange(v)}
          aria-pressed={value === v}
          className={`${compact ? "px-2.5 py-1.5" : "px-3 py-1.5"} ${
            value === v
              ? "bg-zinc-700 text-zinc-100"
              : "bg-zinc-900 text-zinc-500 hover:text-zinc-300"
          }`}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

function Workbench() {
  const [family, setFamily] = useState<AmmoFamily>("hybrid");
  const [tier, setTier] = useState<AmmoTier | "all">("all");
  const [range, setRange] = useState<RangeProfile>("all");
  const [tracking, setTracking] = useState<TrackingProfile>("all");

  const query = useQuery({
    queryKey: ammoKeys.reference(family),
    queryFn: () => ammoReference(family),
  });

  return (
    <Page>
      <PageHeader title={TITLE} subtitle={SUBTITLE} />

      <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
        <FilterGroup options={FAMILIES} value={family} onChange={setFamily} />
        <FilterGroup options={TIERS} value={tier} onChange={setTier} compact />
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-3">
        <FilterGroup
          options={RANGE_PROFILES}
          value={range}
          onChange={setRange}
          compact
        />
        <FilterGroup
          options={TRACKING_PROFILES}
          value={tracking}
          onChange={setTracking}
          compact
        />
      </div>

      <QueryResult
        result={query}
        pendingLabel="Loading charges…"
        emptyTitle="No charges found."
        isEmpty={(rows) => rows.length === 0}
      >
        {(rows) => (
          <AmmoTable
            family={family}
            rows={rows.filter(
              (r) =>
                (tier === "all" || r.tier === tier) &&
                (range === "all" || rangeProfileOf(r) === range) &&
                (tracking === "all" || trackingProfileOf(r) === tracking),
            )}
          />
        )}
      </QueryResult>

      <ul className="mt-6 space-y-1 text-xs text-zinc-500">
        {NOTES[family].map((note) => (
          <li key={note}>· {note}</li>
        ))}
      </ul>
    </Page>
  );
}

function AmmoTable({
  family,
  rows,
}: {
  family: AmmoFamily;
  rows: AmmoChargeRow[];
}) {
  const { sortKey, sortDir, toggleSort } = usePersistentSort<SortKey>(
    "sort.ammo",
    KEYS,
    "tier",
    "asc",
    ["tier", "name"],
  );

  const sorted = useMemo(() => {
    const dir = sortDir === "asc" ? 1 : -1;
    return [...rows].sort((a, b) => {
      if (sortKey === "tier") {
        const byTier = TIER_ORDER[a.tier] - TIER_ORDER[b.tier];
        return byTier !== 0 ? byTier : a.name.localeCompare(b.name);
      }
      if (sortKey === "name") return dir * a.name.localeCompare(b.name);
      return dir * ((a[sortKey] ?? 0) - (b[sortKey] ?? 0));
    });
  }, [rows, sortKey, sortDir]);

  const columns = family === "projectile" ? COLUMNS : [...COLUMNS, CAP_COLUMN];

  return (
    <DataTable
      className="mt-3 overflow-auto rounded border border-zinc-800"
      columns={columns}
      sortKey={sortKey}
      sortDir={sortDir}
      onSort={toggleSort}
      rows={sorted}
      demotedKeys={family === "projectile" ? [] : ["capNeedBonusPct"]}
      emptyState={
        <div className="p-6 text-center text-sm text-zinc-500">
          No charges match these filters.
        </div>
      }
      renderRow={(r) => (
        <tr
          key={r.typeId}
          className="border-t border-zinc-800 hover:bg-zinc-800/40"
        >
          <td className="px-3 py-1.5 text-zinc-400">{r.tier}</td>
          <td className="px-3 py-1.5">
            <span className="text-zinc-200">{r.name}</span>
            {r.turretClass && (
              <span className="ml-2 text-xs text-indigo-400">
                {r.turretClass} only
              </span>
            )}
          </td>
          <td className="px-3 py-1.5">
            <DamageBar row={r} />
          </td>
          <td className="px-3 py-1.5 text-right tabular-nums text-zinc-300">
            {formatMult(r.optimalMult)}
          </td>
          <td className="px-3 py-1.5 text-right tabular-nums text-zinc-300">
            {formatMult(r.falloffMult)}
          </td>
          <td className="px-3 py-1.5 text-right tabular-nums text-zinc-300">
            {formatMult(r.trackingMult)}
          </td>
          {family !== "projectile" && (
            <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">
              {r.capNeedBonusPct == null
                ? "—"
                : formatSignedPercent(r.capNeedBonusPct / 100)}
            </td>
          )}
        </tr>
      )}
    />
  );
}

const CAP_COLUMN: SortColumn<SortKey> = {
  key: "capNeedBonusPct",
  label: "Cap use",
  numeric: true,
  description:
    "Extra capacitor this charge costs per shot, as a percent bonus on top of the turret's base cap use (hybrids and lasers only).",
};
