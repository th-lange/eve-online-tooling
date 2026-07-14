import type { ComponentType } from "react";
import {
  Crosshair,
  Heart,
  Puzzle,
  Terminal,
  Bell,
  type LucideIcon,
} from "lucide-react";
import { ProductionPage } from "./production/ProductionPage";
import { TradingPage } from "./trading/TradingPage";
import { DaytradingPage } from "./daytrading/DaytradingPage";
import { ReprocessingPage } from "./reprocessing/ReprocessingPage";
import { AppraisalPage } from "./appraisal/AppraisalPage";
import { UniversePage } from "./universe/UniversePage";
import { MarketSearchPage } from "./marketsearch/MarketSearchPage";
import { AssetsPage } from "./assets/AssetsPage";
import { CharacterPage } from "./character/CharacterPage";
import { AccountingPage } from "./accounting/AccountingPage";
import { TransactionsPage } from "./transactions/TransactionsPage";
import { ContractsPage } from "./contracts/ContractsPage";
import { LpStorePage } from "./lpstore/LpStorePage";
import { RoutePage } from "./route/RoutePage";
import { LocalIntelPage } from "./localintel/LocalIntelPage";
import { OrdersPage } from "./orders/OrdersPage";
import { IndustryJobsPage } from "./industry/IndustryJobsPage";
import { PIPage } from "./pi/PIPage";
import { WormholesPage } from "./wormholes/WormholesPage";
import { ExplorationPage } from "./exploration/ExplorationPage";
import { PochvenPage } from "./pochven/PochvenPage";
import { IncursionsPage } from "./incursions/IncursionsPage";
import { FactionWarfarePage } from "./faction-warfare/FactionWarfarePage";
import { NotificationsPage } from "./notifications/NotificationsPage";
import { FittingPage } from "./fitting/FittingPage";
import { ShoppingPage } from "./shopping/ShoppingPage";
import { DpsPage } from "./dpsmeter/DpsPage";
import { PvpPage } from "./pvp/PvpPage";
import { SupportPage } from "./support/SupportPage";
import { PluginsPage } from "./plugins/PluginsPage";
import { ScriptsPage } from "./scripts/ScriptsPage";
import { InfoPanel } from "./info/InfoPanel";

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

// A feature module = a nav entry + the page rendered at `/{id}`. Adding a new
// module (daytrading, station-trading, …) is a one-line entry here plus its
// page component; the Layout nav and router are driven entirely by this list.
export interface ModuleDef {
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
  /** Page component rendered for this module. */
  Component: ComponentType;
}

