import { invoke } from "@tauri-apps/api/core";

export interface ConnectionView {
  id: number;
  sourceSystemId: number;
  sourceName: string;
  sourceWspace: boolean;
  targetSystemId: number;
  targetName: string;
  targetWspace: boolean;
  scope: string;
  massStatus: string;
  jumpMass: string;
  eol: boolean;
  sourceSig: string | null;
  targetSig: string | null;
  /** "manual" (hand-entered) | "evescout" (auto-imported from Thera/Turnur feed). */
  source: string;
  createdAt: number;
}

export interface NewConnection {
  sourceSystemId: number;
  targetSystemId: number;
  scope?: string;
  sourceSig?: string | null;
  targetSig?: string | null;
}

/** Current wormhole/stargate connections (dead wormholes auto-pruned). */
export function whConnections(): Promise<ConnectionView[]> {
  return invoke<ConnectionView[]>("wh_connections");
}
export function whAddConnection(
  connection: NewConnection,
): Promise<ConnectionView[]> {
  return invoke<ConnectionView[]>("wh_add_connection", { connection });
}
export function whUpdateConnection(
  id: number,
  massStatus: string,
  jumpMass: string,
  eol: boolean,
  sourceSig: string | null,
  targetSig: string | null,
): Promise<ConnectionView[]> {
  return invoke<ConnectionView[]>("wh_update_connection", {
    id,
    massStatus,
    jumpMass,
    eol,
    sourceSig,
    targetSig,
  });
}
export function whDeleteConnection(id: number): Promise<ConnectionView[]> {
  return invoke<ConnectionView[]>("wh_delete_connection", { id });
}
/**
 * Import live Thera/Turnur connections from EVE-Scout, merged into the map.
 * Hand-entered holes are preserved; imported holes are refreshed from the feed.
 */
export function whImportEvescout(): Promise<ConnectionView[]> {
  return invoke<ConnectionView[]>("wh_import_evescout");
}

// --- Tripwire (opt-in) ---

export interface TripwireStatus {
  configured: boolean;
  baseUrl: string;
  username: string;
  mask: string | null;
}

/** Current Tripwire opt-in status (never returns the stored password). */
export function whTripwireStatus(): Promise<TripwireStatus> {
  return invoke<TripwireStatus>("wh_tripwire_status");
}
/** Opt in: store base URL + username (+ optional mask) and the password (keychain). */
export function whTripwireConnect(
  baseUrl: string,
  username: string,
  password: string,
  mask: string | null,
): Promise<TripwireStatus> {
  return invoke<TripwireStatus>("wh_tripwire_connect", {
    baseUrl,
    username,
    password,
    mask,
  });
}
/** Opt out: clear the stored Tripwire config + keychain password. */
export function whTripwireDisconnect(): Promise<TripwireStatus> {
  return invoke<TripwireStatus>("wh_tripwire_disconnect");
}
/** Import the configured Tripwire chain, merged into the map. */
export function whTripwireImport(): Promise<ConnectionView[]> {
  return invoke<ConnectionView[]>("wh_tripwire_import");
}

export interface JumpPlan {
  found: boolean;
  /** Hint when the ship or wormhole type couldn't be resolved. */
  message: string | null;
  shipTypeId: number;
  shipName: string;
  /** Hull base mass (kg). */
  shipMass: number;
  whCode: string;
  destClassLabel: string;
  maxJumpMass: number;
  maxStableMass: number;
  massStatus: string;
  /** Hull is within the hole's max jump mass. */
  passes: boolean;
  /** Full crossings before the estimated remaining mass is exhausted. */
  remainingCrossings: number;
  /** Crossings before the hole would drop into the critical (<10%) band. */
  crossingsUntilCritical: number;
  /** The next crossing would tip it into/past critical. */
  critRisk: boolean;
}

/**
 * Weigh a hull against a wormhole type: does it fit, and how many crossings
 * remain before exhaustion/criticality at the given mass status. Physics come
 * from the bundled SDE (offline). WH code is matched case-insensitively.
 */
export function whJumpPlan(
  shipTypeId: number,
  whTypeCode: string,
  massStatus: string,
): Promise<JumpPlan> {
  return invoke<JumpPlan>("wh_jump_plan", {
    shipTypeId,
    whTypeCode,
    massStatus,
  });
}

export interface WormholeType {
  typeId: number;
  code: string;
  /** Destination class id (0 = K162 / variable exit). */
  destClassId: number;
  destClassLabel: string;
  maxStableMass: number | null;
  maxJumpMass: number | null;
  maxStableTimeMin: number | null;
  massRegen: number | null;
}

/** The wormhole-type reference table (code → destination class + physics), offline. */
export function whTypeReference(): Promise<WormholeType[]> {
  return invoke<WormholeType[]>("wh_type_reference");
}

export interface StaticRef {
  typeId: number;
  code: string;
  destClassId: number;
  destClassLabel: string;
  maxStableMass: number | null;
  maxJumpMass: number | null;
  lifetimeMin: number | null;
}

export interface SystemReference {
  /** Whether the system was present in the statics snapshot (else class only). */
  found: boolean;
  systemId: number;
  class: number | null;
  classLabel: string | null;
  effect: string | null;
  statics: StaticRef[];
  wanderers: StaticRef[];
}

/** A system's class / effect / statics (Anoik.is snapshot merged with SDE physics). */
export function whSystemReference(systemId: number): Promise<SystemReference> {
  return invoke<SystemReference>("wh_system_reference", { systemId });
}

export interface Signature {
  id: string;
  group: string;
  sigType: string;
  name: string;
}
export interface SignatureScan {
  signatures: Signature[];
  added: string[];
  removed: string[];
}

/** Paste a probe-scanner result for a system; returns the set + added/removed diff. */
export function whPasteSignatures(
  systemId: number,
  text: string,
): Promise<SignatureScan> {
  return invoke<SignatureScan>("wh_paste_signatures", { systemId, text });
}

export interface RouteHop {
  systemId: number;
  name: string;
  security: number;
  wspace: boolean;
  /** "origin" | "stargate" | "wormhole" — edge used to reach this hop. */
  via: string;
}
export interface RouteResult {
  hops: RouteHop[];
  reachable: boolean;
  jumps: number;
}

/** Route origin→destination over stargates ∪ mapped wormhole connections. */
export function whRoute(
  originSystemId: number,
  destinationSystemId: number,
  avoidEol: boolean,
): Promise<RouteResult> {
  return invoke<RouteResult>("wh_route", {
    originSystemId,
    destinationSystemId,
    avoidEol,
  });
}
