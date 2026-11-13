import { useId, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useDebouncedValue } from "../lib/useDebouncedValue";
import { comboKeys } from "../lib/queryKeys";

/** A searchable combobox over an SDE/region/system search command, clearable.
 * The typed query is debounced before it reaches the search call, so fast
 * typing fires one backend request per pause instead of one per keystroke. */
export function Combo<T extends { id: number; name: string }>({
  label,
  scope,
  value,
  onPick,
  search,
  placeholder,
  width = "w-52",
  maxResults,
  queryKey,
  staleTime,
  title,
}: {
  label?: string;
  /** Names the search backend in the default cache key ("ships",
   *  "systems", …). Required in practice whenever `label` is omitted: the key
   *  is otherwise `["combo", "", text]`, shared by *every* unlabelled combo, so
   *  a ship picker's cached results would be served to a system picker (#1193). */
  scope?: string;
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
  /** Optional tooltip shown on hover on the labelled wrapper. */
  title?: string;
}) {
  const [text, setText] = useState("");
  // Dropdown visibility is explicit so Escape / blur can dismiss it without
  // discarding the typed text; typing re-opens it.
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const listId = useId();
  const debouncedText = useDebouncedValue(text, 200);
  const results = useQuery({
    queryKey: (queryKey ?? ((t) => comboKeys.default(scope ?? label ?? "", t)))(
      debouncedText,
    ),
    queryFn: () => search(debouncedText),
    enabled: debouncedText.trim().length >= 2 && value == null,
    staleTime,
  });
  const data = maxResults
    ? (results.data?.slice(0, maxResults) ?? [])
    : (results.data ?? []);

  const showList = open && !value && data.length > 0;
  const optionId = (i: number) => `${listId}-opt-${i}`;
  const activeIndex = Math.min(active, Math.max(0, data.length - 1));

  const pick = (r: T) => {
    onPick(r);
    setText(r.name);
    setOpen(false);
  };

  const field = (
    <div className="flex items-center gap-1">
      <input
        value={value ? value.name : text}
        onChange={(e) => {
          if (value) onPick(null);
          setText(e.currentTarget.value);
          setActive(0);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            if (showList) {
              // Close just the list; don't let an enclosing dialog also close.
              e.stopPropagation();
              setOpen(false);
            }
          } else if (e.key === "ArrowDown") {
            if (data.length === 0 || value) return;
            e.preventDefault();
            if (!open) setOpen(true);
            else setActive(Math.min(activeIndex + 1, data.length - 1));
          } else if (e.key === "ArrowUp") {
            if (!showList) return;
            e.preventDefault();
            setActive(Math.max(activeIndex - 1, 0));
          } else if (e.key === "Enter" && showList) {
            e.preventDefault();
            pick(data[activeIndex]);
          }
        }}
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={showList ? optionId(activeIndex) : undefined}
        aria-label={label ? undefined : (placeholder ?? scope ?? "Search")}
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
          aria-label={label ? `Clear ${label}` : "Clear selection"}
          className="rounded border border-zinc-700 px-1.5 text-xs text-zinc-400 hover:bg-zinc-800"
        >
          ✕
        </button>
      )}
    </div>
  );

  return (
    <div
      className="relative"
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null))
          setOpen(false);
      }}
    >
      {label ? (
        <label
          className="flex flex-col gap-1 text-xs text-zinc-400"
          title={title}
        >
          {label}
          {field}
        </label>
      ) : (
        field
      )}
      {showList && (
        <div
          id={listId}
          role="listbox"
          aria-label={label ?? placeholder ?? "Results"}
          className={`absolute z-10 mt-1 max-h-60 ${width} overflow-auto rounded border border-zinc-700 bg-zinc-900 text-sm shadow-lg`}
        >
          {data.map((r, i) => (
            <div
              key={r.id}
              id={optionId(i)}
              role="option"
              aria-selected={i === activeIndex}
              ref={(el) => {
                if (el && i === activeIndex)
                  el.scrollIntoView({ block: "nearest" });
              }}
              // Suppressing mousedown keeps focus in the input so the blur
              // handler doesn't close the list before the click lands.
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(r)}
              onMouseEnter={() => setActive(i)}
              className={`block w-full cursor-pointer px-2 py-1 text-left text-zinc-300 ${
                i === activeIndex ? "bg-zinc-800" : "hover:bg-zinc-800"
              }`}
            >
              {r.name}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
