import { useState } from "react";
import { Settings2, X } from "lucide-react";
import type { SeriesKey } from "./dpsMeterShared";
import {
  INCOMING_ALARM,
  LEVEL_TEXT,
  type SeriesThresholds,
  type Threshold,
} from "./thresholds";

/** Per-series alarm editor (#1270): a gear on the readout card opening a small
 *  popover of `≥ value → level` rows. Rows are stored as entered; `levelFor`
 *  sorts them when it reads, so order never matters here. */
export function ThresholdPopover({
  seriesKey,
  label,
  thresholds,
  onChange,
}: {
  seriesKey: SeriesKey;
  label: string;
  thresholds: SeriesThresholds;
  onChange: (next: SeriesThresholds) => void;
}) {
  const [open, setOpen] = useState(false);
  const rows = thresholds[seriesKey] ?? [];

  function setRows(next: Threshold[]) {
    const copy = { ...thresholds };
    if (next.length === 0) delete copy[seriesKey];
    else copy[seriesKey] = next;
    onChange(copy);
  }

  return (
    <span className="relative">
      <button
        type="button"
        aria-label={`Thresholds for ${label}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className={`rounded p-0.5 ${
          rows.length > 0
            ? "text-zinc-300"
            : "text-zinc-600 hover:text-zinc-400"
        }`}
      >
        <Settings2 size={12} />
      </button>
      {open && (
        <div className="absolute right-0 top-5 z-20 w-56 space-y-1.5 rounded border border-zinc-700 bg-zinc-900 p-2 text-xs shadow-lg">
          <div className="flex items-center justify-between text-zinc-400">
            <span>{label} alarms</span>
            <button
              type="button"
              aria-label="Close thresholds"
              onClick={() => setOpen(false)}
              className="text-zinc-500 hover:text-zinc-300"
            >
              <X size={12} />
            </button>
          </div>
          {rows.length === 0 && (
            <p className="text-[11px] text-zinc-500">
              No alarms — the card keeps its own colour.
            </p>
          )}
          {rows.map((row, i) => (
            <div key={i} className="flex items-center gap-1">
              <span className="text-zinc-500">≥</span>
              <input
                type="number"
                min={0}
                aria-label={`Threshold ${i + 1} value`}
                value={row.atOrAbove}
                onChange={(e) =>
                  setRows(
                    rows.map((r, j) =>
                      j === i
                        ? { ...r, atOrAbove: Number(e.currentTarget.value) }
                        : r,
                    ),
                  )
                }
                className="w-16 rounded bg-zinc-800 px-1 py-0.5 text-zinc-100 outline-none"
              />
              <select
                aria-label={`Threshold ${i + 1} level`}
                value={row.level}
                onChange={(e) =>
                  setRows(
                    rows.map((r, j) =>
                      j === i
                        ? {
                            ...r,
                            level: e.currentTarget.value as Threshold["level"],
                          }
                        : r,
                    ),
                  )
                }
                className={`rounded bg-zinc-800 px-1 py-0.5 outline-none ${LEVEL_TEXT[row.level]}`}
              >
                <option value="warn">warn</option>
                <option value="danger">danger</option>
              </select>
              <button
                type="button"
                aria-label={`Remove threshold ${i + 1}`}
                onClick={() => setRows(rows.filter((_, j) => j !== i))}
                className="ml-auto text-zinc-500 hover:text-rose-400"
              >
                <X size={12} />
              </button>
            </div>
          ))}
          <div className="flex items-center gap-2 pt-0.5">
            <button
              type="button"
              onClick={() =>
                setRows([...rows, { atOrAbove: 0, level: "warn" }])
              }
              className="rounded border border-zinc-700 px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-800"
            >
              + Alarm
            </button>
            {seriesKey === "dpsIn" && (
              <button
                type="button"
                onClick={() => setRows(INCOMING_ALARM.dpsIn!)}
                title="warn ≥ 300, danger ≥ 800"
                className="rounded border border-zinc-700 px-1.5 py-0.5 text-zinc-300 hover:bg-zinc-800"
              >
                Incoming preset
              </button>
            )}
          </div>
        </div>
      )}
    </span>
  );
}