export const modules: ModuleDef[] = [
  {
    id: "production",
    title: "Production",
    description: "Rank what you can build by build-vs-buy profit.",
    group: "industry",
    Component: ProductionPage,
  },
  {
    id: "trading",
    title: "Station Trading",
    description: "Rank items by buy→sell margin at a market hub.",
    group: "trading",
    Component: TradingPage,
  },
  {
    id: "daytrading",
    title: "Daytrading",
    description: "Cross-region price gaps on the same item, ranked by ISK/m³.",
    group: "trading",
    Component: DaytradingPage,
  },
  {
    id: "reprocessing",
    title: "Reprocessing",
    description: "Rank ores by reprocess-vs-sell at your refining efficiency.",
    group: "industry",
    Component: ReprocessingPage,
  },
  {
    id: "appraisal",
    title: "Appraisal",
    description: "Paste items → buy/sell ISK value and cargo volume.",
    group: "market",
    Component: AppraisalPage,
  },
  {
    id: "universe",
    title: "Universe",
    description: "Browse every item type with stats and dogma attributes.",
    group: "market",
    Component: UniversePage,
  },
  {
    id: "market-search",
    title: "Market Search",
    description:
      "Find an item's sell orders across the market, plus price & volume history.",
    group: "market",
    Component: MarketSearchPage,
  },
  {
    id: "assets",
    title: "Assets",
    description: "Value your holdings and find where each stack sells best.",
    group: "character",
    Component: AssetsPage,
  },
  {
    id: "character",
    title: "Character",
    description: "Skills, standings and R&D research.",
    group: "character",
    Component: CharacterPage,
  },
  {
    id: "notifications",
    title: "Notifications",
    description:
      "In-game notification feed — war decs, structure attacks, wallet events.",
    group: "character",
    Component: NotificationsPage,
  },
  {
    id: "accounting",
    title: "Accounting",
    description: "Wallet history and FIFO realized profit.",
    group: "character",
    Component: AccountingPage,
  },
  {
    id: "transactions",
    title: "Transactions",
    description: "Per-fill buy/sell ledger — how each item traded for you.",
    group: "character",
    Component: TransactionsPage,
  },
  {
    id: "contracts",
    title: "Public Contracts",
    description: "Find item-exchange contracts worth more than their price.",
    group: "trading",
    Component: ContractsPage,
  },
  {
    id: "lpstore",
    title: "LP Store",
    description: "Rank loyalty-store offers by ISK per LP.",
    group: "trading",
    Component: LpStorePage,
  },
  {
    id: "route",
    title: "Route",
    description: "Per-system jumps & kills (last hour) across known space.",
    group: "intel",
    Component: RoutePage,
  },
  {
    id: "local-intel",
    title: "Local Intel",
    description:
      "Paste Local → classify pilots by standing, corp and alliance.",
    group: "intel",
    Component: LocalIntelPage,
  },
  {
    id: "orders",
    title: "Market Orders",
    description: "Your open buy/sell orders with undercut detection.",
    group: "trading",
    Component: OrdersPage,
  },
  {
    id: "industry-jobs",
    title: "Industry Jobs",
    description: "Running and delivered industry jobs — what's cooking.",
    group: "industry",
    Component: IndustryJobsPage,
  },
  {
    id: "pi",
    title: "Planetary Interaction",
    description: "Colonies, extractor timers, storage, and input balance.",
    group: "industry",
    Component: PIPage,
  },
  {
    id: "incursions",
    title: "Incursions",
    description: "Active Sansha incursions — staging, influence and state.",
    group: "intel",
    Component: IncursionsPage,
  },
  {
    id: "faction-warfare",
    title: "Faction Warfare",
    description: "Militia control, systems and kills by warzone.",
    group: "intel",
    Component: FactionWarfarePage,
  },
  {
    id: "pochven",
    title: "Pochven",
    description: "Find C729 wormhole entries into Pochven from your region.",
    group: "intel",
    Component: PochvenPage,
  },
  {
    id: "wormholes",
    title: "Wormholes",
    description: "Map your wormhole chain with mass/EOL tracking.",
    group: "intel",
    Component: WormholesPage,
  },
  {
    id: "exploration",
    title: "Exploration",
    description:
      "Reference: combat anomalies and relic/data/DED sites — where, danger, escalations.",
    group: "intel",
    Component: ExplorationPage,
  },
  {
    id: "fitting",
    title: "Fitting",
    description: "Build ship fits and validate slots, resources and price.",
    group: "character",
    Component: FittingPage,
  },
  {
    id: "shopping",
    title: "Shopping Lists",
    description: "Named lists of items to buy, fed from across the app.",
    group: "character",
    Component: ShoppingPage,
  },
  {
    id: "dps",
    title: "DPS Meter",
    description:
      "Live combat meter from your gamelog — DPS, logi and cap, graphed.",
    group: "intel",
    Component: DpsPage,
  },
  {
    id: "pvp",
    title: "PVP",
    description:
      "Paste pilot names → their kills, losses and the fits they fly.",
    group: "intel",
    icon: Crosshair,
    Component: PvpPage,
  },
  {
    id: "scripts",
    title: "Scripts",
    description:
      "Write small Rhai/JS snippets and run them once or on a timed loop.",
    group: "support",
    icon: Terminal,
    Component: ScriptsPage,
  },
  {
    id: "info",
    title: "Info Panel",
    description: "Alarms and messages posted by your scripts and plugins.",
    group: "support",
    icon: Bell,
    Component: InfoPanel,
  },
  {
    id: "plugins",
    title: "Plugins",
    description: "Activate or deactivate installed third-party plugins.",
    group: "support",
    icon: Puzzle,
    Component: PluginsPage,
  },
  {
    id: "support",
    title: "Support my work",
    description: "Creator code and buddy invite link — support the project.",
    group: "support",
    icon: Heart,
    Component: SupportPage,
  },
];
