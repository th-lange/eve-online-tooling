import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { DataAge } from "../../components/DataAge";
import {
  marketRegions,
  ownedBlueprints,
  productionDecryptors,
  productionGetList,
  productionProfit,
  productionSetList,
  rosterStock,
  sdeStatus,
  sdeUpdate,
  type ListName,
  type PriceBasis,
  type ProfitBreakdown,
  type ProfitParams,
} from "../../lib/api";
import { SdeSetup } from "./SdeSetup";
import { ProfitTable, TableSkeleton } from "./ProfitTable";
import {
  BasisSelect,
  BlueprintLibrary,
  Centered,
  CheckboxGroup,
  Field,
  FilterChips,
  ListView,
  Num,
  StaleBar,
  Tabs,
  ViewTabs,
  toggle,
  uniqueSorted,
} from "./components";

export type ResultsView =
  "opportunities" | "favorites" | "blacklist" | "library";

// Manufacturing structure presets → material/cost/time bonuses (role bonuses).
type StructureKey = "npc" | "raitaru" | "azbel" | "sotiyo";
const STRUCTURES: Record<
  StructureKey,
  { label: string; meBonus: number; costBonus: number; tePct: number }
> = {
  npc: { label: "NPC station", meBonus: 1.0, costBonus: 0, tePct: 0 },
  raitaru: { label: "Raitaru", meBonus: 0.99, costBonus: 0.03, tePct: 15 },
  azbel: { label: "Azbel", meBonus: 0.99, costBonus: 0.04, tePct: 20 },
  sotiyo: { label: "Sotiyo", meBonus: 0.99, costBonus: 0.05, tePct: 30 },
};

/** A blueprint the user imported to model (not necessarily owned via ESI). */
export interface ImportedBlueprint {
  typeId: number;
  name: string;
  me: number;
  te: number;
}

const IMPORTED_BP_KEY = "production.importedBlueprints";

function loadImported(): ImportedBlueprint[] {
  try {
    const raw = localStorage.getItem(IMPORTED_BP_KEY);
    return raw ? (JSON.parse(raw) as ImportedBlueprint[]) : [];
  } catch {
    return [];
  }
}

const FORGE = 10000002;

export type Tab = "item" | "market" | "industry" | "thresholds";

export function ProductionPage() {
  const status = useQuery({ queryKey: ["sde", "status"], queryFn: sdeStatus });

  if (status.isLoading) return <Centered>Checking static data…</Centered>;
  if (status.isError) {
    return (
      <Centered>
        <span className="text-rose-400">
          Couldn't reach the backend: {String(status.error)}
        </span>
      </Centered>
    );
  }
  if (!status.data?.installed) {
    return <SdeSetup onInstalled={() => status.refetch()} />;
  }
  return <Workbench />;
}

