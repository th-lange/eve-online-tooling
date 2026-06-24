import type { ComponentType } from "react";
import { ProductionPage } from "./production/ProductionPage";
import { TradingPage } from "./trading/TradingPage";
import { DaytradingPage } from "./daytrading/DaytradingPage";
import { ReprocessingPage } from "./reprocessing/ReprocessingPage";
import { AppraisalPage } from "./appraisal/AppraisalPage";
import { UniversePage } from "./universe/UniversePage";
import { MarketHistoryPage } from "./markethistory/MarketHistoryPage";
import { AssetsPage } from "./assets/AssetsPage";

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
    id: "market-history",
    title: "Market History",
    description: "Daily price & volume trend for an item in a region.",
    Component: MarketHistoryPage,
  },
  {
    id: "assets",
    title: "Assets",
    description: "Value your holdings and find where each stack sells best.",
    Component: AssetsPage,
  },
];
