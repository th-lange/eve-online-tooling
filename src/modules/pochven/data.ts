// Curated Pochven reference data (epic #417, dataset #413).
//
// Each of Pochven's 27 systems has exactly one C729 static wormhole whose
// k-space side spawns in a fixed set of regions (~3 jumps from the system's
// old-map location). Source: Electus Matari entry manual
// (https://pochven.electusmatari.com/). A `region` of "Pochven" denotes an
// *internal* C729 to another Pochven system — not a k-space entry.
//
// clade / role come from the Pochven GPS sheet (POCHVEN_META below).

/** One region a system's C729 can spawn in, with its candidate-system count. */
export interface C729Zone {
  region: string;
  /** Number of candidate k-space systems in this region. */
  count: number;
}

export interface PochvenSystem {
  name: string;
  /** k-space (and internal) spawn zones for this system's C729. */
  c729: C729Zone[];
}

/** Internal C729 pseudo-region marker (a hole to another Pochven system). */
export const INTERNAL = "Pochven";

/** C729 wormhole specs, shown in the UI. */
export const C729 = {
  spawnDistance: "~3 jumps from the system's old-map location",
  maxJumpMass: "410,000,000 kg (up to Orca / Battleship / Bowhead)",
  lifetime: "12 hours",
};

export const POCHVEN_SYSTEMS: PochvenSystem[] = [
  {
    name: "Ahtila",
    c729: [
      { region: "Black Rise", count: 18 },
      { region: "Lonetrek", count: 3 },
      { region: INTERNAL, count: 1 },
    ],
  },
  {
    name: "Ala",
    c729: [
      { region: "Sinq Laison", count: 11 },
      { region: "Everyshore", count: 2 },
      { region: "The Bleak Lands", count: 2 },
    ],
  },
  { name: "Angymonne", c729: [{ region: "Everyshore", count: 15 }] },
  {
    name: "Archee",
    c729: [
      { region: "Sinq Laison", count: 11 },
      { region: "Everyshore", count: 1 },
    ],
  },
  {
    name: "Arvasaras",
    c729: [
      { region: "The Citadel", count: 3 },
      { region: "Lonetrek", count: 7 },
      { region: "The Forge", count: 1 },
    ],
  },
  { name: "Harva", c729: [{ region: "Domain", count: 10 }] },
  {
    name: "Ichoriya",
    c729: [
      { region: "Black Rise", count: 16 },
      { region: "Lonetrek", count: 1 },
      { region: "Placid", count: 1 },
      { region: INTERNAL, count: 1 },
    ],
  },
  {
    name: "Ignebaener",
    c729: [
      { region: "Essence", count: 10 },
      { region: "Verge Vendor", count: 5 },
    ],
  },
  {
    name: "Kaunokka",
    c729: [
      { region: "Lonetrek", count: 1 },
      { region: "The Citadel", count: 8 },
      { region: INTERNAL, count: 2 },
    ],
  },
  {
    name: "Kino",
    c729: [
      { region: "Lonetrek", count: 8 },
      { region: "The Citadel", count: 5 },
      { region: INTERNAL, count: 1 },
    ],
  },
  {
    name: "Komo",
    c729: [
      { region: "The Citadel", count: 17 },
      { region: "Lonetrek", count: 4 },
      { region: "The Forge", count: 2 },
    ],
  },
  { name: "Konola", c729: [{ region: "The Citadel", count: 9 }] },
  {
    name: "Krirald",
    c729: [
      { region: "Metropolis", count: 9 },
      { region: "Sinq Laison", count: 1 },
    ],
  },
  {
    name: "Kuharah",
    c729: [
      { region: "Curse", count: 1 },
      { region: "Derelik", count: 8 },
    ],
  },
  {
    name: "Nalvula",
    c729: [
      { region: "Lonetrek", count: 13 },
      { region: "Tribute", count: 5 },
      { region: "The Forge", count: 2 },
      { region: "Vale of the Silent", count: 1 },
    ],
  },
  { name: "Nani", c729: [{ region: "Lonetrek", count: 10 }] },
  {
    name: "Niarja",
    c729: [
      { region: "Domain", count: 16 },
      { region: "Kador", count: 2 },
      { region: "The Citadel", count: 7 },
      { region: "The Forge", count: 1 },
    ],
  },
  {
    name: "Otanuomi",
    c729: [
      { region: "The Forge", count: 16 },
      { region: INTERNAL, count: 1 },
    ],
  },
  {
    name: "Otela",
    c729: [
      { region: "The Citadel", count: 1 },
      { region: "The Forge", count: 11 },
      { region: "Lonetrek", count: 1 },
    ],
  },
  {
    name: "Raravoss",
    c729: [
      { region: "The Bleak Lands", count: 10 },
      { region: "Domain", count: 11 },
    ],
  },
  {
    name: "Sakenta",
    c729: [
      { region: "The Citadel", count: 2 },
      { region: "The Forge", count: 9 },
      { region: "Lonetrek", count: 5 },
    ],
  },
  { name: "Senda", c729: [{ region: "The Forge", count: 7 }] },
  {
    name: "Skarkon",
    c729: [
      { region: "Etherium Reach", count: 7 },
      { region: "Molden Heath", count: 8 },
      { region: "Metropolis", count: 2 },
    ],
  },
  {
    name: "Tunudan",
    c729: [
      { region: "The Citadel", count: 12 },
      { region: INTERNAL, count: 1 },
    ],
  },
  {
    name: "Urhinichi",
    c729: [
      { region: "The Citadel", count: 9 },
      { region: "The Forge", count: 5 },
    ],
  },
  {
    name: "Vale",
    c729: [
      { region: "Essence", count: 10 },
      { region: "Sinq Laison", count: 1 },
      { region: "Verge Vendor", count: 1 },
    ],
  },
  {
    name: "Wirashoda",
    c729: [
      { region: "The Forge", count: 7 },
      { region: INTERNAL, count: 1 },
    ],
  },
];

