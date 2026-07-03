import type { Region, Station } from "../lib/api";

// The region + station `<select>` markup was copy-pasted byte-for-byte across
// the market-priced pages (trading, reprocessing, production, assets,
// appraisal). Extracted here so there's one place to change; each page keeps
// its own `<Field>` wrapper/label and its own change handler (so page-specific
// side effects — dirty flags, refetch — stay put).

const SELECT_CLASS =
  "w-full rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none";

/** Region dropdown from the `marketRegions` list. Changing region should reset
 *  the station — the caller does that in `onChange`. */
export function RegionSelect({
  regions,
  value,
  onChange,
}: {
  regions: Region[] | undefined;
  value: number;
  onChange: (regionId: number) => void;
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(Number(e.currentTarget.value))}
      className={SELECT_CLASS}
    >
      {regions?.map((r) => (
        <option key={r.id} value={r.id}>
          {r.name}
        </option>
      ))}
    </select>
  );
}

/** Station dropdown within the selected region; the empty option ("Region
 *  average") maps to `null`. */
export function StationSelect({
  stations,
  value,
  onChange,
}: {
  stations: Station[];
  value: number | null;
  onChange: (stationId: number | null) => void;
}) {
  return (
    <select
      value={value ?? ""}
      onChange={(e) =>
        onChange(
          e.currentTarget.value === "" ? null : Number(e.currentTarget.value),
        )
      }
      className={SELECT_CLASS}
    >
      <option value="">Region average</option>
      {stations.map((s) => (
        <option key={s.id} value={s.id}>
          {s.name}
        </option>
      ))}
    </select>
  );
}
