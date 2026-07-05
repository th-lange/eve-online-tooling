import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { systemSearch, type SystemMatch } from "../../lib/api";

export function SystemPicker({
  picked,
  onPick,
}: {
  picked: SystemMatch | null;
  onPick: (m: SystemMatch | null) => void;
}) {
  const [query, setQuery] = useState("");
  const matches = useQuery({
    queryKey: ["wh", "systemSearch", query],
    queryFn: () => systemSearch(query),
    enabled: query.trim().length >= 2 && !picked,
  });
  return (
    <div className="relative">
      <input
        value={picked ? picked.name : query}
        onChange={(e) => {
          onPick(null);
          setQuery(e.currentTarget.value);
        }}
        placeholder="System…"
        className="w-40 rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-600"
      />
      {!picked &&
        query.trim().length >= 2 &&
        (matches.data?.length ?? 0) > 0 && (
          <div className="absolute z-10 mt-1 max-h-48 w-40 overflow-auto rounded border border-zinc-700 bg-zinc-900 shadow-lg">
            {matches.data!.map((m) => (
              <button
                key={m.id}
                onClick={() => {
                  onPick(m);
                  setQuery("");
                }}
                className="block w-full px-2 py-1 text-left text-sm text-zinc-200 hover:bg-zinc-800"
              >
                {m.name}
              </button>
            ))}
          </div>
        )}
    </div>
  );
}

/** Labelled form field wrapper used across the wormhole panels. */
export function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-xs text-zinc-400">
      {label}
      {children}
    </label>
  );
}
