import {
  Crosshair,
  Heart,
  MessageSquare,
  Puzzle,
  ScrollText,
  Terminal,
  Bell,
  type LucideIcon,
} from "lucide-react";

/** Sidebar section a module belongs to (the nav's information architecture). */
export type ModuleGroup =
  | "industry"
  | "trading"
  | "market"
  | "character"
  | "intel"
  | "support"
  | "plugins";

/** Section labels + display order, driving the grouped sidebar nav (#224). */
export const MODULE_GROUPS: { key: ModuleGroup; label: string }[] = [
  { key: "industry", label: "Industry" },
  { key: "trading", label: "Trading" },
  { key: "market", label: "Market" },
  { key: "character", label: "Characters" },
  { key: "intel", label: "Combat / Intel" },
  { key: "support", label: "Support" },
  { key: "plugins", label: "Plugins" },
];

// Plain per-module metadata — deliberately has no page-component reference, so
// this file can be imported both by registry.ts (which layers each module's
// Component on top, see COMPONENTS there) and by anything that only needs the
// module list (e.g. feedback's category dropdown) without forming an import
// cycle with registry.ts (which imports every page component, including
// FeedbackPage).
export interface ModuleMeta {
  /** URL segment and stable key, e.g. "production". */
  id: string;
  /** Nav label. */
  title: string;
  /** Short description shown in the UI. */
  description: string;
  /** Sidebar section this module is filed under. */
  group: ModuleGroup;
  /** Optional nav icon (lucide) shown before the title. */
  icon?: LucideIcon;
  /** When true the module is inactive until a character is logged in: the nav
   *  and command palette leave it out, and its page says so. */
  requiresCharacter?: boolean;
}

// Note: this list isn't strictly 1:1 with src-tauri/src/modules/. Some entries are
// views over a shared service (universe -> sde, market-search -> market), some share
// one Rust module (incursions + faction-warfare -> modules/intel; transactions ->
// modules/accounting), and some are backend-free static pages (exploration, support).
export const MODULE_METADATA: ModuleMeta[] = [
  {
    id: "production",
    title: "Production",
    description: "Rank what you can build by build-vs-buy profit.",
    group: "industry",
  },
  {
    id: "trading",
    title: "Station Trading",
    description: "Rank items by buy→sell margin at a market hub.",
    group: "trading",
  },
  {
    id: "daytrading",
    title: "Daytrading",
    description: "Cross-region price gaps on the same item, ranked by ISK/m³.",
    group: "trading",
  },
  {
    id: "reprocessing",
    title: "Reprocessing",
    description: "Rank ores by reprocess-vs-sell at your refining efficiency.",
    group: "industry",
  },
  {
    id: "appraisal",
    title: "Appraisal",
    description: "Paste items → buy/sell ISK value and cargo volume.",
    group: "market",
  },
  {
    id: "universe",
    title: "Universe",
    description: "Browse every item type with stats and dogma attributes.",
    group: "market",
  },
  {
    id: "market-search",
    title: "Market Search",
    description:
      "Find an item's sell orders across the market, plus price & volume history.",
    group: "market",
  },
  {
    id: "assets",
    title: "Assets",
    description: "Value your holdings and find where each stack sells best.",
    group: "character",
  },
  {
    id: "character",
    title: "Character",
    description: "Skills, standings and R&D research.",
    group: "character",
  },
  {
    id: "notifications",
    title: "Notifications",
    description:
      "In-game notification feed — war decs, structure attacks, wallet events.",
    group: "character",
  },
  {
    id: "accounting",
    title: "Accounting",
    description: "Wallet history and FIFO realized profit.",
    group: "character",
  },
  {
    id: "transactions",
    title: "Transactions",
    description: "Per-fill buy/sell ledger — how each item traded for you.",
    group: "character",
  },
  {
    id: "contracts",
    title: "Public Contracts",
    description: "Find item-exchange contracts worth more than their price.",
    group: "trading",
  },
  {
    id: "lpstore",
    title: "LP Store",
    description: "Rank loyalty-store offers by ISK per LP.",
    group: "trading",
  },
  {
    id: "route",
    title: "Route",
    description: "Per-system jumps & kills (last hour) across known space.",
    group: "intel",
  },
  {
    id: "local-intel",
    title: "Local Intel",
    description:
      "Paste Local → classify pilots by standing, corp and alliance.",
    group: "intel",
  },
  {
    id: "orders",
    title: "Market Orders",
    description: "Your open buy/sell orders with undercut detection.",
    group: "trading",
  },
  {
    id: "industry-jobs",
    title: "Industry Jobs",
    description: "Running and delivered industry jobs — what's cooking.",
    group: "industry",
  },
  {
    id: "pi",
    title: "Planetary Interaction",
    description: "Colonies, extractor timers, storage, and input balance.",
    group: "industry",
  },
  {
    id: "incursions",
    title: "Incursions",
    description: "Active Sansha incursions — staging, influence and state.",
    group: "intel",
  },
  {
    id: "faction-warfare",
    title: "Faction Warfare",
    description: "Militia control, systems and kills by warzone.",
    group: "intel",
  },
  {
    id: "pochven",
    title: "Pochven",
    description: "Find C729 wormhole entries into Pochven from your region.",
    group: "intel",
  },
  {
    id: "wormholes",
    title: "Wormholes",
    description: "Map your wormhole chain with mass/EOL tracking.",
    group: "intel",
  },
  {
    id: "exploration",
    title: "Exploration",
    description:
      "Reference: combat anomalies and relic/data/DED sites — where, danger, escalations.",
    group: "intel",
  },
  {
    id: "fitting",
    title: "Fitting",
    description: "Build ship fits and validate slots, resources and price.",
    group: "character",
  },
  {
    id: "shopping",
    title: "Shopping Lists",
    description: "Named lists of items to buy, fed from across the app.",
    group: "character",
  },
  {
    id: "dps",
    title: "DPS Meter",
    description:
      "Live combat meter from your gamelog — DPS, logi and cap, graphed.",
    group: "intel",
  },
  {
    id: "pvp",
    title: "PVP",
    description:
      "Paste pilot names → their kills, losses and the fits they fly.",
    group: "intel",
    icon: Crosshair,
  },
  {
    id: "info",
    title: "Info Panel",
    description: "Alarms and messages posted by your scripts and plugins.",
    group: "support",
    icon: Bell,
  },
  {
    id: "scripts",
    title: "Scripts",
    description:
      "Write small Rhai/JS snippets and run them once or on a timed loop.",
    group: "support",
    icon: Terminal,
  },
  {
    id: "plugins",
    title: "Plugins",
    description: "Activate or deactivate installed third-party plugins.",
    group: "support",
    icon: Puzzle,
  },
  {
    id: "logs",
    title: "Logs",
    description:
      "Live error and warning log from the frontend and Rust backend.",
    group: "support",
    icon: ScrollText,
  },
  {
    id: "feedback",
    title: "Feedback",
    description:
      "Rate a module, report a bug, or ask for a feature — straight to the maintainer.",
    group: "support",
    icon: MessageSquare,
    requiresCharacter: true,
  },
  {
    id: "support",
    title: "Support my work",
    description: "Creator code and buddy invite link — support the project.",
    group: "support",
    icon: Heart,
  },
];
