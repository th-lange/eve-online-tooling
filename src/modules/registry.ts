import { lazy, type ComponentType, type LazyExoticComponent } from "react";
import {
  MODULE_GROUPS,
  MODULE_METADATA,
  type ModuleGroup,
  type ModuleMeta,
} from "./registry-data";

export { MODULE_GROUPS };
export type { ModuleGroup };

// A feature module = a nav entry + the page rendered at `/{id}`. Adding a new
// module (daytrading, station-trading, …) is a metadata entry in
// registry-data.ts plus a one-line Component mapping below; the Layout nav
// and router are driven entirely by the resulting `modules` list.
export interface ModuleDef extends ModuleMeta {
  /** Page component rendered for this module. */
  Component: ComponentType | LazyExoticComponent<ComponentType>;
}

// Page components keyed by module id, layered onto the plain metadata from
// registry-data.ts. Kept separate from that file so registry-data.ts (and
// anything that only needs id/title/description, e.g. feedback's category
// dropdown) never has to import a page component — which is what created the
// former feedback/registry import cycle.
// Each page is loaded as its own lazy chunk (`React.lazy`) so the initial
// bundle no longer ships all 33 module pages up front — a page's code is
// fetched only when its tab is first opened. `ModuleHost` already mounts pages
// on first visit and keeps them mounted, so this splits the download without
// changing runtime behaviour. The literal `import()` per entry is what lets
// Vite emit each page as a separate chunk.
const page = (
  loader: () => Promise<Record<string, ComponentType>>,
  name: string,
): LazyExoticComponent<ComponentType> =>
  lazy(() => loader().then((m) => ({ default: m[name] })));

const COMPONENTS: Record<string, LazyExoticComponent<ComponentType>> = {
  production: page(() => import("./production/ProductionPage"), "ProductionPage"),
  trading: page(() => import("./trading/TradingPage"), "TradingPage"),
  daytrading: page(() => import("./daytrading/DaytradingPage"), "DaytradingPage"),
  reprocessing: page(
    () => import("./reprocessing/ReprocessingPage"),
    "ReprocessingPage",
  ),
  appraisal: page(() => import("./appraisal/AppraisalPage"), "AppraisalPage"),
  universe: page(() => import("./universe/UniversePage"), "UniversePage"),
  "market-search": page(
    () => import("./marketsearch/MarketSearchPage"),
    "MarketSearchPage",
  ),
  assets: page(() => import("./assets/AssetsPage"), "AssetsPage"),
  character: page(() => import("./character/CharacterPage"), "CharacterPage"),
  notifications: page(
    () => import("./notifications/NotificationsPage"),
    "NotificationsPage",
  ),
  accounting: page(() => import("./accounting/AccountingPage"), "AccountingPage"),
  transactions: page(
    () => import("./transactions/TransactionsPage"),
    "TransactionsPage",
  ),
  contracts: page(() => import("./contracts/ContractsPage"), "ContractsPage"),
  lpstore: page(() => import("./lpstore/LpStorePage"), "LpStorePage"),
  route: page(() => import("./route/RoutePage"), "RoutePage"),
  "local-intel": page(
    () => import("./localintel/LocalIntelPage"),
    "LocalIntelPage",
  ),
  orders: page(() => import("./orders/OrdersPage"), "OrdersPage"),
  "industry-jobs": page(
    () => import("./industry/IndustryJobsPage"),
    "IndustryJobsPage",
  ),
  pi: page(() => import("./pi/PIPage"), "PIPage"),
  incursions: page(() => import("./incursions/IncursionsPage"), "IncursionsPage"),
  "faction-warfare": page(
    () => import("./faction-warfare/FactionWarfarePage"),
    "FactionWarfarePage",
  ),
  pochven: page(() => import("./pochven/PochvenPage"), "PochvenPage"),
  wormholes: page(() => import("./wormholes/WormholesPage"), "WormholesPage"),
  exploration: page(
    () => import("./exploration/ExplorationPage"),
    "ExplorationPage",
  ),
  fitting: page(() => import("./fitting/FittingPage"), "FittingPage"),
  shopping: page(() => import("./shopping/ShoppingPage"), "ShoppingPage"),
  dps: page(() => import("./dpsmeter/DpsPage"), "DpsPage"),
  pvp: page(() => import("./pvp/PvpPage"), "PvpPage"),
  info: page(() => import("./info/InfoPanel"), "InfoPanel"),
  scripts: page(() => import("./scripts/ScriptsPage"), "ScriptsPage"),
  plugins: page(() => import("./plugins/PluginsPage"), "PluginsPage"),
  logs: page(() => import("./logs/LogsPage"), "LogsPage"),
  feedback: page(() => import("./feedback/FeedbackPage"), "FeedbackPage"),
  support: page(() => import("./support/SupportPage"), "SupportPage"),
};

export const modules: ModuleDef[] = MODULE_METADATA.map((meta) => {
  const Component = COMPONENTS[meta.id];
  if (!Component) {
    throw new Error(`registry: no page component registered for "${meta.id}"`);
  }
  return { ...meta, Component };
});
