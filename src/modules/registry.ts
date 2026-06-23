import type { ComponentType } from "react";
import { ProductionPage } from "./production/ProductionPage";
import { TradingPage } from "./trading/TradingPage";

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
];
