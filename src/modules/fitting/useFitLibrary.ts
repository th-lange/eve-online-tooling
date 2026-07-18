import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  fittingEsiList,
  fittingListLocal,
  sdeTypeInfos,
  type Fit,
} from "../../lib/api";

/**
 * The data layer behind the fit picker: merges saved (local) + in-game (ESI)
 * fits, resolves each fit's hull to a name + ship group via the SDE, and
 * groups/sorts the result for the dropdown.
 */
export function useFitLibrary() {
  const qc = useQueryClient();
  const saved = useQuery({
    queryKey: ["fitting", "saved"],
    queryFn: fittingListLocal,
  });
  // In-game (ESI) fittings — fetched on demand (cached server-side), not on mount.
  // Auto-load in-game fits (cached server-side 30m); "Refresh" forces a fetch.
  const esiFits = useQuery({
    queryKey: ["fitting", "esi"],
    queryFn: () => fittingEsiList(),
  });
  // Force-refresh in-game fits past the server cache and update the query.
  const refreshEsi = useMutation({
    mutationFn: () => fittingEsiList(true),
    onSuccess: (fits) => qc.setQueryData(["fitting", "esi"], fits),
  });

  // All fits (local + in-game), each tagged with its source.
  const allFits = useMemo(() => {
    const local = (saved.data ?? []).map((f) => ({
      fit: f,
      source: "saved" as const,
    }));
    const esi = (esiFits.data ?? []).map((f) => ({
      fit: f,
      source: "in-game" as const,
    }));
    return [...local, ...esi];
  }, [saved.data, esiFits.data]);

  // Resolve each fit's hull to its name + ship group, for grouping the dropdown.
  const hullIds = useMemo(
    () => [...new Set(allFits.map((f) => f.fit.shipTypeId))],
    [allFits],
  );
  const hulls = useQuery({
    queryKey: ["fitting", "hullInfos", hullIds],
    queryFn: () => sdeTypeInfos(hullIds),
    enabled: hullIds.length > 0,
  });
  const hullInfo = useMemo(
    () => new Map((hulls.data ?? []).map((h) => [h.id, h])),
    [hulls.data],
  );

  // Group fits by ship group → (hull, fit name), sorted, for the dropdown.
  const fitGroups = useMemo(() => {
    const byGroup = new Map<
      string,
      { key: string; hull: string; name: string; source: string; fit: Fit }[]
    >();
    allFits.forEach(({ fit: f, source }, i) => {
      const info = hullInfo.get(f.shipTypeId);
      const group = info?.group || "Other";
      const hull = info?.name || `#${f.shipTypeId}`;
      const list = byGroup.get(group) ?? [];
      list.push({
        key: `${source}:${f.id}:${i}`,
        hull,
        name: f.name,
        source,
        fit: f,
      });
      byGroup.set(group, list);
    });
    return [...byGroup.entries()]
      .map(([group, fits]) => ({
        group,
        fits: fits.sort(
          (a, b) =>
            a.hull.localeCompare(b.hull) || a.name.localeCompare(b.name),
        ),
      }))
      .sort((a, b) => a.group.localeCompare(b.group));
  }, [allFits, hullInfo]);
  const fitByKey = useMemo(() => {
    const m = new Map<string, Fit>();
    for (const g of fitGroups) for (const f of g.fits) m.set(f.key, f.fit);
    return m;
  }, [fitGroups]);

  return {
    saved,
    esiFits,
    hulls,
    refreshEsi,
    allFits,
    hullIds,
    hullInfo,
    fitGroups,
    fitByKey,
  };
}