/** Pochven systems whose C729 can spawn in `region` (k-space only). */
export function entriesInRegion(region: string): {
  name: string;
  count: number;
  others: C729Zone[];
}[] {
  return POCHVEN_SYSTEMS.flatMap((s) => {
    const hit = s.c729.find(
      (z) => z.region === region && z.region !== INTERNAL,
    );
    if (!hit) return [];
    return [
      {
        name: s.name,
        count: hit.count,
        others: s.c729.filter(
          (z) => z.region !== region && z.region !== INTERNAL,
        ),
      },
    ];
  });
}

/** All k-space regions that have at least one Pochven entry, sorted. */
export function pochvenRegions(): string[] {
  const set = new Set<string>();
  for (const s of POCHVEN_SYSTEMS)
    for (const z of s.c729) if (z.region !== INTERNAL) set.add(z.region);
  return [...set].sort();
}

// --- Clade / role + filaments (#413, #416) ---

export type Clade = "Perun" | "Svarog" | "Veles";
export type Role = "Home" | "Border" | "Internal";

/** Each system's Triglavian clade + role, from the Pochven GPS sheet. */
export const POCHVEN_META: Record<string, { clade: Clade; role: Role }> = {
  Ahtila: { clade: "Svarog", role: "Border" },
  Ala: { clade: "Veles", role: "Internal" },
  Angymonne: { clade: "Veles", role: "Internal" },
  Archee: { clade: "Veles", role: "Home" },
  Arvasaras: { clade: "Veles", role: "Border" },
  Harva: { clade: "Svarog", role: "Internal" },
  Ichoriya: { clade: "Veles", role: "Internal" },
  Ignebaener: { clade: "Perun", role: "Internal" },
  Kaunokka: { clade: "Veles", role: "Internal" },
  Kino: { clade: "Perun", role: "Home" },
  Komo: { clade: "Perun", role: "Internal" },
  Konola: { clade: "Perun", role: "Internal" },
  Krirald: { clade: "Perun", role: "Internal" },
  Kuharah: { clade: "Svarog", role: "Internal" },
  Nalvula: { clade: "Perun", role: "Internal" },
  Nani: { clade: "Svarog", role: "Internal" },
  Niarja: { clade: "Svarog", role: "Home" },
  Otanuomi: { clade: "Perun", role: "Border" },
  Otela: { clade: "Perun", role: "Internal" },
  Raravoss: { clade: "Svarog", role: "Internal" },
  Sakenta: { clade: "Perun", role: "Border" },
  Senda: { clade: "Veles", role: "Border" },
  Skarkon: { clade: "Svarog", role: "Internal" },
  Tunudan: { clade: "Svarog", role: "Internal" },
  Urhinichi: { clade: "Svarog", role: "Border" },
  Vale: { clade: "Veles", role: "Internal" },
  Wirashoda: { clade: "Veles", role: "Internal" },
};

/** System names grouped by role (for "which systems can this filament drop me in"). */
export function systemsByRole(): Record<Role, string[]> {
  const out: Record<Role, string[]> = { Home: [], Border: [], Internal: [] };
  for (const [name, m] of Object.entries(POCHVEN_META)) out[m.role].push(name);
  for (const r of Object.keys(out) as Role[]) out[r].sort();
  return out;
}

