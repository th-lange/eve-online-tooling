import { STORAGE_KEYS } from "../../lib/storageKeys";

export type ResultsView =
  "opportunities" | "favorites" | "blacklist" | "library";

// Manufacturing structure presets → material/cost/time bonuses (role bonuses).
export type StructureKey = "npc" | "raitaru" | "azbel" | "sotiyo";
export const STRUCTURES: Record<
  StructureKey,
  { label: string; meBonus: number; costBonus: number; tePct: number }
> = {
  npc: { label: "NPC station", meBonus: 1.0, costBonus: 0, tePct: 0 },
  raitaru: { label: "Raitaru", meBonus: 0.99, costBonus: 0.03, tePct: 15 },
  azbel: { label: "Azbel", meBonus: 0.99, costBonus: 0.04, tePct: 20 },
  sotiyo: { label: "Sotiyo", meBonus: 0.99, costBonus: 0.05, tePct: 30 },
};

/** A blueprint the user imported to model (not necessarily owned via ESI). */
export interface ImportedBlueprint {
  typeId: number;
  name: string;
  me: number;
  te: number;
}

export const IMPORTED_BP_KEY = STORAGE_KEYS.importedBlueprints;

export function loadImported(): ImportedBlueprint[] {
  try {
    const raw = localStorage.getItem(IMPORTED_BP_KEY);
    return raw ? (JSON.parse(raw) as ImportedBlueprint[]) : [];
  } catch {
    return [];
  }
}

export const FORGE = 10000002;

export type Tab = "item" | "market" | "industry" | "thresholds" | "paste";
