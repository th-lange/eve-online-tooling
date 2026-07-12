import type { UseMutationResult, UseQueryResult } from "@tanstack/react-query";
import type {
  Decryptor,
  ListItem,
  ListName,
  OwnedBlueprint,
  PriceBasis,
  ProfitBreakdown,
  ProfitParams,
  Region,
  SdeStatus,
} from "../../lib/api";
import type { PasteVerdictResult } from "./helpers";
import type {
  ImportedBlueprint,
  ResultsView,
  StructureKey,
  Tab,
} from "./types";

/** An active client-side filter, rendered as a removable chip. */
export interface ActiveFilter {
  key: string;
  label: string;
  clear: () => void;
}

/** Everything the production workbench needs to render: state, queries,
 *  derivations, and handlers, as one object so the panels can stay
 *  presentational and destructure just what they use. */
export interface WorkbenchState {
  tab: Tab;
  setTab: (t: Tab) => void;
  view: ResultsView;
  setView: (v: ResultsView) => void;

  regionId: number;
  setRegionId: (id: number) => void;
  stationId: number | null;
  setStationId: (id: number | null) => void;
  runs: number;
  setRuns: (n: number) => void;
  me: number;
  setMe: (n: number) => void;
  useOwnedMe: boolean;
  setUseOwnedMe: (b: boolean) => void;
  useStock: boolean;
  setUseStock: (b: boolean) => void;
  buildComponents: boolean;
  setBuildComponents: (b: boolean) => void;
  te: number;
  setTe: (n: number) => void;
  timeSkill: number;
  setTimeSkill: (n: number) => void;
  structure: StructureKey;
  setStructure: (s: StructureKey) => void;
  rigMePct: number;
  setRigMePct: (n: number) => void;
  rigTePct: number;
  setRigTePct: (n: number) => void;
  rigCostPct: number;
  setRigCostPct: (n: number) => void;
  costIndexPct: number;
  setCostIndexPct: (n: number) => void;
  facilityTaxPct: number;
  setFacilityTaxPct: (n: number) => void;
  includeSaleCost: boolean;
  setIncludeSaleCost: (b: boolean) => void;
  sellBrokerPct: number;
  setSellBrokerPct: (n: number) => void;
  sellTaxPct: number;
  setSellTaxPct: (n: number) => void;
  materialBasis: PriceBasis;
  setMaterialBasis: (b: PriceBasis) => void;
  productBasis: PriceBasis;
  setProductBasis: (b: PriceBasis) => void;
  productBestHub: boolean;
  setProductBestHub: (b: boolean) => void;
  blueprintCostPerRun: number;
  setBlueprintCostPerRun: (n: number) => void;
  inventionSkill: number;
  setInventionSkill: (n: number) => void;
  decryptorTypeId: number | null;
  setDecryptorTypeId: (id: number | null) => void;

  name: string;
  setName: (s: string) => void;
  categories: Set<string>;
  setCategories: (s: Set<string>) => void;
  metas: Set<string>;
  setMetas: (s: Set<string>) => void;
  ownedOnly: boolean;
  setOwnedOnly: (b: boolean) => void;
  favoritesOnly: boolean;
  setFavoritesOnly: (b: boolean) => void;
  minRoiPct: string;
  setMinRoiPct: (s: string) => void;
  minVolume: string;
  setMinVolume: (s: string) => void;
  pasteList: string;
  setPasteList: (s: string) => void;
  pasteMinRoiPct: string;
  setPasteMinRoiPct: (s: string) => void;

  regions: UseQueryResult<Region[], Error>;
  owned: UseQueryResult<OwnedBlueprint[], Error>;
  decryptors: UseQueryResult<Decryptor[], Error>;
  stock: UseQueryResult<Record<string, number>, Error>;
  favorites: UseQueryResult<ListItem[], Error>;
  blacklist: UseQueryResult<ListItem[], Error>;
  update: UseMutationResult<SdeStatus, Error, void, unknown>;
  profit: UseMutationResult<ProfitBreakdown[], Error, ProfitParams, unknown>;

  ownedSet: Set<number>;
  ownedCount: number;
  ownedMe: Record<number, number>;
  ownedTe: Record<number, number>;
  rows: ProfitBreakdown[];
  setRows: (rows: ProfitBreakdown[]) => void;
  categoryOptions: string[];
  metaOptions: string[];
  pastedItems: string[];
  pastedNames: Set<string>;
  pasteMinRoi: number;
  pasteVerdict: PasteVerdictResult | null;
  filtered: ProfitBreakdown[];
  stations: Region["stations"];
  rowsByType: Map<number, ProfitBreakdown>;
  activeFilters: ActiveFilter[];
  isStale: boolean;
  dirtyCount: number;

  imported: ImportedBlueprint[];
  saveImported: (next: ImportedBlueprint[]) => void;
  toggleFavorite: (r: ProfitBreakdown) => void;
  blacklistRow: (r: ProfitBreakdown) => void;
  calculate: () => void;
  resetAllFilters: () => void;
  setList: UseMutationResult<
    void,
    Error,
    { list: ListName; typeId: number; add: boolean },
    unknown
  >;
  autoRecalc: boolean;
  setAutoRecalc: (fn: (a: boolean) => boolean) => void;
}
