import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { pochvenRoutes, type PochvenStat } from "../../lib/api";
import { POCHVEN_META } from "./data";

type Pref = "shortest" | "secure" | "insecure";

// Per-system jump distances from Pochven to the trade hubs, computed live
// (#414). Pick a route preference; sort by any hub's average.
export function Logistics() {
  const q = useQuery({
    queryKey: ["pochven", "routes"],
    queryFn: pochvenRoutes,
    staleTime: 60 * 60_000,
  });
  const [pref, setPref] = useState<Pref>("shortest");
  const [sortHub, setSortHub] = useState<string | null>(null);

  const hubs = q.data?.hubs ?? [];
  const rows = useMemo(() => {
    const list = (q.data?.systems ?? []).map((s) => ({
      system: s.system,
      cells: Object.fromEntries(s.hubs.map((h) => [h.hub, h[pref]])) as Record<
        string,
        PochvenStat
      >,
    }));
    if (sortHub) {
      list.sort(
        (a, b) => (a.cells[sortHub]?.avg ?? 0) - (b.cells[sortHub]?.avg ?? 0),
      );
    } else {
      list.sort((a, b) => a.system.localeCompare(b.system));
    }
    return list;
  }, [q.data, pref, sortHub]);

  return (
    <section className="mt-8">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-lg font-semibold text-zinc-100">
          Logistics — jumps to trade hubs
        </h2>
        <div className="flex overflow-hidden rounded border border-zinc-700 text-xs">
          {(["shortest", "secure", "insecure"] as Pref[]).map((p) => (
            <button
              key={p}
              onClick={() => setPref(p)}
              className={`px-3 py-1 capitalize ${
                pref === p
                  ? "bg-zinc-700 text-zinc-100"
                  : "text-zinc-400 hover:bg-zinc-800"
              }`}
            >
              {p}
            </button>
          ))}
        </div>
      </div>
      <p className="mt-1 text-xs text-zinc-500">
        Average jumps from each Pochven system's C729 exit candidates to the hub
        (min–max in parentheses). Click a hub to sort.
      </p>

      {q.isLoading ? (
        <div className="mt-3 text-sm text-zinc-500">Computing routes…</div>
      ) : q.isError ? (
        <div className="mt-3 text-sm text-rose-400">{String(q.error)}</div>
      ) : (
        <div className="mt-3 overflow-auto rounded-lg border border-zinc-800">
          <table className="w-full border-collapse text-sm">
            <thead className="bg-zinc-900 text-zinc-400">
              <tr>
                <th className="px-3 py-1.5 text-left font-medium">System</th>
                <th className="px-3 py-1.5 text-left font-medium">Clade</th>
                <th className="px-3 py-1.5 text-left font-medium">Role</th>
                {hubs.map((h) => (
                  <th
                    key={h}
                    onClick={() => setSortHub((cur) => (cur === h ? null : h))}
                    className={`cursor-pointer px-3 py-1.5 text-right font-medium hover:text-zinc-200 ${
                      sortHub === h ? "text-sky-300" : ""
                    }`}
                    title={`Sort by jumps to ${h}`}
                  >
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr
                  key={r.system}
                  className="border-t border-zinc-800 text-zinc-300"
                >
                  <td className="px-3 py-1.5 font-medium text-zinc-200">
                    {r.system}
                  </td>
                  <td className="px-3 py-1.5 text-zinc-400">
                    {POCHVEN_META[r.system]?.clade ?? "—"}
                  </td>
                  <td className="px-3 py-1.5 text-zinc-400">
                    {POCHVEN_META[r.system]?.role ?? "—"}
                  </td>
                  {hubs.map((h) => {
                    const s = r.cells[h];
                    return (
                      <td
                        key={h}
                        className="px-3 py-1.5 text-right tabular-nums"
                      >
                        {s ? (
                          <>
                            <span className="text-zinc-200">
                              {s.avg.toFixed(1)}
                            </span>
                            <span className="ml-1 text-[10px] text-zinc-500">
                              ({s.min}–{s.max})
                            </span>
                          </>
                        ) : (
                          "—"
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
