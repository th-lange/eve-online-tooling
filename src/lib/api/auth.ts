import { invoke } from "@tauri-apps/api/core";

export interface Character {
  characterId: number;
  name: string;
  scopes: string[];
}

/** Log in (or re-authorize) a character via EVE SSO. Opens the browser. */
export function authLogin(): Promise<Character> {
  return invoke<Character>("auth_login");
}

/** The current character roster. */
export function authCharacters(): Promise<Character[]> {
  return invoke<Character[]>("auth_characters");
}

/** Remove a character; returns the updated roster. */
export function authLogout(characterId: number): Promise<Character[]> {
  return invoke<Character[]>("auth_logout", { characterId });
}

/** Bookmark the "active" character used by per-character features. */
export function setActiveCharacter(characterId: number): Promise<void> {
  return invoke<void>("set_active_character", { characterId });
}

/** The active character id (bookmarked if set + in roster, else the first). */
export function activeCharacter(): Promise<number | null> {
  return invoke<number | null>("active_character");
}

/** Sentinel active-character id meaning "all characters" — per-character views
 *  that can aggregate fan out over the whole roster. Negative so it never
 *  collides with a real EVE character id (always positive). */
export const ALL_CHARACTERS = -1;

export interface OwnedBlueprint {
  characterId: number;
  characterName: string;
  /** True for a corporation blueprint, false for a personal one. */
  corporation: boolean;
  /** The blueprint's type id (matches a production row's blueprintTypeId). */
  typeId: number;
  /** Blueprint name from the SDE, e.g. "Hobgoblin II Blueprint". */
  name: string;
  materialEfficiency: number;
  timeEfficiency: number;
  runs: number;
  quantity: number;
}

/** Blueprints owned across the whole roster (their real ME/TE). */
export function ownedBlueprints(): Promise<OwnedBlueprint[]> {
  return invoke<OwnedBlueprint[]>("owned_blueprints");
}

export interface Asset {
  typeId: number;
  quantity: number;
  locationId: number;
}

/** A character's assets. */
export function characterAssets(characterId: number): Promise<Asset[]> {
  return invoke<Asset[]>("character_assets", { characterId });
}

/** Open the in-game market window for a type (needs a logged-in character + the
 * esi-ui.open_window scope). */
export function openMarketWindow(typeId: number): Promise<void> {
  return invoke<void>("open_market_window", { typeId });
}

/**
 * Total owned quantity per type across the whole roster (durably cached ~10min).
 * Keys are type ids (as strings, per JSON object keys).
 */
export function rosterStock(): Promise<Record<string, number>> {
  return invoke<Record<string, number>>("roster_stock");
}
