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
  sidebarHidden: "sidebar.hidden",
  sidebarHiddenSeeded: "sidebar.hiddenSeeded",
  // Last-visited module — restored on next launch
  lastVisited: "layout.lastVisited",
  // EVE log folders
  eveChatlogsDir: "eveLogsDir", // legacy value; points at the Chatlogs folder
  eveGamelogsDir: "eveGamelogsDir",
  // Shopping: which list chat capture imports into
  shoppingChatTarget: "shopping.chatTarget",
  // DPS meter
  dpsChartLayout: "dps.chartLayout",
  dpsChartBySource: "dps.chartBySource",
  dpsMiningInterval: "dps.miningInterval",
  dpsLooping: "dps.looping",
  dpsOverviewExportFile: "dps.overviewExportFile",
  dpsCharacter: "dps.character",
  dpsCombatLogCollapsed: "dps.combatLogCollapsed",
  fightOverlayCombatLogCollapsed: "pvp.fightOverlayCombatLogCollapsed",
  fightRecording: "pvp.fightRecording",
  // Local Intel
  localintelSound: "localintel.sound",
  localintelAlertNeutrals: "localintel.alertNeutrals",
  // Production
  importedBlueprints: "production.importedBlueprints",
  // "Support my work" first-run prompt (referral / creator code)
  supportSeen: "support.firstRunSeen",
  // Settings: check for a newer release on startup (default on, opt-out)
  checkForUpdates: "settings.checkForUpdates",
  // Settings: confirm before quitting the app (default on, opt-out)
  confirmBeforeQuit: "settings.confirmBeforeQuit",
  // PI Planner: the commodities currently being planned, kept across visits
  piPlannerPicks: "pi.plannerPicks",
  // Settings: user-registered reminders (what/when/note), fired only while
  // the app is open (see ReminderProvider)
  reminders: "settings.reminders",
} as const;
