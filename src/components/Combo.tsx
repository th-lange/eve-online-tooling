import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDebouncedValue } from "../lib/useDebouncedValue";

/** A searchable combobox over an SDE/region/system search command, clearable.
 * The typed query is debounced before it reaches the search call, so fast
 * typing fires one backend request per pause instead of one per keystroke. */
export function Combo<T extends { id: number; name: string }>({
  label,
  value,
  onPick,
  search,
  placeholder,
  width = "w-52",
  maxResults,
  queryKey,
  staleTime,
}: {
  label?: string;
  value: T | null;
  onPick: (v: T | null) => void;
  search: (query: string) => Promise<T[]>;
  placeholder?: string;
  width?: string;
  maxResults?: number;
  /** Override the default `["combo", label, text]` cache key — e.g. to share
   *  a cache entry with other components hitting the same underlying search
   *  (see MarketSearchPage's item picker, keyed onto `sdeKeys.search`). */
  queryKey?: (text: string) => readonly unknown[];
  /** Override the default (global) staleTime to match the shared key's policy. */
  staleTime?: number;
}) {
  const [text, setText] = useState("");
  const debouncedText = useDebouncedValue(text, 200);
  const results = useQuery({
    queryKey: (queryKey ?? ((t) => ["combo", label ?? "", t]))(debouncedText),
    queryFn: () => search(debouncedText),
    enabled: debouncedText.trim().length >= 2 && value == null,
    staleTime,
  });
  const data = maxResults
    ? (results.data?.slice(0, maxResults) ?? [])
    : (results.data ?? []);

  const field = (
    <div className="flex items-center gap-1">
      <input
        value={value ? value.name : text}
        onChange={(e) => {
          if (value) onPick(null);
          setText(e.currentTarget.value);
        }}
        placeholder={placeholder}
        className={`${width} rounded bg-zinc-800 px-2 py-1 text-sm text-zinc-100 outline-none placeholder:text-zinc-500`}
      />
      {value && (
        <button
          onClick={() => {
            onPick(null);
            setText("");
          }}
          title="Clear"
          className="rounded border border-zinc-700 px-1.5 text-xs text-zinc-400 hover:bg-zinc-800"
        >
          ✕
        </button>
      )}
    </div>
  );

  return (
    <div className="relative">
      {label ? (
        <label className="flex flex-col gap-1 text-xs text-zinc-400">
          {label}
          {field}
        </label>
      ) : (
        field
      )}
      {!value && data.length > 0 && (
        <div
          className={`absolute z-10 mt-1 max-h-60 ${width} overflow-auto rounded border border-zinc-700 bg-zinc-900 text-sm shadow-lg`}
        >
          {data.map((r) => (
            <button
              key={r.id}
              onClick={() => {
                onPick(r);
                setText(r.name);
              }}
              className="block w-full px-2 py-1 text-left text-zinc-300 hover:bg-zinc-800"
            >
              {r.name}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
