import type { SortColumn } from "../../components/SortHeaderCell";
import type { MilitiaFactionId } from "./factionPerspective";

/** The militia picker's selection: Observer (neutral, today's view) or one
 *  of the four militias. */
export type MilitiaChoice = "observer" | MilitiaFactionId;

/** Picker button order, paired by warzone (Caldari/Gallente, then
 *  Amarr/Minmatar) so opposing militias sit next to each other. */
export const MILITIA_PICKER_ORDER: readonly MilitiaFactionId[] = [
  500001, 500004, 500003, 500002,
];

/** The resolved militia perspective passed down to {@link Warzone}: `null`
 *  in Observer mode. */
export type ActivePerspective = {
  myFaction: MilitiaFactionId;
  enemyFaction: MilitiaFactionId;
} | null;

/** Militia faction id → accent hex, used for the map + legend. */
export const FACTION_HEX: Record<number, string> = {
  500001: "#38bdf8", // Caldari State
  500002: "#fb7185", // Minmatar Republic
  500003: "#fbbf24", // Amarr Empire
  500004: "#34d399", // Gallente Federation
};

/** Same colours keyed by faction name (the militia summary has no id). */
export const FACTION_HEX_BY_NAME: Record<string, string> = {
  "Caldari State": "#38bdf8",
  "Minmatar Republic": "#fb7185",
  "Amarr Empire": "#fbbf24",
  "Gallente Federation": "#34d399",
};

/** Relationship → accent hex, used instead of {@link FACTION_HEX} once a
 *  militia is selected — friendly always renders the same colour regardless
 *  of *which* militia is "mine", so the map/legend read as "us vs them"
 *  rather than tracking a specific faction's usual palette. */
export const RELATIONSHIP_HEX: Record<
  "friendly" | "hostile" | "cartel",
  string
> = {
  friendly: "#34d399", // emerald
  hostile: "#fb7185", // rose
  cartel: "#a78bfa", // violet
};

/** Contested-state chip styles. */
export const CONTEST_STYLE: Record<string, string> = {
  uncontested: "bg-zinc-700/40 text-zinc-400",
  contested: "bg-amber-500/15 text-amber-300",
  vulnerable: "bg-rose-500/15 text-rose-300",
  captured: "bg-emerald-500/15 text-emerald-300",
};

/** Contested-state → outline-ring hex on the map (uncontested = no ring). */
export const CONTEST_RING: Record<string, string | undefined> = {
  contested: "#fbbf24",
  vulnerable: "#fb7185",
  captured: "#34d399",
};

/** Solid tile-background base per contest state (uncontested = plain dark). */
export const BASE_RGB: [number, number, number] = [24, 24, 27]; // zinc-900
export const CONTEST_RGB: Record<string, [number, number, number]> = {
  contested: [92, 71, 14], // solid amber
  vulnerable: [96, 30, 48], // solid rose
  captured: [16, 78, 56], // solid emerald
};
/** Colour the background deepens toward as a system's kills rise. */
export const HEAT_RGB: [number, number, number] = [200, 32, 32];

/** Numeric rank for sorting contested state: uncontested → captured. */
export const CONTEST_RANK: Record<string, number> = {
  uncontested: 0,
  contested: 1,
  vulnerable: 2,
  captured: 3,
};

/** Warzone-list filter: contested (any active contest — contested/vulnerable/
 *  captured), uncontested (quiet), or all. */
export type FwSystemFilter = "all" | "contested" | "uncontested";
export const FW_FILTERS: readonly { key: FwSystemFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "contested", label: "Contested" },
  { key: "uncontested", label: "Uncontested" },
];

/** Battlefield-class filter: frontlines are where contact/plexing actually
 *  happens, command ops back them up — rearguard is deliberately left out
 *  of the picker (it's the "nothing worth routing to" tier). */
export type FwBattlefieldFilter = "all" | "frontline" | "commandops";
export const FW_BATTLEFIELD_FILTERS: readonly {
  key: FwBattlefieldFilter;
  label: string;
}[] = [
  { key: "all", label: "All" },
  { key: "frontline", label: "Frontlines" },
  { key: "commandops", label: "Command Post" },
];

/** Map height presets (#897). "fill" tracks the remaining viewport height
 *  via {@link useFillHeight} instead of a fixed pixel value. */
