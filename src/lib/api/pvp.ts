import { invoke } from "@tauri-apps/api/core";

/** One hull the pilot uses, with how many kills they got in it. */
export interface HullUsage {
  typeId: number;
  name: string;
  kills: number;
}

/** General PvP stats for one pilot, from zKillboard. */
export interface PvpStats {
  characterId: number;
  name: string;
  shipsDestroyed: number;
  shipsLost: number;
  iskDestroyed: number;
  iskLost: number;
  soloKills: number;
  soloLosses: number;
  /** 0–100: share of engagements that were kills (higher = more dangerous). */
  dangerRatio: number;
  /** 0–100: share of kills made in a gang (vs solo). */
  gangRatio: number;
  /** Recently active in PvP (kills in the last months). */
  active: boolean;
  /** Most-flown hulls (by kills), highest first. */
  hulls: HullUsage[];
}

export interface PvpProfilesResult {
  pilots: PvpStats[];
  /** Pasted names that didn't resolve to a character. */
  unresolved: string[];
}

/** Paste pilot names → resolve → per-pilot general zKillboard stats. */
export function pvpProfiles(text: string): Promise<PvpProfilesResult> {
  return invoke<PvpProfilesResult>("pvp_profiles", { text });
}

/** One fitted module on a lost fit, with the slot it sat in. */
export interface FitModule {
  typeId: number;
  name: string;
  /** "high" | "mid" | "low" | "rig" | "subsystem" | "drone". */
  slot: string;
  quantity: number;
}

/** A hull the pilot has lost, with a representative (most-recent) fit. */
export interface LostFit {
  hullTypeId: number;
  hullName: string;
  lostCount: number;
  killmailId: number;
  /** ISO timestamp of the most-recent loss — when they last flew this hull. */
  lastLost: string;
  modules: FitModule[];
  /** All-V dogma analysis of the fit (absent if the engine couldn't run). */
  analysis?: FitAnalysis;
}

/** One weapon's engagement envelope from the dogma engine. */
export interface WeaponLine {
  name: string;
  /** Optimal range (m); for missiles this is flight range (falloff 0). */
  optimal: number;
  falloff: number;
}

/** All-V dogma read of a fit: tank, damage, tackle range. Upper-bound estimate. */
export interface FitAnalysis {
  ehp: number;
  dpsTotal: number;
  dpsTurret: number;
  dpsMissile: number;
  dpsDrone: number;
  /** Max warp scramble/disruption range (m), if the fit has tackle. */
  scramRange?: number;
  weapons: WeaponLine[];
}

/** A pilot's lost fits (by hull), reconstructed from recent loss killmails. */
export function pvpPilotFits(characterId: number): Promise<LostFit[]> {
  return invoke<LostFit[]>("pvp_pilot_fits", { characterId });
}
