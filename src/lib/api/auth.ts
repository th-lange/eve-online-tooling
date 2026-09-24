import {
  commands,
  type Character,
  type CharacterShip,
  type OwnedBlueprint,
} from "./generated/auth";
import { unwrapCommand } from "./common";

export type { Character, CharacterShip, OwnedBlueprint };

/** Log in (or re-authorize) a character via EVE SSO. Opens the browser. */
export async function authLogin(): Promise<Character> {
  return unwrapCommand(await commands.authLogin());
}

/** The current character roster. */
export async function authCharacters(): Promise<Character[]> {
  return unwrapCommand(await commands.authCharacters());
}

/** Remove a character; returns the updated roster. */
export async function authLogout(characterId: number): Promise<Character[]> {
  return unwrapCommand(await commands.authLogout(characterId));
}

/** Bookmark the "active" character used by per-character features. */
export async function setActiveCharacter(characterId: number): Promise<void> {
  unwrapCommand(await commands.authSetActiveCharacter(characterId));
}

/** The active character id (bookmarked if set + in roster, else the first). */
export async function activeCharacter(): Promise<number | null> {
  return unwrapCommand(await commands.authActiveCharacter());
}

/** The active character's currently-boarded ship (hull type + names). `null`
 *  when no active character or the `esi-location.read_ship_type.v1` scope isn't
 *  granted (re-login after enabling it). */
export async function characterShip(): Promise<CharacterShip | null> {
  return unwrapCommand(await commands.esiCharacterShip());
}

/** Sentinel active-character id meaning "all characters" — per-character views
 *  that can aggregate fan out over the whole roster. Negative so it never
 *  collides with a real EVE character id (always positive). */
export const ALL_CHARACTERS = -1;

/** Blueprints owned across the whole roster (their real ME/TE). */
export async function ownedBlueprints(): Promise<OwnedBlueprint[]> {
  return unwrapCommand(await commands.esiOwnedBlueprints());
}

/** Open the in-game market window for a type (needs a logged-in character + the
 * esi-ui.open_window scope). */
export async function openMarketWindow(typeId: number): Promise<void> {
  unwrapCommand(await commands.esiOpenMarketWindow(typeId));
}

/** Open the in-game "Show Info" window for a character/corporation/alliance id
 * (needs a logged-in character + the esi-ui.open_window scope). */
export async function openInfoWindow(targetId: number): Promise<void> {
  unwrapCommand(await commands.esiOpenInfoWindow(targetId));
}

/** Set the active character's autopilot destination to a solar system id
 * (needs a logged-in character + the esi-ui.write_waypoint.v1 scope).
 * Clears other waypoints — direct route. */
export async function setWaypoint(systemId: number): Promise<void> {
  unwrapCommand(await commands.esiSetWaypoint(systemId));
}

/**
 * Total owned quantity per type across the whole roster (durably cached ~10min).
 * Keys are type ids (as strings, per JSON object keys).
 */
export async function rosterStock(): Promise<Record<string, number>> {
  return unwrapCommand(await commands.esiRosterStock()) as unknown as Record<
    string,
    number
  >;
}