/** System names grouped by clade. */
export function systemsByClade(): Record<Clade, string[]> {
  const out: Record<Clade, string[]> = { Perun: [], Svarog: [], Veles: [] };
  for (const [name, m] of Object.entries(POCHVEN_META)) out[m.clade].push(name);
  for (const c of Object.keys(out) as Clade[]) out[c].sort();
  return out;
}

/** Internal C729 links between Pochven systems (Electus Matari data). */
export const POCHVEN_INTERNAL_LINKS: [string, string][] = [
  ["Otanuomi", "Wirashoda"],
  ["Kaunokka", "Kino"],
  ["Kaunokka", "Tunudan"],
  ["Ahtila", "Ichoriya"],
];

// --- Fixed triangle layout for the "27 systems" reference map ---
//
// Pochven's 27 systems are three clade constellations (Perun / Svarog / Veles)
// whose gates form one big loop — the region reads as a triangle. Each clade is
// one edge of the triangle: its two Border systems sit at the corners (shared
// with the neighbouring clade), its six Internal systems run along the edge, and
// its Home system branches off the middle. We pin explicit coordinates so the
// reference map always draws in this recognisable shape (drag to move; a reset
// restores it).  Corners: A = Perun∩Veles, B = Veles∩Svarog, C = Perun∩Svarog.
const TRI_CORNER: Record<string, [number, number]> = {
  A: [470, 40],
  B: [90, 620],
  C: [850, 620],
};
const TRI_EDGE: Record<
  Clade,
  {
    c1: keyof typeof TRI_CORNER;
    c2: keyof typeof TRI_CORNER;
    b1: string;
    b2: string;
    home: string;
  }
> = {
  Perun: { c1: "A", c2: "C", b1: "Sakenta", b2: "Otanuomi", home: "Kino" },
  Veles: { c1: "A", c2: "B", b1: "Arvasaras", b2: "Senda", home: "Archee" },
  Svarog: { c1: "B", c2: "C", b1: "Ahtila", b2: "Urhinichi", home: "Niarja" },
};
/** Border-to-border gate links joining the clades at each triangle corner. */
const TRI_CORNER_LINKS: [string, string][] = [
  ["Arvasaras", "Sakenta"], // corner A (Veles ↔ Perun)
  ["Senda", "Ahtila"], // corner B (Veles ↔ Svarog)
  ["Otanuomi", "Urhinichi"], // corner C (Perun ↔ Svarog)
];

/**
 * Fixed triangular coordinates + gate-loop edges for all 27 systems, so the
 * reference map always renders in the same recognisable Pochven shape.
 */
export function pochvenTriangle(): {
  pos: Record<string, { x: number; y: number }>;
  edges: [string, string][];
} {
  const pos: Record<string, { x: number; y: number }> = {};
  const edges: [string, string][] = [];
  const cx = (TRI_CORNER.A[0] + TRI_CORNER.B[0] + TRI_CORNER.C[0]) / 3;
  const cy = (TRI_CORNER.A[1] + TRI_CORNER.B[1] + TRI_CORNER.C[1]) / 3;
  for (const clade of Object.keys(TRI_EDGE) as Clade[]) {
    const e = TRI_EDGE[clade];
    const p1 = TRI_CORNER[e.c1];
    const p2 = TRI_CORNER[e.c2];
    const internals = Object.entries(POCHVEN_META)
      .filter(([, m]) => m.clade === clade && m.role === "Internal")
      .map(([n]) => n)
      .sort();
    // Line systems along the edge: border, six internals, border.
    const line = [e.b1, ...internals, e.b2];
    line.forEach((name, i) => {
      const t = 0.08 + (0.84 * i) / (line.length - 1);
      pos[name] = {
        x: p1[0] + (p2[0] - p1[0]) * t,
        y: p1[1] + (p2[1] - p1[1]) * t,
      };
      if (i > 0) edges.push([line[i - 1], name]);
    });
    // Home branches off the middle of the edge, pushed outward from the centre.
    const mx = (p1[0] + p2[0]) / 2;
    const my = (p1[1] + p2[1]) / 2;
    const dx = mx - cx;
    const dy = my - cy;
    const len = Math.hypot(dx, dy) || 1;
    pos[e.home] = { x: mx + (dx / len) * 90, y: my + (dy / len) * 90 };
    edges.push([line[Math.floor(line.length / 2)], e.home]);
  }
  edges.push(...TRI_CORNER_LINKS);
  return { pos, edges };
}

export type SecBand = "hisec" | "lowsec" | "nullsec";
export interface EntryBands {
  hisec: number;
  lowsec: number;
  nullsec: number;
}

/** How many of a system's C729 candidate exits sit in each security band
 *  (Electus Matari candidate securities). */
