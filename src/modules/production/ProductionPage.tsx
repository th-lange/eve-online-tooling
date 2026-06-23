import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  marketRegions,
  ownedBlueprints,
  productionDecryptors,
  productionProfit,
  sdeStatus,
  sdeUpdate,
  type PriceBasis,
  type ProfitBreakdown,
  type ProfitParams,
} from "../../lib/api";
import { SdeSetup } from "./SdeSetup";
import { ProfitTable } from "./ProfitTable";

const FORGE = 10000002;

const BASES: { value: PriceBasis; label: string }[] = [
  { value: "sellPercentile", label: "Sell (percentile)" },
  { value: "buyPercentile", label: "Buy (percentile)" },
  { value: "sellMin", label: "Sell (min)" },
  { value: "buyMax", label: "Buy (max)" },
  { value: "averagePrice", label: "Weighted average" },
  { value: "adjustedPrice", label: "Adjusted (CCP)" },
];

type Tab = "item" | "market" | "thresholds";

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
  const [tab, setTab] = useState<Tab>("market");

  // Pricing/cost params — changing these re-runs the calculation.
  const [regionId, setRegionId] = useState(FORGE);
  const [stationId, setStationId] = useState<number | null>(null);
  const [runs, setRuns] = useState(1);
  const [me, setMe] = useState(0);
  const [costIndexPct, setCostIndexPct] = useState(5);
  const [facilityTaxPct, setFacilityTaxPct] = useState(0);
  const [materialBasis, setMaterialBasis] =
    useState<PriceBasis>("sellPercentile");
  const [productBasis, setProductBasis] = useState<PriceBasis>("sellPercentile");
  const [blueprintCostPerRun, setBlueprintCostPerRun] = useState(0);
  const [inventionSkill, setInventionSkill] = useState(5);
  const [decryptorTypeId, setDecryptorTypeId] = useState<number | null>(null);

  // Client-side filters — applied instantly to the results.
  const [name, setName] = useState("");
  const [categories, setCategories] = useState<Set<string>>(new Set());
  const [metas, setMetas] = useState<Set<string>>(new Set());
  const [ownedOnly, setOwnedOnly] = useState(false);
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
  const ownedSet = useMemo(
    () => new Set(owned.data?.map((b) => b.typeId)),
    [owned.data],
  );
  const ownedCount = ownedSet.size;
  const update = useMutation({ mutationFn: () => sdeUpdate(false) });
  const profit = useMutation({
    mutationFn: (p: ProfitParams) => productionProfit(p),
  });

  function calculate() {
    profit.mutate({
      regionId,
      stationId,
      runs,
      me,
      systemCostIndex: costIndexPct / 100,
      facilityTax: facilityTaxPct / 100,
      materialBasis,
      productBasis,
      blueprintCostPerRun,
      inventionSkillLevel: inventionSkill,
      decryptorTypeId,
    });
  }

  // Rank once on first load.
  useEffect(() => {
    calculate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const rows = profit.data ?? [];
  const categoryOptions = useMemo(() => uniqueSorted(rows, (r) => r.category), [rows]);
  const metaOptions = useMemo(() => uniqueSorted(rows, (r) => r.metaGroup), [rows]);

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
      if (minRoi !== null && (r.roi ?? -Infinity) < minRoi) return false;
      if (minVol !== null && (r.productVolume ?? 0) < minVol) return false;
      return true;
    });
  }, [rows, name, categories, metas, ownedOnly, ownedSet, minRoiPct, minVolume, stationId]);

  const stations = regions.data?.find((r) => r.id === regionId)?.stations ?? [];

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
            className="rounded bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {profit.isPending ? "Calculating…" : "Calculate"}
          </button>
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
            </Field>
            <Field label="Product priced at">
              <BasisSelect value={productBasis} onChange={setProductBasis} />
            </Field>
            <Num label="Runs" value={runs} onChange={setRuns} min={1} />
            <Num label="ME" value={me} onChange={setMe} min={0} max={10} />
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
            <div className="col-span-2 self-end text-xs text-zinc-500 md:col-span-4">
              Changing market settings? Hit <strong>Calculate</strong> to
              re-price.
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

      <div className="mt-4">
        {profit.isError ? (
          <div className="text-sm text-rose-400">
            Calculation failed: {String(profit.error)}
          </div>
        ) : profit.isPending && rows.length === 0 ? (
          <div className="p-10 text-center text-sm text-zinc-500">
            Pricing the whole catalogue at the chosen market…
          </div>
        ) : (
          <ProfitTable rows={filtered} />
        )}
      </div>
    </div>
  );
}

// --- small helpers / components ---

function uniqueSorted(
  rows: ProfitBreakdown[],
  pick: (r: ProfitBreakdown) => string | null,
): string[] {
  const set = new Set<string>();
  for (const r of rows) {
    const v = pick(r);
    if (v) set.add(v);
  }
  return [...set].sort();
}

function toggle(set: Set<string>, v: string): Set<string> {
  const next = new Set(set);
  next.has(v) ? next.delete(v) : next.add(v);
  return next;
}

function Tabs({ tab, onChange }: { tab: Tab; onChange: (t: Tab) => void }) {
  const tabs: { value: Tab; label: string }[] = [
    { value: "item", label: "Item" },
    { value: "market", label: "Market" },
    { value: "thresholds", label: "Thresholds" },
  ];
  return (
    <div className="mt-4 inline-flex rounded border border-zinc-800 bg-zinc-900 p-0.5">
      {tabs.map((t) => (
        <button
          key={t.value}
          onClick={() => onChange(t.value)}
          className={`rounded px-3 py-1.5 text-sm ${
            tab === t.value
              ? "bg-zinc-700 text-zinc-100"
              : "text-zinc-400 hover:text-zinc-200"
          }`}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1 text-xs text-zinc-400">
      {label}
      {children}
    </label>
  );
}

function CheckboxGroup({
  options,
  selected,
  onToggle,
}: {
  options: string[];
  selected: Set<string>;
  onToggle: (v: string) => void;
}) {
  if (options.length === 0) {
    return <div className="text-xs text-zinc-600">—</div>;
  }
  return (
    <div className="flex max-h-40 flex-wrap gap-1 overflow-auto">
      {options.map((o) => (
        <label
          key={o}
          className={`flex cursor-pointer items-center gap-1 rounded px-2 py-0.5 text-xs ${
            selected.has(o)
              ? "bg-zinc-700 text-zinc-100"
              : "bg-zinc-800 text-zinc-400"
          }`}
        >
          <input
            type="checkbox"
            checked={selected.has(o)}
            onChange={() => onToggle(o)}
          />
          {o}
        </label>
      ))}
    </div>
  );
}

function BasisSelect({
  value,
  onChange,
}: {
  value: PriceBasis;
  onChange: (b: PriceBasis) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.currentTarget.value as PriceBasis)}
      className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
    >
      {BASES.map((b) => (
        <option key={b.value} value={b.value}>
          {b.label}
        </option>
      ))}
    </select>
  );
}

function Num({
  label,
  value,
  onChange,
  min,
  max,
  step,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <Field label={label}>
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        className="w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
      />
    </Field>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-10 text-sm text-zinc-400">
      {children}
    </div>
  );
}
