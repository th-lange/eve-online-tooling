import { useState, type ReactNode } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  productionProfit,
  sdeManufacturableBlueprints,
  sdeStatus,
  sdeUpdate,
  type PriceBasis,
} from "../../lib/api";
import { SdeSetup } from "./SdeSetup";
import { BlueprintPicker } from "./BlueprintPicker";
import { ProfitTable } from "./ProfitTable";

type Mode = "all" | "owned" | "selected";

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
  const [mode, setMode] = useState<Mode>("all");
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

  const update = useMutation({ mutationFn: () => sdeUpdate(false) });

  const profit = useMutation({
    mutationFn: () =>
      productionProfit(
        mode === "all"
          ? {
              mode: "all",
              runs,
              me,
              systemCostIndex: costIndexPct / 100,
              facilityTax: facilityTaxPct / 100,
            }
          : {
              mode: "selected",
              blueprintTypeIds: [...selected],
              runs,
              me,
              systemCostIndex: costIndexPct / 100,
              facilityTax: facilityTaxPct / 100,
              materialBasis,
              productBasis,
            },
      ),
  });

  function toggle(id: number) {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  const canCalculate =
    mode === "all" || (mode === "selected" && selected.size > 0);

  return (
    <div className="p-6">
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-zinc-100">Production</h1>
          <p className="mt-1 text-sm text-zinc-400">
            Rank what you can build by build-vs-buy profit at Jita.
          </p>
        </div>
        <button
          onClick={() => update.mutate()}
          disabled={update.isPending}
          className="rounded border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          title="Re-download the SDE only if Fuzzwork's data changed"
        >
          {update.isPending
            ? "Checking…"
            : update.data
              ? update.data.updated
                ? "Updated ✓"
                : "Up to date ✓"
              : "Update data"}
        </button>
      </div>

      <ModeTabs mode={mode} onChange={setMode} />

      <div className="mt-4 grid gap-4 lg:grid-cols-[20rem_1fr]">
        <div className="space-y-3">
          {mode === "owned" && (
            <div className="rounded border border-zinc-800 bg-zinc-900 p-4 text-sm text-zinc-400">
              Showing your owned blueprints needs EVE SSO login, which isn't
              wired up yet. Use <strong>All</strong> or <strong>Selected</strong>{" "}
              for now.
            </div>
          )}

          {mode === "all" && (
            <div className="rounded border border-zinc-800 bg-zinc-900 p-4 text-sm text-zinc-400">
              Ranks every manufacturable blueprint
              {blueprints.data ? ` (${blueprints.data.length})` : ""} using
              global <strong>average</strong> prices — fast, but no live
              spot/volume. Use <strong>Selected</strong> for precise pricing.
            </div>
          )}

          {mode === "selected" && (
            <>
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
            </>
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
            {mode === "selected" && (
              <>
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
              </>
            )}
          </div>

          <button
            onClick={() => profit.mutate()}
            disabled={!canCalculate || profit.isPending}
            className="w-full rounded bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            {profit.isPending
              ? "Calculating…"
              : mode === "selected"
                ? `Calculate profit (${selected.size})`
                : "Calculate profit"}
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
                {mode === "owned"
                  ? "Owned-blueprint view needs login (coming soon)."
                  : "Set your options and hit Calculate to see ranked profit."}
              </div>
            )
          )}
        </div>
      </div>
    </div>
  );
}

function ModeTabs({
  mode,
  onChange,
}: {
  mode: Mode;
  onChange: (m: Mode) => void;
}) {
  const tabs: { value: Mode; label: string; disabled?: boolean }[] = [
    { value: "all", label: "All" },
    { value: "owned", label: "Owned (login)" },
    { value: "selected", label: "Selected" },
  ];
  return (
    <div className="mt-4 inline-flex rounded border border-zinc-800 bg-zinc-900 p-0.5">
      {tabs.map((t) => (
        <button
          key={t.value}
          onClick={() => onChange(t.value)}
          className={`rounded px-3 py-1.5 text-sm ${
            mode === t.value
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
