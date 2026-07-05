// Curated Pochven reference data (epic #417, dataset #413).
//
// Each of Pochven's 27 systems has exactly one C729 static wormhole whose
// k-space side spawns in a fixed set of regions (~3 jumps from the system's
// old-map location). Source: Electus Matari entry manual
// (https://pochven.electusmatari.com/). A `region` of "Pochven" denotes an
// *internal* C729 to another Pochven system — not a k-space entry.
//
// clade / role are intentionally omitted for now (no clean public per-system
// source yet — tracked in #413).

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
