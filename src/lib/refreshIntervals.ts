/**
 * Central registry of TanStack Query polling cadences used across modules.
 * Each constant names an interval and states why it's set where it is, so
 * retuning a cadence is a single edit here instead of a hunt through JSX for
 * a bare `refetchInterval: N`.
 */

/** Route page "Auto 30s" toggle: re-pulls activity + the neighbourhood/live
 * location every 30s while enabled — matches the toggle's own label and
 * keeps map data fresh without hammering the backend for a page that's
 * usually glanced at rather than watched continuously. */
export const ROUTE_AUTO_REFRESH_INTERVAL_MS = 30_000;

/** Shopping list chat-channel capture: how often the local EVE chat log file
 * is re-read while "listening". Log lines land on disk the instant EVE
 * writes them, so this is a UX-responsiveness choice (pasted items should
 * show up promptly), not an ESI cache timer — no network call is involved. */
export const SHOPPING_CHAT_POLL_INTERVAL_MS = 4_000;

/** Info feed (`InfoPanel` + `InfoAlertsProvider`, both keyed on `["info"]`):
 * plugin-posted alarms/messages don't emit a live event, so both the panel
 * and the nav-badge provider poll this feed themselves. Shared here so the
 * two observers of the same query use one cadence instead of drifting into
 * a 3s/4s double-poll of the same data. */
export const INFO_FEED_REFRESH_INTERVAL_MS = 3_000;

/** Logs page backend tail: the tightest interval in the app, deliberately —
 * logs are watched live while debugging, and staleness there is directly
 * user-visible. */
export const LOGS_POLL_INTERVAL_MS = 2_000;

/** Faction Warfare jump-distance-to-front table: recomputed from the active
 * character's live location. A character can only cover a handful of jumps
 * in 90s, so this stays cheap while still tracking movement. */
export const FACTION_WARFARE_JUMP_DISTANCE_REFRESH_MS = 90_000;

/** Fight overlay's "my current ship" check (ESI, `read_ship_type` scope):
 * ship swaps happen between fights, not mid-fight, so 30s keeps the
 * optimal-range and drone-reminder data current without polling ESI harder
 * than the underlying data changes. */
export const FIGHT_OVERLAY_SHIP_POLL_INTERVAL_MS = 30_000;
