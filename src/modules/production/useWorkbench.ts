import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  marketRegions,
  ownedBlueprints,
  productionDecryptors,
  productionProfit,
  rosterStock,
  sdeUpdate,
  type PriceBasis,
  type ProfitBreakdown,
  type ProfitParams,
} from "../../lib/api";
import { useTypeIdLists } from "../../lib/useSavedLists";
import { classifyPaste, dedupNames, toggle, uniqueSorted } from "./helpers";
import { parseItems } from "../shopping/parse";
import {
  FORGE,
  IMPORTED_BP_KEY,
  loadImported,
  STRUCTURES,
  type ImportedBlueprint,
  type ResultsView,
  type StructureKey,
  type Tab,
} from "./types";
import type { ActiveFilter, WorkbenchState } from "./workbenchTypes";

export function useWorkbench(): WorkbenchState {
  const [tab, setTab] = useState<Tab>("market");
  const [view, setView] = useState<ResultsView>("opportunities");

  // Pricing/cost params — changing these re-runs the calculation.
  const [regionId, setRegionId] = useState(FORGE);
  const [stationId, setStationId] = useState<number | null>(null);
  const [runs, setRuns] = useState(1);
  const [me, setMe] = useState(0);
  const [useOwnedMe, setUseOwnedMe] = useState(true);
  const [useStock, setUseStock] = useState(false);
  const [buildComponents, setBuildComponents] = useState(false);
  const [te, setTe] = useState(0);
  const [timeSkill, setTimeSkill] = useState(5);
  const [structure, setStructure] = useState<StructureKey>("npc");
  // Rig role bonuses (%), composed onto the structure preset. Auto rig×security
  // math varies by patch/security and isn't reliably knowable here, so the user
  // supplies the effective rig bonus (e.g. a T2 ME rig in null ≈ 2.4%).
  const [rigMePct, setRigMePct] = useState(0);
  const [rigTePct, setRigTePct] = useState(0);
  const [rigCostPct, setRigCostPct] = useState(0);
  const [costIndexPct, setCostIndexPct] = useState(5);
  const [facilityTaxPct, setFacilityTaxPct] = useState(0);
  // Sale costs on the product: broker fee + sales tax, subtracted from revenue.
  const [includeSaleCost, setIncludeSaleCost] = useState(false);
  const [sellBrokerPct, setSellBrokerPct] = useState(3);
  const [sellTaxPct, setSellTaxPct] = useState(4.5);
  const [materialBasis, setMaterialBasis] =
    useState<PriceBasis>("sellPercentile");
  const [productBasis, setProductBasis] =
    useState<PriceBasis>("sellPercentile");
  const [productBestHub, setProductBestHub] = useState(false);
  const [blueprintCostPerRun, setBlueprintCostPerRun] = useState(0);
  const [inventionSkill, setInventionSkill] = useState(5);
  const [decryptorTypeId, setDecryptorTypeId] = useState<number | null>(null);

  // Client-side filters — applied instantly to the results.
  const [name, setName] = useState("");
  const [categories, setCategories] = useState<Set<string>>(new Set());
  const [metas, setMetas] = useState<Set<string>>(new Set());
  const [ownedOnly, setOwnedOnly] = useState(false);
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [minRoiPct, setMinRoiPct] = useState("");
  const [minVolume, setMinVolume] = useState("");
  const [pasteList, setPasteList] = useState("");
  const [pasteMinRoiPct, setPasteMinRoiPct] = useState("20");

  const regions = useQuery({
    queryKey: ["market", "regions"],
    queryFn: marketRegions,
  });
  const owned = useQuery({
    queryKey: ["owned", "blueprints"],
    queryFn: ownedBlueprints,
  });
  const decryptors = useQuery({
    queryKey: ["production", "decryptors"],
    queryFn: productionDecryptors,
  });
  const stock = useQuery({
    queryKey: ["roster", "stock"],
    queryFn: rosterStock,
    enabled: useStock,
  });
  const ownedSet = useMemo(
    () => new Set(owned.data?.map((b) => b.typeId)),
    [owned.data],
  );
  const ownedCount = ownedSet.size;
  const [imported, setImported] = useState<ImportedBlueprint[]>(loadImported);
  function saveImported(next: ImportedBlueprint[]) {
    setImported(next);
    try {
      localStorage.setItem(IMPORTED_BP_KEY, JSON.stringify(next));
    } catch {
      // storage may be unavailable; the overlay still works in-memory
    }
  }

  // Best researched ME/TE per blueprint type (highest across owned copies, then
  // imported entries layered on so you can model BPs you don't own yet).
  const ownedMe = useMemo(() => {
    const map: Record<number, number> = {};
    for (const b of owned.data ?? []) {
      map[b.typeId] = Math.max(map[b.typeId] ?? 0, b.materialEfficiency);
    }
    for (const b of imported)
      map[b.typeId] = Math.max(map[b.typeId] ?? 0, b.me);
    return map;
  }, [owned.data, imported]);
  const ownedTe = useMemo(() => {
    const map: Record<number, number> = {};
    for (const b of owned.data ?? []) {
      map[b.typeId] = Math.max(map[b.typeId] ?? 0, b.timeEfficiency);
    }
    for (const b of imported)
      map[b.typeId] = Math.max(map[b.typeId] ?? 0, b.te);
    return map;
  }, [owned.data, imported]);
  const update = useMutation({ mutationFn: () => sdeUpdate(false) });
  const [rows, setRows] = useState<ProfitBreakdown[]>([]);
  const profit = useMutation({
    mutationFn: (p: ProfitParams) => productionProfit(p),
    onSuccess: setRows,
  });

  const { favorites, blacklist, setList, toggleFavorite, blacklistRow } =
    useTypeIdLists("production", setRows, (r) => r.blueprintTypeId);

  // The pricing/cost settings that actually drive a re-price (the client-side
  // filters are excluded — they apply instantly). A change to any of these
  // makes the current results table stale until the next Calculate.
  const settings = {
    regionId,
    stationId,
    runs,
    me,
    useOwnedMe,
    useStock,
    buildComponents,
    te,
    timeSkill,
    structure,
    rigMePct,
    rigTePct,
    rigCostPct,
    costIndexPct,
    facilityTaxPct,
    includeSaleCost,
    sellBrokerPct,
    sellTaxPct,
    materialBasis,
    productBasis,
    productBestHub,
    blueprintCostPerRun,
    inventionSkill,
    decryptorTypeId,
  };
  // Snapshot of `settings` as of the last calculate, to detect staleness.
  const [calcSettings, setCalcSettings] = useState(settings);
  const dirtyCount = (
    Object.keys(settings) as (keyof typeof settings)[]
  ).filter((k) => settings[k] !== calcSettings[k]).length;
  const isStale = dirtyCount > 0 && rows.length > 0;

  function calculate() {
    setCalcSettings(settings);
    profit.mutate({
      regionId,
      stationId,
      runs,
      me,
      ownedMe: useOwnedMe ? ownedMe : {},
      te,
      ownedTe: useOwnedMe ? ownedTe : {},
      timeSkill,
      // Compose structure preset with rig bonuses (material/cost multiplicative).
      structureTePct: STRUCTURES[structure].tePct + rigTePct,
      meBonus: STRUCTURES[structure].meBonus * (1 - rigMePct / 100),
      costBonus:
        1 - (1 - STRUCTURES[structure].costBonus) * (1 - rigCostPct / 100),
      stock: useStock ? (stock.data ?? {}) : {},
      buildComponents,
      systemCostIndex: costIndexPct / 100,
      facilityTax: facilityTaxPct / 100,
      includeSalesCost: includeSaleCost,
      salesTax: sellTaxPct / 100,
      brokerFee: sellBrokerPct / 100,
      materialBasis,
      productBasis,
      blueprintCostPerRun,
      inventionSkillLevel: inventionSkill,
      decryptorTypeId,
      productBestHub,
    });
  }

  // Optional debounced auto-recalc: when on, a settings change re-prices itself
  // after a short pause instead of waiting for a manual Calculate.
  const [autoRecalc, setAutoRecalc] = useState(false);
  const calcRef = useRef(calculate);
  calcRef.current = calculate;
  useEffect(() => {
    if (!autoRecalc || !isStale) return;
    const t = setTimeout(() => calcRef.current(), 600);
    return () => clearTimeout(t);
  }, [autoRecalc, isStale, dirtyCount]);

  // Rank once on first load.
  useEffect(() => {
    calculate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const categoryOptions = useMemo(
    () => uniqueSorted(rows, (r) => r.category),
    [rows],
  );
  const metaOptions = useMemo(
    () => uniqueSorted(rows, (r) => r.metaGroup),
    [rows],
  );

  // "Paste list" filter — parse pasted item names (reusing the shopping paste
  // parser), dedup (keeping original casing), then classify against the full
  // priced set for the build-and-sell verdict.
  const pastedItems = useMemo(
    () => dedupNames(parseItems(pasteList)),
    [pasteList],
  );
  const pastedNames = useMemo(
    () => new Set(pastedItems.map((n) => n.toLowerCase())),
    [pastedItems],
  );
  const pasteMinRoi =
    pasteMinRoiPct.trim() === "" ? 0 : Number(pasteMinRoiPct) / 100;
  const pasteVerdict = useMemo(
    () =>
      pastedItems.length === 0
        ? null
        : classifyPaste(pastedItems, rows, pasteMinRoi),
    [pastedItems, rows, pasteMinRoi],
  );

  const filtered = useMemo(() => {
    const needle = name.trim().toLowerCase();
    const minRoi = minRoiPct.trim() === "" ? null : Number(minRoiPct) / 100;
    const minVol =
      stationId === null || minVolume.trim() === "" ? null : Number(minVolume);
    return rows.filter((r) => {
      if (pastedNames.size > 0 && !pastedNames.has(r.productName.toLowerCase()))
        return false;
      if (
        needle &&
        ![r.productName, r.category, r.group, r.metaGroup]
          .filter(Boolean)
          .join(" ")
          .toLowerCase()
          .includes(needle)
      )
        return false;
      if (categories.size > 0 && !(r.category && categories.has(r.category)))
        return false;
      if (metas.size > 0 && !(r.metaGroup && metas.has(r.metaGroup)))
        return false;
      if (ownedOnly && !ownedSet.has(r.blueprintTypeId)) return false;
      if (favoritesOnly && !r.favorite) return false;
      if (minRoi !== null && (r.roi ?? -Infinity) < minRoi) return false;
      if (minVol !== null && (r.productVolume ?? 0) < minVol) return false;
      return true;
    });
  }, [
    rows,
    name,
    categories,
    metas,
    ownedOnly,
    favoritesOnly,
    ownedSet,
    minRoiPct,
    minVolume,
    stationId,
    pastedNames,
  ]);

  const stations = regions.data?.find((r) => r.id === regionId)?.stations ?? [];
  const rowsByType = useMemo(
    () => new Map(rows.map((r) => [r.blueprintTypeId, r])),
    [rows],
  );

  // Every active client-side filter as a removable chip, so what's constraining
  // the ranking is visible above the table rather than buried across four tabs.
  const activeFilters: ActiveFilter[] = [];
  if (name.trim())
    activeFilters.push({
      key: "name",
      label: `“${name.trim()}”`,
      clear: () => setName(""),
    });
  for (const c of categories)
    activeFilters.push({
      key: `cat:${c}`,
      label: c,
      clear: () => setCategories(toggle(categories, c)),
    });
  for (const m of metas)
    activeFilters.push({
      key: `meta:${m}`,
      label: m,
      clear: () => setMetas(toggle(metas, m)),
    });
  if (ownedOnly)
    activeFilters.push({
      key: "owned",
      label: "Owned only",
      clear: () => setOwnedOnly(false),
    });
  if (favoritesOnly)
    activeFilters.push({
      key: "fav",
      label: "Favorites only",
      clear: () => setFavoritesOnly(false),
    });
  if (minRoiPct.trim())
    activeFilters.push({
      key: "roi",
      label: `ROI ≥ ${minRoiPct}%`,
      clear: () => setMinRoiPct(""),
    });
  if (minVolume.trim() && stationId !== null)
    activeFilters.push({
      key: "vol",
      label: `Volume ≥ ${minVolume}`,
      clear: () => setMinVolume(""),
    });
  if (pastedNames.size > 0)
    activeFilters.push({
      key: "paste",
      label: `Pasted list (${pastedNames.size})`,
      clear: () => setPasteList(""),
    });
  function resetAllFilters() {
    setName("");
    setCategories(new Set());
    setMetas(new Set());
    setOwnedOnly(false);
    setFavoritesOnly(false);
    setMinRoiPct("");
    setMinVolume("");
    setPasteList("");
  }

  return {
    tab,
    setTab,
    view,
    setView,
    regionId,
    setRegionId,
    stationId,
    setStationId,
    runs,
    setRuns,
    me,
    setMe,
    useOwnedMe,
    setUseOwnedMe,
    useStock,
    setUseStock,
    buildComponents,
    setBuildComponents,
    te,
    setTe,
    timeSkill,
    setTimeSkill,
    structure,
    setStructure,
    rigMePct,
    setRigMePct,
    rigTePct,
    setRigTePct,
    rigCostPct,
    setRigCostPct,
    costIndexPct,
    setCostIndexPct,
    facilityTaxPct,
    setFacilityTaxPct,
    includeSaleCost,
    setIncludeSaleCost,
    sellBrokerPct,
    setSellBrokerPct,
    sellTaxPct,
    setSellTaxPct,
    materialBasis,
    setMaterialBasis,
    productBasis,
    setProductBasis,
    productBestHub,
    setProductBestHub,
    blueprintCostPerRun,
    setBlueprintCostPerRun,
    inventionSkill,
    setInventionSkill,
    decryptorTypeId,
    setDecryptorTypeId,
    name,
    setName,
    categories,
    setCategories,
    metas,
    setMetas,
    ownedOnly,
    setOwnedOnly,
    favoritesOnly,
    setFavoritesOnly,
    minRoiPct,
    setMinRoiPct,
    minVolume,
    setMinVolume,
    pasteList,
    setPasteList,
    pasteMinRoiPct,
    setPasteMinRoiPct,
    regions,
    owned,
    decryptors,
    stock,
    favorites,
    blacklist,
    update,
    profit,
    ownedSet,
    ownedCount,
    ownedMe,
    ownedTe,
    rows,
    setRows,
    categoryOptions,
    metaOptions,
    pastedItems,
    pastedNames,
    pasteMinRoi,
    pasteVerdict,
    filtered,
    stations,
    rowsByType,
    activeFilters,
    isStale,
    dirtyCount,
    imported,
    saveImported,
    toggleFavorite,
    blacklistRow,
    calculate,
    resetAllFilters,
    setList,
    autoRecalc,
    setAutoRecalc,
  };
}
