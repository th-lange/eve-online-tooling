import { Columns2, Layers, Rows2 } from "lucide-react";
import type { DpsBucket } from "../../lib/api";
import { BucketChart } from "./BucketChart";
import type { BucketSeries, ChartLayout } from "./dpsMeterShared";

/** Graphs — outgoing and incoming; layout + breakdown toggles + the two (or
 *  one, in combined layout) time-grid charts. Everything draws from the
 *  session's 5 s buckets (#984); the series decide what each line reads
 *  (aggregate rates, a pilot-scoped rate, or one line per counterparty). */
export function DpsChartContainer({
  bySource,
  onSetBySource,
  chartLayout,
  onSetChartLayout,
  buckets,
  outSeries,
  inSeries,
  combinedSeries,
  markTs,
}: {
  bySource: boolean;
  onSetBySource: (v: boolean) => void;
  chartLayout: ChartLayout;
  onSetChartLayout: (v: ChartLayout) => void;
  buckets: DpsBucket[];
  outSeries: BucketSeries[];
  inSeries: BucketSeries[];
  combinedSeries: BucketSeries[];
  /** See {@link BucketChart}'s `markTs` — forwarded to every chart so the
   *  log's scroll position reads the same whichever layout is active. */
  markTs?: number | null;
}) {
  return (
    <>
      <div className="mt-6 flex items-center justify-end gap-2">
        <div className="flex overflow-hidden rounded border border-zinc-800 text-xs">
          {(
            [
              { value: false, label: "Totals" },
              { value: true, label: "By source" },
            ] as const
          ).map(({ value, label }) => (
            <button
              key={label}
              onClick={() => onSetBySource(value)}
              aria-pressed={bySource === value}
              className={`px-2 py-1 ${
                bySource === value
                  ? "bg-zinc-700 text-zinc-100"
                  : "bg-zinc-900 text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        <div className="flex overflow-hidden rounded border border-zinc-800">
          {(
            [
              { value: "side", label: "Side by side", Icon: Columns2 },
              { value: "stacked", label: "Stacked", Icon: Rows2 },
              {
                value: "combined",
                label: "Combined (one panel)",
                Icon: Layers,
              },
            ] as const
          ).map(({ value, label, Icon }) => (
            <button
              key={value}
              onClick={() => onSetChartLayout(value)}
              title={label}
              aria-label={label}
              aria-pressed={chartLayout === value}
              className={`p-1.5 ${
                chartLayout === value
                  ? "bg-zinc-700 text-zinc-100"
                  : "bg-zinc-900 text-zinc-500 hover:text-zinc-300"
              }`}
            >
              <Icon size={14} />
            </button>
          ))}
        </div>
      </div>
      <div
        className={`mt-2 grid gap-4 ${
          chartLayout === "side" ? "md:grid-cols-2" : "grid-cols-1"
        }`}
      >
        {chartLayout === "combined" ? (
          <BucketChart
            buckets={buckets}
            series={combinedSeries}
            title="Damage — out + in"
            markTs={markTs}
          />
        ) : (
          <>
            <BucketChart
              buckets={buckets}
              series={outSeries}
              title="Outgoing"
              markTs={markTs}
            />
            <BucketChart
              buckets={buckets}
              series={inSeries}
              title="Incoming"
              markTs={markTs}
            />
          </>
        )}
      </div>
    </>
  );
}
