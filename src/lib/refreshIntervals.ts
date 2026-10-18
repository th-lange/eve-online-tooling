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

/** Info feed, fast cadence: used by `InfoPanel` ONLY while it's the active
 * view — plugin-posted alarms/messages don't emit a live event, so the open
 * panel polls snappily. */
export const INFO_FEED_REFRESH_INTERVAL_MS = 3_000;

/** Info feed, badge heartbeat: `InfoAlertsProvider` is mounted at the app
 * root for the whole session, so its observer deliberately polls slowly —
 * it only feeds the nav badge's unseen-alarm count, where half a minute of
 * staleness is invisible. Both observers share the `["info"]` query;
 * TanStack polls at the smallest interval any active observer requests, so
 * the open panel's 3s wins while it's on screen. */
export const INFO_ALARM_BADGE_REFRESH_INTERVAL_MS = 30_000;

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

/** Release check (Settings page + sidebar badge): how long the frontend
 * trusts its own last answer before invoking the Tauri command again within
 * a session. The Rust side has its own disk-backed ETag cache on top of
 * this, so a shorter value here just saves an IPC round-trip, not a network
 * call — releases are infrequent, so there's no reason to re-ask hourly. */
export const RELEASE_CHECK_STALE_TIME_MS = 6 * 60 * 60 * 1000;

/** Notifications feed list: plugin-posted notifications don't change
 *  faster than a few minutes, so the query is left alone for a while
 *  before TanStack Query considers it worth a background refetch. */
export const NOTIFICATIONS_FEED_STALE_TIME_MS = 5 * 60_000;

/** Fight overlay's PVP profile lookup (pilots for a tracked name): profile
 *  membership rarely changes within a session, so this is cached for
 *  several minutes rather than re-fetched on every overlay render. */
export const FIGHT_OVERLAY_PROFILE_STALE_TIME_MS = 5 * 60_000;

/** Fight overlay's local fit list (used for "my ranges" + auto-fit pick):
 *  fits are edited rarely compared to how often the overlay re-renders
 *  during a fight, so a short cache avoids re-reading the fit store on
 *  every bucket update. */
export const FIGHT_OVERLAY_FIT_LIST_STALE_TIME_MS = 30_000;

/** Fight overlay's "my current ship" cache window: shorter than its own
 *  {@link FIGHT_OVERLAY_SHIP_POLL_INTERVAL_MS} refetch cadence so a manual
 *  invalidation (e.g. right after a ship swap) isn't immediately discarded
 *  as still-fresh. */
export const FIGHT_OVERLAY_SHIP_STALE_TIME_MS = 15_000;

/** Recording settings' character dropdown (distinct characters seen in the
 *  gamelogs folder): the list only grows as new logs appear, so there's no
 *  need to re-scan the folder on every render of the settings card. */
export const RECORDING_CHARACTERS_STALE_TIME_MS = 60_000;

/** Pochven market "current location" lookup (manual trigger, EntryFinder):
 *  your system doesn't change without an explicit jump, so the result is
 *  kept for a minute rather than re-resolved on every interaction. */
export const POCHVEN_CURRENT_LOCATION_STALE_TIME_MS = 60_000;

/** Pochven entry/exit route search result: the route graph between hubs is
 *  effectively static within a session, so a found route is kept for
 *  several minutes instead of being recomputed on every re-render. */
export const POCHVEN_ROUTE_RESULT_STALE_TIME_MS = 5 * 60_000;

/** Pochven logistics route table: built from static system/route data that
 *  never changes mid-session, so an hour-long cache avoids redundant work
 *  for a page that's opened repeatedly but rarely needs fresh data. */
export const POCHVEN_ROUTES_STALE_TIME_MS = 60 * 60_000;

/** Pochven systems map popover: static universe data, cached for a full day
 *  since it never changes without an app update. */
export const POCHVEN_SYSTEMS_MAP_STALE_TIME_MS = 24 * 60 * 60_000;

/** Wallet transaction ledger: transactions land in bursts, not continuously,
 *  so the page re-fetches at most every few minutes instead of on every
 *  render. */
export const TRANSACTIONS_LEDGER_STALE_TIME_MS = 5 * 60_000;