function Workbench() {
  const qc = useQueryClient();
  const [tab, setTab] = useState<Tab>("market");
  const [view, setView] = useState<ResultsView>("opportunities");

  // Pricing/cost params — changing these re-runs the calculation.
  const [regionId, setRegionId] = useState(FORGE);
  const [stationId, setStationId] = useState<number | null>(null);
  const [runs, setRuns] = useState(1);
  const [me, setMe] = useState(0);
  const [useOwnedMe, setUseOwnedMe] = useState(true);
  const [useStock, setUseStock] = useState(false);
  const [buildComponents, setBuildComponents] = useState(true);
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

  const favorites = useQuery({
    queryKey: ["production", "favorites"],
    queryFn: () => productionGetList("favorites"),
  });
  const blacklist = useQuery({
    queryKey: ["production", "blacklist"],
    queryFn: () => productionGetList("blacklist"),
  });
  const setList = useMutation({
    mutationFn: (v: { list: ListName; typeId: number; add: boolean }) =>
      productionSetList(v.list, v.typeId, v.add),
    onSuccess: (_d, v) =>
      qc.invalidateQueries({ queryKey: ["production", v.list] }),
  });

  function toggleFavorite(r: ProfitBreakdown) {
    setList.mutate({
      list: "favorites",
      typeId: r.blueprintTypeId,
      add: !r.favorite,
    });
    setRows((prev) =>
      prev.map((x) =>
        x.blueprintTypeId === r.blueprintTypeId
          ? { ...x, favorite: !x.favorite }
          : x,
      ),
    );
  }
  function blacklistRow(r: ProfitBreakdown) {
    setList.mutate({ list: "blacklist", typeId: r.blueprintTypeId, add: true });
    setRows((prev) =>
      prev.filter((x) => x.blueprintTypeId !== r.blueprintTypeId),
    );
  }

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

  const filtered = useMemo(() => {
    const needle = name.trim().toLowerCase();
    const minRoi = minRoiPct.trim() === "" ? null : Number(minRoiPct) / 100;
    const minVol =
      stationId === null || minVolume.trim() === "" ? null : Number(minVolume);
    return rows.filter((r) => {
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
  ]);

  const stations = regions.data?.find((r) => r.id === regionId)?.stations ?? [];
  const rowsByType = useMemo(
    () => new Map(rows.map((r) => [r.blueprintTypeId, r])),
    [rows],
  );

  // Every active client-side filter as a removable chip, so what's constraining
  // the ranking is visible above the table rather than buried across four tabs.
  const activeFilters: { key: string; label: string; clear: () => void }[] = [];
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
  function resetAllFilters() {
    setName("");
    setCategories(new Set());
    setMetas(new Set());
    setOwnedOnly(false);
    setFavoritesOnly(false);
    setMinRoiPct("");
    setMinVolume("");
  }

  return (
    <div className="p-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-100">Production</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Every manufacturable item, ranked by build-vs-buy profit. Search,
            then filter.
          </p>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex gap-2">
            <button
              onClick={() => update.mutate()}
              disabled={update.isPending}
              className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
              title="Re-download the SDE only if it changed"
            >
              {update.isPending
                ? "Checking…"
                : update.data
                  ? update.data.updated
                    ? "Updated ✓"
                    : "Up to date ✓"
                  : "Update data"}
            </button>
            <button
              onClick={calculate}
              disabled={profit.isPending}
              className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
            >
              {profit.isPending ? "Calculating…" : "Calculate"}
            </button>
          </div>
          <DataAge
            updatedAt={profit.isSuccess ? profit.submittedAt : undefined}
            fetching={profit.isPending}
          />
        </div>
      </div>

      <Tabs tab={tab} onChange={setTab} />

      <div className="mt-3 rounded border border-zinc-800 bg-zinc-900 p-3">
        {tab === "item" && (
          <div className="grid gap-4 md:grid-cols-3">
            <Field label="Search">
              <input
                value={name}
                onChange={(e) => setName(e.currentTarget.value)}
                placeholder="name, category, group…"
                className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
              />
              <label
                className={`mt-1 flex items-center gap-1 text-xs ${
                  ownedCount > 0 ? "text-zinc-300" : "text-zinc-600"
                }`}
                title={
                  ownedCount > 0
                    ? "Show only items whose blueprint a logged-in character owns"
                    : "Log in a character with blueprints to enable"
                }
              >
                <input
                  type="checkbox"
                  checked={ownedOnly}
                  disabled={ownedCount === 0}
                  onChange={(e) => setOwnedOnly(e.currentTarget.checked)}
                />
                Owned only{ownedCount > 0 ? ` (${ownedCount})` : ""}
              </label>
              <label
                className="mt-1 flex items-center gap-1 text-xs text-zinc-300"
                title="Show only items you've favorited (★)"
              >
                <input
                  type="checkbox"
                  checked={favoritesOnly}
                  onChange={(e) => setFavoritesOnly(e.currentTarget.checked)}
                />
                Favorites only
              </label>
            </Field>
            <Field label="Category / Type">
              <CheckboxGroup
                options={categoryOptions}
                selected={categories}
                onToggle={(v) => setCategories(toggle(categories, v))}
              />
            </Field>
            <Field label="Meta (tech level / faction)">
              <CheckboxGroup
                options={metaOptions}
                selected={metas}
                onToggle={(v) => setMetas(toggle(metas, v))}
              />
            </Field>
          </div>
        )}

        {tab === "market" && (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Field label="Region">
              <select
                value={regionId}
                onChange={(e) => {
                  setRegionId(Number(e.currentTarget.value));
                  setStationId(null);
                }}
                className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
              >
                {regions.data?.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Market">
              <select
                value={stationId ?? ""}
                onChange={(e) =>
                  setStationId(
                    e.currentTarget.value === ""
                      ? null
                      : Number(e.currentTarget.value),
                  )
                }
                className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
              >
                <option value="">Region average</option>
                {stations.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Materials priced at">
              <BasisSelect value={materialBasis} onChange={setMaterialBasis} />
              <label
                className="mt-1 flex items-center gap-1 text-xs text-zinc-300"
                title="Net your owned assets (across the roster) against each bill of materials — you only pay for the shortfall."
              >
                <input
                  type="checkbox"
                  checked={useStock}
                  onChange={(e) => setUseStock(e.currentTarget.checked)}
                />
                Use my stock{stock.isFetching ? " (loading…)" : ""}
              </label>
            </Field>
            <Field label="Product priced at">
              <BasisSelect value={productBasis} onChange={setProductBasis} />
              <label
                className="mt-1 flex items-center gap-1 text-xs text-zinc-300"
                title="Price each product at whichever hub pays the most (materials still priced at the chosen market). Slower — prices all hubs."
              >
                <input
                  type="checkbox"
                  checked={productBestHub}
                  onChange={(e) => setProductBestHub(e.currentTarget.checked)}
                />
                Sell at best hub
              </label>
            </Field>
            <Field label="Components">
              <label
                className="flex items-center gap-1 py-1 text-xs text-zinc-300"
                title="On: build intermediate components when cheaper than buying (recursive build-vs-buy). Off: buy every material at market."
              >
                <input
                  type="checkbox"
                  checked={buildComponents}
                  onChange={(e) => setBuildComponents(e.currentTarget.checked)}
                />
                Build sub-components
              </label>
            </Field>
          </div>
        )}

        {tab === "industry" && (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Num label="Runs" value={runs} onChange={setRuns} min={1} />
            <Field label={`ME (default for un-owned)`}>
              <input
                type="number"
                value={me}
                min={0}
                max={10}
                onChange={(e) => setMe(Number(e.currentTarget.value))}
                className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
              />
              <label
                className={`mt-1 flex items-center gap-1 text-xs ${
                  ownedCount > 0 ? "text-zinc-300" : "text-zinc-600"
                }`}
                title={
                  ownedCount > 0
                    ? "Use each owned blueprint's researched ME instead of the value above"
                    : "Log in a character with blueprints to enable"
                }
              >
                <input
                  type="checkbox"
                  checked={useOwnedMe}
                  disabled={ownedCount === 0}
                  onChange={(e) => setUseOwnedMe(e.currentTarget.checked)}
                />
                Use owned blueprint ME{ownedCount > 0 ? ` (${ownedCount})` : ""}
              </label>
            </Field>
            <Num
              label="TE (default for un-owned)"
              value={te}
              onChange={setTe}
              min={0}
              max={20}
            />
            <Num
              label="Time skills (0-5)"
              value={timeSkill}
              onChange={setTimeSkill}
              min={0}
              max={5}
            />
            <Field label="Structure">
              <select
                value={structure}
                onChange={(e) =>
                  setStructure(e.currentTarget.value as StructureKey)
                }
                className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
                title="Engineering complex role bonuses: material, cost, and time. SCC 4% surcharge is applied automatically."
              >
                {Object.entries(STRUCTURES).map(([k, s]) => (
                  <option key={k} value={k}>
                    {s.label}
                  </option>
                ))}
              </select>
            </Field>
            <Num
              label="Rig ME %"
              value={rigMePct}
              onChange={setRigMePct}
              min={0}
              max={10}
            />
            <Num
              label="Rig TE %"
              value={rigTePct}
              onChange={setRigTePct}
              min={0}
              max={50}
            />
            <Num
              label="Rig cost %"
              value={rigCostPct}
              onChange={setRigCostPct}
              min={0}
              max={10}
            />
            <Num
              label="Cost index %"
              value={costIndexPct}
              onChange={setCostIndexPct}
              min={0}
              step={0.1}
            />
            <Num
              label="Facility tax %"
              value={facilityTaxPct}
              onChange={setFacilityTaxPct}
              min={0}
              step={0.1}
            />
            <Num
              label="Blueprint cost / run"
              value={blueprintCostPerRun}
              onChange={setBlueprintCostPerRun}
              min={0}
              step={1000000}
            />
            <Num
              label="Invention skills (0-5)"
              value={inventionSkill}
              onChange={setInventionSkill}
              min={0}
              max={5}
            />
            <Field label="Decryptor (T2 invention)">
              <select
                value={decryptorTypeId ?? ""}
                onChange={(e) =>
                  setDecryptorTypeId(
                    e.currentTarget.value === ""
                      ? null
                      : Number(e.currentTarget.value),
                  )
                }
                className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
              >
                <option value="">None</option>
                {decryptors.data?.map((d) => (
                  <option key={d.typeId} value={d.typeId}>
                    {d.name.replace(/ Decryptor$/, "")} (ME{" "}
                    {d.meModifier >= 0 ? "+" : ""}
                    {d.meModifier}, runs {d.runModifier >= 0 ? "+" : ""}
                    {d.runModifier}, ×{d.probabilityMultiplier} prob)
                  </option>
                ))}
              </select>
            </Field>
            <div className="col-span-2 self-end text-[11px] text-zinc-500 md:col-span-4">
              Rig % compose with the structure preset (you supply the
              security-adjusted bonus).
            </div>
          </div>
        )}

        {tab === "thresholds" && (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Field label="Min ROI %">
              <input
                type="number"
                value={minRoiPct}
                min={0}
                onChange={(e) => setMinRoiPct(e.currentTarget.value)}
                placeholder="0"
                className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
              />
            </Field>
            <Field label="Min volume">
              <input
                type="number"
                value={minVolume}
                min={0}
                disabled={stationId === null}
                onChange={(e) => setMinVolume(e.currentTarget.value)}
                placeholder={stationId === null ? "pick a market hub" : "0"}
                className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-500 disabled:opacity-50"
              />
            </Field>
          </div>
        )}
      </div>

      <ViewTabs
        view={view}
        onChange={setView}
        counts={{
          favorites: favorites.data?.length ?? 0,
          blacklist: blacklist.data?.length ?? 0,
          library: (owned.data?.length ?? 0) + imported.length,
        }}
      />

      {view === "opportunities" && activeFilters.length > 0 && (
        <FilterChips filters={activeFilters} onReset={resetAllFilters} />
      )}

      <div className="mt-3">
        {view === "opportunities" &&
          (profit.isError ? (
            <div className="text-sm text-rose-400">
              Calculation failed: {String(profit.error)}
            </div>
          ) : profit.isPending && rows.length === 0 ? (
            <TableSkeleton />
          ) : (
            <ProfitTable
              rows={filtered}
              onFavorite={toggleFavorite}
              onBlacklist={blacklistRow}
            />
          ))}

        {view === "favorites" && (
          <ListView
            items={favorites.data ?? []}
            rowsByType={rowsByType}
            removeLabel="Unfavorite"
            emptyTitle="No favorites yet"
            emptyHint="Star a row in the Opportunities table to track it here."
            onRemove={(id) =>
              setList.mutate({ list: "favorites", typeId: id, add: false })
            }
          />
        )}
        {view === "blacklist" && (
          <ListView
            items={blacklist.data ?? []}
            rowsByType={rowsByType}
            removeLabel="Remove"
            emptyTitle="Nothing blacklisted"
            emptyHint="Hide an item with the blacklist button in Opportunities and it’ll appear here."
            onRemove={(id) =>
              setList.mutate({ list: "blacklist", typeId: id, add: false })
            }
          />
        )}
        {view === "library" && (
          <BlueprintLibrary
            owned={owned.data ?? []}
            imported={imported}
            onImport={saveImported}
          />
        )}
      </div>

      {view === "opportunities" && isStale && (
        <StaleBar
          dirtyCount={dirtyCount}
          pending={profit.isPending}
          auto={autoRecalc}
          onToggleAuto={() => setAutoRecalc((a) => !a)}
          onRecalc={calculate}
        />
      )}
    </div>
  );
}
