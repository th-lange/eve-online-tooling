import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MapPin } from "lucide-react";
import {
  errorMessage,
  marketCurrentLocation,
  pochvenSearch,
  systemSearch,
} from "../../lib/api";
import { EntryResults } from "./EntryResults";

// Active entry search: from your current system, route to the nearest C729
// candidate and list the systems to jump & scan.
export function EntryFinder() {
  const [systemId, setSystemId] = useState<number | null>(null);
  const [label, setLabel] = useState("");
  const [query, setQuery] = useState("");
  const [maxJumps, setMaxJumps] = useState(10);

  const search = useQuery({
    queryKey: ["system", "search", query],
    queryFn: () => systemSearch(query),
    enabled: query.trim().length >= 2,
    staleTime: 60_000,
  });
  const location = useQuery({
    queryKey: ["market", "currentLocation"],
    queryFn: marketCurrentLocation,
    staleTime: 60_000,
    enabled: false,
  });
  const result = useQuery({
    queryKey: ["pochven", "search", systemId, maxJumps],
    queryFn: () => pochvenSearch(systemId!, maxJumps),
    enabled: systemId != null,
    staleTime: 5 * 60_000,
  });

  const pick = (id: number, name: string) => {
    setSystemId(id);
    setLabel(name);
    setQuery("");
  };

  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-end gap-3">
        <label className="relative flex flex-col gap-1 text-xs text-zinc-400">
          Your current system
          <input
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            placeholder={label || "Search a system…"}
            className="w-64 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
          />
          {query.trim().length >= 2 && (search.data?.length ?? 0) > 0 && (
            <div className="absolute top-full z-20 mt-1 max-h-56 w-64 overflow-auto rounded border border-zinc-700 bg-zinc-800 shadow-lg">
              {search.data!.slice(0, 25).map((m) => (
                <button
                  key={m.id}
                  onClick={() => pick(m.id, m.name)}
                  className="block w-full px-2 py-1 text-left text-sm text-zinc-200 hover:bg-zinc-700"
                >
                  {m.name}
                </button>
              ))}
            </div>
          )}
        </label>
        <button
          onClick={async () => {
            const loc = await location.refetch();
            if (loc.data) pick(loc.data.systemId, loc.data.systemName);
          }}
          disabled={location.isFetching}
          title="Use your logged-in character's current system"
          className="flex items-center gap-1.5 rounded border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
        >
          <MapPin size={13} /> Detect
        </button>
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          Max jumps
          <input
            type="number"
            value={maxJumps}
            min={1}
            max={30}
            onChange={(e) =>
              setMaxJumps(
                Math.min(30, Math.max(1, Number(e.currentTarget.value) || 1)),
              )
            }
            className="w-24 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none"
          />
        </label>
        {label && (
          <span className="pb-1 text-xs text-zinc-500">
            from <span className="text-zinc-300">{label}</span>
          </span>
        )}
      </div>

      {systemId != null &&
        (result.isLoading ? (
          <div className="mt-4 text-sm text-zinc-500">Finding entries…</div>
        ) : result.isError ? (
          <div className="mt-4 text-sm text-rose-400">
            {errorMessage(result.error)}
          </div>
        ) : result.data ? (
          <EntryResults key={systemId} data={result.data} />
        ) : null)}
    </div>
  );
}
