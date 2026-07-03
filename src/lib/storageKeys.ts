/**
 * Central registry of `localStorage` keys, so persisted UI state is
 * discoverable in one place and keys can't silently collide or drift.
 *
 * The string *values* are the wire format of saved user settings — changing one
 * loses that setting on next load, so keep them stable. (`eveChatlogsDir` keeps
 * its legacy `"eveLogsDir"` value for that reason.)
 *
 * Not included: `usePersistentState`/`usePersistentSort` pass their own
 * namespaced keys (`route.*`, `sort.*`), and the system-graph uses per-graph
 * template keys (`sysgraph.<id>`); those aren't raw `localStorage` literals.
 */
export const STORAGE_KEYS = {
  // Sidebar layout (Layout.tsx)
  sidebarPins: "sidebar.pins",
  sidebarOrder: "sidebar.order",
  sidebarColors: "sidebar.colors",
  sidebarCollapsed: "sidebar.collapsed",
  // EVE log folders
  eveChatlogsDir: "eveLogsDir", // legacy value; points at the Chatlogs folder
  eveGamelogsDir: "eveGamelogsDir",
  // DPS meter
  dpsWindowSecs: "dps.windowSecs",
  // Local Intel
  localintelSound: "localintel.sound",
  localintelAlertNeutrals: "localintel.alertNeutrals",
  // Production
  importedBlueprints: "production.importedBlueprints",
} as const;