export type FwMapSize = "s" | "m" | "l" | "fill";
export const MAP_SIZE_PX: Record<Exclude<FwMapSize, "fill">, number> = {
  s: 320,
  m: 480,
  l: 720,
};
export const FW_MAP_SIZES: readonly { key: FwMapSize; label: string }[] = [
  { key: "s", label: "S" },
  { key: "m", label: "M" },
  { key: "l", label: "L" },
  { key: "fill", label: "Fill" },
];

/** Proximity filter (#898): "within N jumps of me". Scopes both the table
 *  and the map; hidden without an active character (no jump data to filter
 *  by). "all" behaves exactly like the page did before this filter existed. */
export type FwProximityRadius = "3" | "5" | "10" | "all";
export const FW_PROXIMITY_OPTIONS: readonly {
  key: FwProximityRadius;
  label: string;
}[] = [
  { key: "3", label: "3j" },
  { key: "5", label: "5j" },
  { key: "10", label: "10j" },
  { key: "all", label: "All" },
];

export type FwSortKey =
  | "name"
  | "region"
  | "occupier"
  | "perspectiveRank"
  | "battlefieldRank"
  | "contestedRank"
  | "vpPct"
  | "vpVelocity"
  | "vpDelta30mSigned"
  | "vpDeltaLoginSigned"
  | "kills"
  | "npcKills"
  | "jumps"
  | "hops"
  | "farmScore"
  | "hotspotActivity";

export const FW_SORT_KEYS: readonly FwSortKey[] = [
  "name",
  "region",
  "occupier",
  "perspectiveRank",
  "battlefieldRank",
  "contestedRank",
  "vpPct",
  "vpVelocity",
  "vpDelta30mSigned",
  "vpDeltaLoginSigned",
  "kills",
  "npcKills",
  "jumps",
  "hops",
  "farmScore",
  "hotspotActivity",
];

/** Numeric rank for sorting battlefield class: frontline (most tactically
 *  relevant — active contact line) sorts ahead of rearguard. */
export const BATTLEFIELD_RANK: Record<string, number> = {
  frontline: 0,
  commandops: 1,
  rearguard: 2,
};

/** Battlefield class → display label. */
export const BATTLEFIELD_LABEL: Record<string, string> = {
  frontline: "Frontline",
  commandops: "Command Ops",
  rearguard: "Rearguard",
};

/** Battlefield class → chip style. Frontline pays 150% LP and is the only
 *  class with full plex spawns, so it gets the most attention-grabbing hue. */
export const BATTLEFIELD_STYLE: Record<string, string> = {
  frontline: "bg-orange-500/15 text-orange-300",
  commandops: "bg-sky-500/15 text-sky-300",
  rearguard: "bg-zinc-700/40 text-zinc-400",
};

/** Derived (#895), not from ESI — see the backend's `classify_battlefield`
 *  doc comment for the frontline/command-ops/rearguard rules. */
export const BATTLEFIELD_COLUMN: SortColumn<FwSortKey> = {
  key: "battlefieldRank",
  label: "Battlefield",
  numeric: false,
  description:
    "Frontline: borders enemy territory (150% LP, full plex spawns). Command Ops: a staging system just behind a friendly frontline. Rearguard: everything else.",
};

/** Sortable rank for the Defend/Push perspective column: the two
 *  actionable states sort ahead of "nothing to act on here". */
export const PERSPECTIVE_RANK: Record<"defend" | "push" | "none", number> = {
  defend: 0,
  push: 1,
  none: 2,
};

/** The perspective column, spliced into {@link FW_COLUMNS} after "Controlled
 *  by" only while a militia (not Observer) is selected — Observer mode's
 *  table is otherwise unchanged. */
export const PERSPECTIVE_COLUMN: SortColumn<FwSortKey> = {
  key: "perspectiveRank",
  label: "Perspective",
  numeric: false,
  description:
    "Defend: your militia holds it and it's under contest. Push: the enemy holds it and it's under contest.",
};