export const POCHVEN_ENTRY_COUNTS: Record<string, EntryBands> = {
  Ahtila: { hisec: 10, lowsec: 11, nullsec: 0 },
  Ala: { hisec: 7, lowsec: 8, nullsec: 0 },
  Angymonne: { hisec: 15, lowsec: 0, nullsec: 0 },
  Archee: { hisec: 12, lowsec: 0, nullsec: 0 },
  Arvasaras: { hisec: 10, lowsec: 1, nullsec: 0 },
  Harva: { hisec: 10, lowsec: 0, nullsec: 0 },
  Ichoriya: { hisec: 7, lowsec: 11, nullsec: 0 },
  Ignebaener: { hisec: 7, lowsec: 8, nullsec: 0 },
  Kaunokka: { hisec: 8, lowsec: 1, nullsec: 0 },
  Kino: { hisec: 13, lowsec: 0, nullsec: 0 },
  Komo: { hisec: 23, lowsec: 0, nullsec: 0 },
  Konola: { hisec: 7, lowsec: 2, nullsec: 0 },
  Krirald: { hisec: 2, lowsec: 8, nullsec: 0 },
  Kuharah: { hisec: 0, lowsec: 8, nullsec: 1 },
  Nalvula: { hisec: 8, lowsec: 7, nullsec: 6 },
  Nani: { hisec: 10, lowsec: 0, nullsec: 0 },
  Niarja: { hisec: 26, lowsec: 0, nullsec: 0 },
  Otanuomi: { hisec: 10, lowsec: 6, nullsec: 0 },
  Otela: { hisec: 14, lowsec: 0, nullsec: 0 },
  Raravoss: { hisec: 14, lowsec: 7, nullsec: 0 },
  Sakenta: { hisec: 17, lowsec: 0, nullsec: 0 },
  Senda: { hisec: 7, lowsec: 0, nullsec: 0 },
  Skarkon: { hisec: 2, lowsec: 8, nullsec: 7 },
  Tunudan: { hisec: 10, lowsec: 2, nullsec: 0 },
  Urhinichi: { hisec: 14, lowsec: 0, nullsec: 0 },
  Vale: { hisec: 11, lowsec: 1, nullsec: 0 },
  Wirashoda: { hisec: 4, lowsec: 3, nullsec: 0 },
};

/** The band most of a system's C729 candidates sit in (ties → safer). */
export function dominantBand(name: string): SecBand {
  const c = POCHVEN_ENTRY_COUNTS[name] ?? { hisec: 0, lowsec: 0, nullsec: 0 };
  if (c.hisec >= c.lowsec && c.hisec >= c.nullsec) return "hisec";
  if (c.lowsec >= c.nullsec) return "lowsec";
  return "nullsec";
}

/** Whether a system has a k-space C729 entry (vs internal-only). */
export function hasKspaceEntry(name: string): boolean {
  const s = POCHVEN_SYSTEMS.find((x) => x.name === name);
  return !!s && s.c729.some((z) => z.region !== INTERNAL);
}

/** Filament reference (EVE support / EVE-University). */
export const FILAMENTS = {
  sizes: [1, 5, 15] as const,
  requirements: [
    "Be in a fleet (everyone within range)",
    "All safeties yellow or red",
    "No combat timer",
    "≥ 1000 km from celestials & stations",
  ],
  types: [
    {
      name: "System-type",
      detail:
        "Home / Border / Internal — drops the fleet into a random system of that role (any clade).",
    },
    {
      name: "Cladistic",
      detail:
        "Perun / Veles / Svarog — drops into a random system of that clade.",
    },
  ],
  // Wormhole (C729) entry has no fleet cap and no wait timer, unlike filaments.
  note: "Filaments cap the fleet at 1 / 5 / 15 sub-caps and have a wait timer; a C729 wormhole has neither.",
  // Getting back out of Pochven to known space. Exit filaments only work from
  // inside Pochven and keep the same 1 / 5 / 15 fleet caps.
  exit: {
    intro:
      "To leave Pochven you use an exit filament or a wormhole — the entry filaments above only move you deeper in. Exit filaments keep the 1 / 5 / 15 fleet cap.",
    options: [
      {
        name: "Proximity 'Extraction' filament",
        detail:
          "Drops the fleet into a k-space system within 2.5 light-years of the system you activate in — the closest thing to a targeted exit near a known area.",
      },
      {
        name: "Glorification 'Devana' filament",
        detail:
          "Drops the fleet into one of the 28 Triglavian Minor Victory Systems at random — lands in hi- or low-sec.",
      },
      {
        name: "C729 wormhole",
        detail:
          "Scan it down from the Pochven side. Each system has exactly one active k-space C729 (spawns in the regions listed above, ~3 jumps from its old-map location), plus possible J-space holes.",
      },
    ],
  },
};
