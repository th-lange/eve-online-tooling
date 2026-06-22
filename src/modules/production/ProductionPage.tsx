import { useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  productionProfit,
  sdeManufacturableBlueprints,
  sdeStatus,
  type PriceBasis,
} from "../../lib/api";
import { SdeSetup } from "./SdeSetup";
import { BlueprintPicker } from "./BlueprintPicker";
import { ProfitTable } from "./ProfitTable";

const BASES: { value: PriceBasis; label: string }[] = [
  { value: "sellMin", label: "Sell (min)" },
  { value: "buyMax", label: "Buy (max)" },
  { value: "dailyAverage", label: "Daily average" },
  { value: "movingAverage", label: "Moving average" },
  { value: "adjustedPrice", label: "Adjusted" },
  { value: "averagePrice", label: "Average" },
];

export function ProductionPage() {
  const status = useQuery({ queryKey: ["sde", "status"], queryFn: sdeStatus });

  if (status.isLoading) {
    return <Centered>Checking static data…</Centered>;
  }
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
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [runs, setRuns] = useState(1);
  const [me, setMe] = useState(0);
  const [costIndexPct, setCostIndexPct] = useState(5);
  const [facilityTaxPct, setFacilityTaxPct] = useState(0);
  const [materialBasis, setMaterialBasis] = useState<PriceBasis>("sellMin");
  const [productBasis, setProductBasis] = useState<PriceBasis>("sellMin");

  const blueprints = useQuery({
    queryKey: ["sde", "manufacturable"],
    queryFn: sdeManufacturableBlueprints,
  });

  const profit = useMutation({
    mutationFn: () =>
      productionProfit({
        blueprintTypeIds: [...selected],
        runs,
        me,
        systemCostIndex: costIndexPct / 100,
        facilityTax: facilityTaxPct / 100,
        materialBasis,
        productBasis,
      }),
  });

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  return (
    <div className="p-6">
      <h1 className="text-2xl font-semibold text-zinc-100">Production</h1>
      <p className="mt-1 text-sm text-zinc-400">
        Pick blueprints, then rank them by build-vs-buy profit at Jita.
      </p>

      <div className="mt-4 grid gap-4 lg:grid-cols-[20rem_1fr]">
        <div className="space-y-3">
          {blueprints.isLoading && (
            <div className="text-sm text-zinc-500">Loading blueprints…</div>
          )}
          {blueprints.isError && (
            <div className="text-sm text-rose-400">
              Failed to load blueprints: {String(blueprints.error)}
            </div>
          )}
          {blueprints.data && (
            <BlueprintPicker
              items={blueprints.data}
              selected={selected}
              onToggle={toggle}
              onClear={() => setSelected(new Set())}
            />
          )}

          <div className="grid grid-cols-2 gap-2 rounded border border-zinc-800 bg-zinc-900 p-3 text-sm">
            <NumberField label="Runs" value={runs} onChange={setRuns} min={1} />
            <NumberField label="ME" value={me} onChange={setMe} min={0} max={10} />
            <NumberField
              label="Cost index %"
              value={costIndexPct}
              onChange={setCostIndexPct}
              min={0}
              step={0.1}
            />
            <NumberField
              label="Facility tax %"
              value={facilityTaxPct}
              onChange={setFacilityTaxPct}
              min={0}
              step={0.1}
            />
            <BasisField
              label="Materials priced at"
              value={materialBasis}
              onChange={setMaterialBasis}
            />
            <BasisField
              label="Product priced at"
              value={productBasis}
              onChange={setProductBasis}
            />
          </div>

          <button
            onClick={() => profit.mutate()}
            disabled={selected.size === 0 || profit.isPending}
            className="w-full rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {profit.isPending
              ? "Calculating…"
              : `Calculate profit (${selected.size})`}
          </button>
        </div>

        <div>
          {profit.isError && (
            <div className="text-sm text-rose-400">
              Calculation failed: {String(profit.error)}
            </div>
          )}
          {profit.data ? (
            <ProfitTable rows={profit.data} />
          ) : (
            !profit.isError && (
              <div className="rounded border border-dashed border-zinc-800 p-10 text-center text-sm text-zinc-500">
                Select blueprints and hit Calculate to see ranked profit.
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}

function NumberField({
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
    <label className="flex flex-col gap-1 text-xs text-zinc-400">
      {label}
      <input
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => onChange(Number(e.currentTarget.value))}
        className="rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
      />
    </label>
  );
}

function BasisField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: PriceBasis;
  onChange: (b: PriceBasis) => void;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-zinc-400">
      {label}
      <select
        value={value}
        onChange={(e) => onChange(e.currentTarget.value as PriceBasis)}
        className="rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
      >
        {BASES.map((b) => (
          <option key={b.value} value={b.value}>
            {b.label}
          </option>
        ))}
      </select>
    </label>
  );
}

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-full items-center justify-center p-10 text-sm text-zinc-400">
      {children}
    </div>
  );
}
