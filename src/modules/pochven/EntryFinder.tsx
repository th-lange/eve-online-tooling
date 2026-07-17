import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MapPin } from "lucide-react";
import {
  errorMessage,
  marketCurrentLocation,
  pochvenSearch,
  systemSearch,
  type SystemMatch,
} from "../../lib/api";
import { Combo } from "../../components/Combo";
import { EntryResults } from "./EntryResults";

// Active entry search: from your current system, route to the nearest C729
// candidate and list the systems to jump & scan.
export function EntryFinder() {
  const [system, setSystem] = useState<SystemMatch | null>(null);
  const [maxJumps, setMaxJumps] = useState(10);

  const location = useQuery({
    queryKey: ["market", "currentLocation"],
    queryFn: marketCurrentLocation,
    staleTime: 60_000,
    enabled: false,
  });
  const result = useQuery({
    queryKey: ["pochven", "search", system?.id ?? null, maxJumps],
    queryFn: () => pochvenSearch(system!.id, maxJumps),
    enabled: system != null,
    staleTime: 5 * 60_000,
  });

  return (
    <div className="mt-5">
      <div className="flex flex-wrap items-end gap-3">
        <Combo
          label="Your current system"
          value={system}
          onPick={setSystem}
          search={systemSearch}
          placeholder="Search a system…"
          width="w-64"
          maxResults={25}
        />
        <button
          onClick={async () => {
            const loc = await location.refetch();
            if (loc.data)
              setSystem({ id: loc.data.systemId, name: loc.data.systemName });
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
        {system && (
          <span className="pb-1 text-xs text-zinc-500">
            from <span className="text-zinc-300">{system.name}</span>
          </span>
        )}
      </div>

      {system != null &&
        (result.isLoading ? (
          <div className="mt-4 text-sm text-zinc-500">Finding entries…</div>
        ) : result.isError ? (
          <div className="mt-4 text-sm text-rose-400">
            {errorMessage(result.error)}
          </div>
        ) : result.data ? (
          <EntryResults key={system.id} data={result.data} />
        ) : null)}
    </div>
  );
}
