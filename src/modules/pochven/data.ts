// Curated Pochven reference data (epic #417, dataset #413).
//
// Static facts only: clade/role metadata, internal C729 links, the filament
// reference and the schematic triangle. Candidate-derived numbers (entry
// counts per band / spawn regions) come live from the backend (`pochven_map`),
// so they can't drift from the candidate dataset (#458).

/** C729 wormhole specs, shown in the UI. */
export const C729 = {
  spawnDistance: "~3 jumps from the system's old-map location",
  maxJumpMass: "410,000,000 kg (up to Orca / Battleship / Bowhead)",
  lifetime: "12 hours",
};

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
