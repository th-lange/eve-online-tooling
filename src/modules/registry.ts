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
import { ContractsPage } from "./contracts/ContractsPage";
import { LpStorePage } from "./lpstore/LpStorePage";
import { RoutePage } from "./route/RoutePage";
import { LocalIntelPage } from "./localintel/LocalIntelPage";
import { OrdersPage } from "./orders/OrdersPage";
import { IndustryJobsPage } from "./industry/IndustryJobsPage";
import { WormholesPage } from "./wormholes/WormholesPage";
import { FittingPage } from "./fitting/FittingPage";

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
  /** Page component rendered for this module. */
  Component: ComponentType;
}

export const modules: ModuleDef[] = [
  {
    id: "production",
    title: "Production",
    description: "Rank what you can build by build-vs-buy profit.",
    Component: ProductionPage,
  },
  {
    id: "trading",
    title: "Station Trading",
    description: "Rank items by buy→sell margin at a market hub.",
    Component: TradingPage,
  },
  {
    id: "daytrading",
    title: "Daytrading",
    description: "Cross-region price gaps on the same item, ranked by ISK/m³.",
    Component: DaytradingPage,
  },
  {
    id: "reprocessing",
    title: "Reprocessing",
    description: "Rank ores by reprocess-vs-sell at your refining efficiency.",
    Component: ReprocessingPage,
  },
  {
    id: "appraisal",
    title: "Appraisal",
    description: "Paste items → buy/sell ISK value and cargo volume.",
    Component: AppraisalPage,
  },
  {
    id: "universe",
    title: "Universe",
    description: "Browse every item type with stats and dogma attributes.",
    Component: UniversePage,
  },
  {
    id: "market-search",
    title: "Market Search",
    description: "Find an item's sell orders across the market, plus price & volume history.",
    Component: MarketSearchPage,
  },
  {
    id: "assets",
    title: "Assets",
    description: "Value your holdings and find where each stack sells best.",
    Component: AssetsPage,
  },
  {
    id: "character",
    title: "Character",
    description: "Skills, standings and R&D research.",
    Component: CharacterPage,
  },
  {
    id: "accounting",
    title: "Accounting",
    description: "Wallet history and FIFO realized profit.",
    Component: AccountingPage,
  },
  {
    id: "contracts",
    title: "Public Contracts",
    description: "Find item-exchange contracts worth more than their price.",
    Component: ContractsPage,
  },
  {
    id: "lpstore",
    title: "LP Store",
    description: "Rank loyalty-store offers by ISK per LP.",
    Component: LpStorePage,
  },
  {
    id: "route",
    title: "Route",
    description: "Per-system jumps & kills (last hour) across known space.",
    Component: RoutePage,
  },
  {
    id: "local-intel",
    title: "Local Intel",
    description: "Paste Local → classify pilots by standing, corp and alliance.",
    Component: LocalIntelPage,
  },
  {
    id: "orders",
    title: "Market Orders",
    description: "Your open buy/sell orders with undercut detection.",
    Component: OrdersPage,
  },
  {
    id: "industry-jobs",
    title: "Industry Jobs",
    description: "Running and delivered industry jobs — what's cooking.",
    Component: IndustryJobsPage,
  },
  {
    id: "wormholes",
    title: "Wormholes",
    description: "Map your wormhole chain with mass/EOL tracking.",
    Component: WormholesPage,
  },
  {
    id: "fitting",
    title: "Fitting",
    description: "Build ship fits and validate slots, resources and price.",
    Component: FittingPage,
  },
];
