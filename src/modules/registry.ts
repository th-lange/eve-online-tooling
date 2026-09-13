import type { ComponentType } from "react";
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
import { FeedbackPage } from "./feedback/FeedbackPage";
import { SupportPage } from "./support/SupportPage";
import { PluginsPage } from "./plugins/PluginsPage";
import { ScriptsPage } from "./scripts/ScriptsPage";
import { InfoPanel } from "./info/InfoPanel";
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
  Component: ComponentType;
}

// Page components keyed by module id, layered onto the plain metadata from
// registry-data.ts. Kept separate from that file so registry-data.ts (and
// anything that only needs id/title/description, e.g. feedback's category
// dropdown) never has to import a page component — which is what created the
// former feedback/registry import cycle.
const COMPONENTS: Record<string, ComponentType> = {
  production: ProductionPage,
  trading: TradingPage,
  daytrading: DaytradingPage,
  reprocessing: ReprocessingPage,
  appraisal: AppraisalPage,
  universe: UniversePage,
  "market-search": MarketSearchPage,
  assets: AssetsPage,
  character: CharacterPage,
  notifications: NotificationsPage,
  accounting: AccountingPage,
  transactions: TransactionsPage,
  contracts: ContractsPage,
  lpstore: LpStorePage,
  route: RoutePage,
  "local-intel": LocalIntelPage,
  orders: OrdersPage,
  "industry-jobs": IndustryJobsPage,
  pi: PIPage,
  incursions: IncursionsPage,
  "faction-warfare": FactionWarfarePage,
  pochven: PochvenPage,
  wormholes: WormholesPage,
  exploration: ExplorationPage,
  fitting: FittingPage,
  shopping: ShoppingPage,
  dps: DpsPage,
  pvp: PvpPage,
  info: InfoPanel,
  scripts: ScriptsPage,
  plugins: PluginsPage,
  feedback: FeedbackPage,
  support: SupportPage,
};

export const modules: ModuleDef[] = MODULE_METADATA.map((meta) => {
  const Component = COMPONENTS[meta.id];
  if (!Component) {
    throw new Error(`registry: no page component registered for "${meta.id}"`);
  }
  return { ...meta, Component };
});