export const FW_COLUMNS: SortColumn<FwSortKey>[] = [
  {
    key: "name",
    label: "System",
    numeric: false,
    description: "Solar system name",
  },
  {
    key: "region",
    label: "Region",
    numeric: false,
    description: "Region the system belongs to",
  },
  {
    key: "occupier",
    label: "Controlled by",
    numeric: false,
    description: "Faction currently occupying this system",
  },
  BATTLEFIELD_COLUMN,
  {
    key: "contestedRank",
    label: "State",
    numeric: false,
    description:
      "Contest state: uncontested → contested → vulnerable → captured",
  },
  {
    key: "vpPct",
    label: "Capture",
    numeric: true,
    description: "Victory-point capture progress (% toward flip)",
  },
  {
    key: "vpVelocity",
    label: "Trend",
    numeric: false,
    description:
      "VP velocity over the last ~30 min — ↑↑ fast gain, ↑ gain, → stable, ↓ falling, signed for your militia once one's selected (↑ = good for you) and for the occupier in Observer mode. Blank until enough recent history exists.",
  },
  {
    key: "kills",
    label: "Kills 1h",
    numeric: true,
    description: "Ship kills in the last hour",
  },
  {
    key: "npcKills",
    label: "NPC Kills 1h",
    numeric: true,
    description:
      "NPC (rat) kills in the last hour — high NPC kills with low ship kills suggests active plex farming",
  },
  {
    key: "jumps",
    label: "Jumps 1h",
    numeric: true,
    description: "Stargate jumps through this system in the last hour",
  },
  {
    key: "hops",
    label: "Dist.",
    numeric: true,
    description: "Shortest stargate route from your current location",
  },
];

/** Faction-signed VP%-change columns (perspective mode only — the sign
 *  only means anything once "my militia" is defined): the backend's rolling
 *  ~30-min sample history, and this session's own login-time baseline. See
 *  `vpChange.ts`'s `factionSignedDelta` for the sign convention (positive =
 *  progress for the selected militia, negative = progress for the enemy). */
export const VP_DELTA_30M_COLUMN: SortColumn<FwSortKey> = {
  key: "vpDelta30mSigned",
  label: "Δ 30m",
  numeric: true,
  description:
    "VP% change in roughly the last 30 min, signed for your militia: positive is progress for you, negative is progress for the enemy. Blank until enough history exists.",
};
export const VP_DELTA_LOGIN_COLUMN: SortColumn<FwSortKey> = {
  key: "vpDeltaLoginSigned",
  label: "Δ login",
  numeric: true,
  description:
    "VP% change since you opened this session, signed for your militia: positive is progress for you, negative is progress for the enemy.",
};

/** {@link FW_COLUMNS} with the Defend/Push column inserted after "Controlled
 *  by", and the faction-signed Δ30m/Δ login columns inserted after "Trend" —
 *  used in place of {@link FW_COLUMNS} once a militia is selected. */
export const FW_COLUMNS_PERSPECTIVE: SortColumn<FwSortKey>[] = [
  ...FW_COLUMNS.slice(0, 3),
  PERSPECTIVE_COLUMN,
  ...FW_COLUMNS.slice(3, 7),
  VP_DELTA_30M_COLUMN,
  VP_DELTA_LOGIN_COLUMN,
  ...FW_COLUMNS.slice(7),
];

/** Plexing-mode-only column (#904), appended when that playstyle is active.
 *  See {@link computeFarmScores} for the full weighted formula. */
export const FARM_SCORE_COLUMN: SortColumn<FwSortKey> = {
  key: "farmScore",
  label: "Farm Score",
  numeric: true,
  description:
    "v1 plexing score: 0.4·capture + 0.25·(low kills) + 0.2·(low NPC kills) + 0.15·(close to me). Higher is safer/faster to farm.",
};

/** Faction-scoped kill activity (#905, extended): friendly/enemy losses +
 *  NPC cartel activity over the last ~6h, from zKillboard (`hotspots.ts`).
 *  Perspective-mode only — shown once the heat layer above the map is
 *  active, replacing the old separately-ranked "Hottest systems" panel so
 *  every row gets this, sortable/filterable like everything else, instead
 *  of a capped top-8 list that never responded to the heat-layer toggle. */
export const HOTSPOT_COLUMN: SortColumn<FwSortKey> = {
  key: "hotspotActivity",
  label: "Activity 6h",
  numeric: false,
  description:
    "Faction-scoped kill activity over the last ~6h (zKillboard): friendly losses, enemy losses, and NPC cartel activity.",
};
