import { FeesFromCharacter } from "../../components/FeesFromCharacter";
import {
  RegionSelect,
  StationSelect,
} from "../../components/RegionStationPicker";
import { CheckboxGroup, Field } from "../../components/forms";
import { BasisSelect, Num, Tabs } from "./components";
import { CostIndexField } from "./CostIndexField";
import { toggle } from "../../lib/sets";
import { STRUCTURES, type StructureKey } from "./types";
import type { WorkbenchState } from "./workbenchTypes";

export function ParamsPanel({ wb }: { wb: WorkbenchState }) {
  const {
    tab,
    setTab,
    name,
    setName,
    ownedCount,
    ownedOnly,
    setOwnedOnly,
    favoritesOnly,
    setFavoritesOnly,
    categoryOptions,
    categories,
    setCategories,
    metaOptions,
    metas,
    setMetas,
    regions,
    regionId,
    setRegionId,
    setStationId,
    stations,
    stationId,
    materialBasis,
    setMaterialBasis,
    useStock,
    setUseStock,
    stock,
    productBasis,
    setProductBasis,
    productBestHub,
    setProductBestHub,
    buildComponents,
    setBuildComponents,
    includeSaleCost,
    setIncludeSaleCost,
    sellBrokerPct,
    setSellBrokerPct,
    sellTaxPct,
    setSellTaxPct,
    runs,
    setRuns,
    me,
    setMe,
    useOwnedMe,
    setUseOwnedMe,
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
    blueprintCostPerRun,
    setBlueprintCostPerRun,
    inventionSkill,
    setInventionSkill,
    decryptorTypeId,
    setDecryptorTypeId,
    decryptors,
    minRoiPct,
    setMinRoiPct,
    minVolume,
    setMinVolume,
    pasteList,
    setPasteList,
    pasteMinRoiPct,
    setPasteMinRoiPct,
  } = wb;

  return (
    <>
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
                maxHeight="max-h-40"
              />
            </Field>
            <Field label="Meta (tech level / faction)">
              <CheckboxGroup
                options={metaOptions}
                selected={metas}
                onToggle={(v) => setMetas(toggle(metas, v))}
                maxHeight="max-h-40"
              />
            </Field>
          </div>
        )}

        {tab === "market" && (
          <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
            <Field label="Region">
              <RegionSelect
                regions={regions.data}
                value={regionId}
                onChange={(id) => {
                  setRegionId(id);
                  setStationId(null);
                }}
              />
            </Field>
            <Field label="Market">
              <StationSelect
                stations={stations}
                value={stationId}
                onChange={setStationId}
              />
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
            <Field label="Sale costs">
              <label
                className="flex items-center gap-1 py-1 text-xs text-zinc-300"
                title="Subtract broker fee + sales tax from the product sale when computing profit."
              >
                <input
                  type="checkbox"
                  checked={includeSaleCost}
                  onChange={(e) => setIncludeSaleCost(e.currentTarget.checked)}
                />
                Subtract broker + tax
              </label>
              {includeSaleCost && (
                <div className="mt-1 space-y-1">
                  <label className="flex items-center gap-1 text-[10px] text-zinc-500">
                    <input
                      type="number"
                      value={sellBrokerPct}
                      min={0}
                      onChange={(e) =>
                        setSellBrokerPct(Number(e.currentTarget.value))
                      }
                      className="w-16 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
                    />
                    broker %
                  </label>
                  <label className="flex items-center gap-1 text-[10px] text-zinc-500">
                    <input
                      type="number"
                      value={sellTaxPct}
                      min={0}
                      onChange={(e) =>
                        setSellTaxPct(Number(e.currentTarget.value))
                      }
                      className="w-16 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
                    />
                    tax %
                  </label>
                  <FeesFromCharacter
                    onApply={(b, t) => {
                      setSellBrokerPct(b);
                      setSellTaxPct(t);
                    }}
                  />
                </div>
              )}
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
            <CostIndexField value={costIndexPct} onChange={setCostIndexPct} />
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

        {tab === "paste" && (
          <div className="grid gap-4 md:grid-cols-3">
            <div className="md:col-span-2">
              <Field label="Paste items (names, EVE Multibuy, inventory dump)">
                <textarea
                  value={pasteList}
                  onChange={(e) => setPasteList(e.currentTarget.value)}
                  rows={6}
                  placeholder={"Rifter\nWarrior II\n…"}
                  className="w-full rounded bg-zinc-800 px-2 py-1 font-mono text-xs text-zinc-100 outline-none placeholder:text-zinc-500"
                />
              </Field>
              <p className="mt-1 text-[11px] text-zinc-500">
                Filters Opportunities to the pasted items and flags which clear
                the min ROI below.
              </p>
            </div>
            <Field label="Min ROI % to count as worth selling">
              <input
                type="number"
                value={pasteMinRoiPct}
                min={0}
                onChange={(e) => setPasteMinRoiPct(e.currentTarget.value)}
                placeholder="0"
                className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
              />
            </Field>
          </div>
        )}
      </div>
    </>
  );
}
