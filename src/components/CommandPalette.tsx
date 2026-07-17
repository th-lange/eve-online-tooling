import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { CornerDownLeft, Package, Search } from "lucide-react";
import { modules } from "../modules/registry";
import { usePluginModules } from "../modules/plugins/pluginModules";
import { sdeSearch } from "../lib/api";
import { openItemInMarketSearch } from "../lib/deepLink";
import { fuzzy } from "../lib/fuzzy";

// A flat row in the result list — either a module jump or an item lookup.
type Entry =
  | { kind: "module"; id: string; title: string; subtitle: string }
  | { kind: "item"; id: number; title: string; subtitle: string };

/**
 * ⌘K / Ctrl+K command palette: fuzzy-jump to any module (off the registry) and
 * look up any item type, routing the pick to Market Search (#228). Mounted once
 * in the Layout; owns its own open state and the global hotkey.
 */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  // Global hotkey: ⌘K / Ctrl+K toggles, Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    const onOpen = () => setOpen(true);
    window.addEventListener("keydown", onKey);
    window.addEventListener("palette:open", onOpen);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("palette:open", onOpen);
    };
  }, []);

  // Reset and focus each time it opens.
  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      // Focus after the element is painted.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const pluginModules = usePluginModules();
  const moduleEntries: Entry[] = useMemo(
    () =>
      [...modules, ...pluginModules]
        .filter((m) => fuzzy(m.title, q.trim()))
        .map((m) => ({
          kind: "module",
          id: m.id,
          title: m.title,
          subtitle: m.description,
        })),
    [q, pluginModules],
  );

  // Item lookup only kicks in once it looks like a real query.
  const trimmed = q.trim();
  const itemQuery = useQuery({
    queryKey: ["palette", "items", trimmed],
    queryFn: () => sdeSearch(trimmed),
    enabled: open && trimmed.length >= 2,
  });
  const itemEntries: Entry[] = useMemo(
    () =>
      (itemQuery.data ?? []).slice(0, 8).map((it) => ({
        kind: "item",
        id: it.id,
        title: it.name,
        subtitle: "Open in Market Search",
      })),
    [itemQuery.data],
  );

  const entries = useMemo(
    () => [...moduleEntries, ...itemEntries],
    [moduleEntries, itemEntries],
  );

  // Keep the selection in range as the list changes.
  useEffect(() => {
    setSel((s) => Math.min(s, Math.max(0, entries.length - 1)));
  }, [entries.length]);

  if (!open) return null;

  const activate = (entry: Entry | undefined) => {
    if (!entry) return;
    if (entry.kind === "module") {
      navigate(`/${entry.id}`);
    } else {
      openItemInMarketSearch({ id: entry.id, name: entry.title });
      navigate("/market-search");
    }
    setOpen(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[12vh]"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-[36rem] max-w-[90vw] overflow-hidden rounded-lg border border-zinc-700 bg-zinc-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 border-b border-zinc-800 px-3">
          <Search size={16} className="shrink-0 text-zinc-500" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((s) => Math.min(s + 1, entries.length - 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((s) => Math.max(s - 1, 0));
              } else if (e.key === "Enter") {
                e.preventDefault();
                activate(entries[sel]);
              }
            }}
            placeholder="Jump to a module or search an item…"
            className="w-full bg-transparent py-3 text-sm text-zinc-100 outline-none placeholder:text-zinc-500"
          />
        </div>

        <div className="max-h-80 overflow-y-auto py-1">
          {entries.length === 0 && (
            <div className="px-3 py-6 text-center text-xs text-zinc-500">
              {trimmed.length >= 2 && itemQuery.isFetching
                ? "Searching…"
                : "No matches."}
            </div>
          )}
          {entries.map((entry, i) => (
            <button
              key={`${entry.kind}:${entry.id}`}
              onMouseEnter={() => setSel(i)}
              onClick={() => activate(entry)}
              className={`flex w-full items-center gap-2 px-3 py-2 text-left ${
                i === sel ? "bg-indigo-600/20" : "hover:bg-zinc-800/60"
              }`}
            >
              {entry.kind === "module" ? (
                <span className="grid h-6 w-6 shrink-0 place-items-center rounded bg-zinc-800 text-[10px] font-semibold uppercase text-zinc-400">
                  {entry.title.slice(0, 2)}
                </span>
              ) : (
                <Package size={16} className="shrink-0 text-zinc-500" />
              )}
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-zinc-100">
                  {entry.title}
                </span>
                <span className="block truncate text-xs text-zinc-500">
                  {entry.subtitle}
                </span>
              </span>
              {i === sel && (
                <CornerDownLeft size={14} className="shrink-0 text-zinc-500" />
              )}
            </button>
          ))}
        </div>

        <div className="flex items-center justify-between border-t border-zinc-800 px-3 py-1.5 text-[10px] text-zinc-600">
          <span>↑↓ navigate · ↵ open · esc close</span>
          <span>⌘K</span>
        </div>
      </div>
    </div>
  );
}
