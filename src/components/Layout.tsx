import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ModuleActiveContext } from "./moduleActiveContext";
import { ModuleChromeContext } from "./moduleChromeContext";
import { NavLink, useLocation } from "react-router-dom";
import {
  ChevronDown,
  ChevronRight,
  Eye,
  GripVertical,
  Search,
  Star,
  X,
} from "lucide-react";
import { modules, MODULE_GROUPS, type ModuleDef } from "../modules/registry";
import { usePluginModules } from "../modules/plugins/pluginModules";
import { BridgeStatus } from "./BridgeStatus";
import { Characters } from "./Characters";
import { CommandPalette } from "./CommandPalette";
import { SupportModal } from "./SupportMyWork";
import { STORAGE_KEYS } from "../lib/storageKeys";
import { usePersistentState } from "../lib/usePersistentState";
import { useInfoAlerts } from "../modules/info/infoContext";
import { scriptsList } from "../lib/api";
import appIcon from "../assets/app-icon.png";

const PINS_KEY = STORAGE_KEYS.sidebarPins;
const ORDER_KEY = STORAGE_KEYS.sidebarOrder;
const COLORS_KEY = STORAGE_KEYS.sidebarColors;
const COLLAPSED_KEY = STORAGE_KEYS.sidebarCollapsed;
const HIDDEN_KEY = STORAGE_KEYS.sidebarHidden;

// Accent palette for tagging sidebar entries. Tailwind 400-level hues, spread
// around the wheel so they stay distinct as small accents on the dark sidebar.
const COLORS: { key: string; label: string; hex: string }[] = [
  { key: "rose", label: "Rose", hex: "#fb7185" },
  { key: "orange", label: "Orange", hex: "#fb923c" },
  { key: "amber", label: "Amber", hex: "#fbbf24" },
  { key: "lime", label: "Lime", hex: "#a3e635" },
  { key: "emerald", label: "Emerald", hex: "#34d399" },
  { key: "cyan", label: "Cyan", hex: "#22d3ee" },
  { key: "sky", label: "Sky", hex: "#38bdf8" },
  { key: "violet", label: "Violet", hex: "#a78bfa" },
  { key: "fuchsia", label: "Fuchsia", hex: "#e879f9" },
];
const COLOR_HEX = new Map(COLORS.map((c) => [c.key, c.hex]));

/** Keep only string entries — defends against hand-edited/corrupted storage. */
function sanitizeIds(raw: string[]): string[] {
  return raw.filter((x) => typeof x === "string");
}

/** Keep only entries whose value is a known color key. */
function sanitizeColors(raw: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, key] of Object.entries(raw)) {
    if (typeof key === "string" && COLOR_HEX.has(key)) out[id] = key;
  }
  return out;
}

/**
 * Sort the registry by a user-defined order of ids. Ids missing from `order`
 * (newly-added modules) fall back to their registry position, appended in a
 * stable way so adding a module doesn't shuffle an existing saved order.
 */
function applyOrder(list: ModuleDef[], order: string[]): ModuleDef[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  return list
    .map((m, i) => ({ m, i }))
    .sort((a, b) => {
      const ra = rank.has(a.m.id) ? rank.get(a.m.id)! : Number.MAX_SAFE_INTEGER;
      const rb = rank.has(b.m.id) ? rank.get(b.m.id)! : Number.MAX_SAFE_INTEGER;
      return ra - rb || a.i - b.i;
    })
    .map(({ m }) => m);
}

/** Move `dragId` to sit immediately before `targetId` in the id list. */
function moveBefore(ids: string[], dragId: string, targetId: string): string[] {
  if (dragId === targetId) return ids;
  const without = ids.filter((id) => id !== dragId);
  const at = without.indexOf(targetId);
  if (at === -1) return ids;
  without.splice(at, 0, dragId);
  return without;
}

// App shell: a sidebar whose entries are driven by the module registry, plus
// the routed module page in the main area. Modules can be pinned to a group at
// the top and drag-reordered within their group (both persisted in localStorage).
export function Layout() {
  const [pinsRaw, setPins] = usePersistentState<string[]>(PINS_KEY, []);
  const pins = sanitizeIds(pinsRaw);
  // Custom order over all modules; defaults to registry order until dragged.
  const [orderRaw, setOrder] = usePersistentState<string[]>(
    ORDER_KEY,
    modules.map((m) => m.id),
  );
  const order = sanitizeIds(orderRaw);
  // Active plugins that ship a UI become first-class nav modules, merged after
  // the built-ins. Everything below (ordering, pin/hide, the host) treats them
  // like any other module.
  const pluginModules = usePluginModules();
  const allModules = useMemo(
    () => [...modules, ...pluginModules],
    [pluginModules],
  );
  const [colorsRaw, setColors] = usePersistentState<Record<string, string>>(
    COLORS_KEY,
    {},
  );
  const colors = sanitizeColors(colorsRaw);
  // Collapsed section ids (sections default to open — only collapsed ones persist).
  const [collapsedRaw, setCollapsed] = usePersistentState<string[]>(
    COLLAPSED_KEY,
    [],
  );
  const collapsed = sanitizeIds(collapsedRaw);
  // Modules the user has hidden from the nav; they collect in a "Hidden" section
  // at the bottom from which they can be restored. Hiding is nav-only — the
  // route and command palette still reach the module.
  const [hiddenRaw, setHidden] = usePersistentState<string[]>(HIDDEN_KEY, []);
  const hidden = sanitizeIds(hiddenRaw);
  // A drag in progress, tagged with the section it started in — a pinned module
  // shows in both the Pinned section and its group, so reordering is scoped to
  // the section the row was dragged from.
  const [drag, setDrag] = useState<{ id: string; section: string } | null>(
    null,
  );

  const toggleSection = (id: string) =>
    setCollapsed((prev) =>
      prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id],
    );

  // Assign (or clear, when `key` is null) a module's accent colour.
  const setColor = (id: string, key: string | null) =>
    setColors((prev) => {
      const next = { ...prev };
      if (key) next[id] = key;
      else delete next[id];
      return next;
    });

  const toggleHidden = (id: string) =>
    setHidden((prev) =>
      prev.includes(id) ? prev.filter((h) => h !== id) : [...prev, id],
    );

  const togglePin = (id: string) =>
    setPins((prev) =>
      prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id],
    );

  // Drop the dragged row onto `targetId` — only reorders within the same visible
  // section (the row carries the section it was dragged from), so dragging never
  // (un)pins an item or hops it between sections. Reordering the shared custom
  // order reorders the row wherever it appears.
  const handleDrop = (targetId: string, targetSection: string) => {
    if (drag === null) return;
    if (drag.section === targetSection && drag.id !== targetId) {
      setOrder((prev) => moveBefore(prev, drag.id, targetId));
    }
    setDrag(null);
  };

  const ordered = applyOrder(allModules, order);
  // Pinned modules mirror into a Pinned section on top; every module also stays
  // in its own group section (so pinning doesn't remove it from the group).
  // Hidden modules drop out of both and collect in the Hidden section instead.
  const pinned = ordered.filter(
    (m) => pins.includes(m.id) && !hidden.includes(m.id),
  );
  const hiddenModules = ordered.filter((m) => hidden.includes(m.id));

  const rowProps = (m: ModuleDef, section: string) => ({
    module: m,
    pinned: pins.includes(m.id),
    onTogglePin: togglePin,
    color: colors[m.id] ?? null,
    onSetColor: setColor,
    // Only the Pinned section is drag-sortable; group sections keep a fixed order.
    sortable: section === "pinned",
    isDragging: drag?.id === m.id && drag.section === section,
    onDragStart: () => setDrag({ id: m.id, section }),
    onDragEnd: () => setDrag(null),
    onDropRow: () => handleDrop(m.id, section),
  });

  return (
    <div className="flex h-full bg-zinc-950 text-zinc-200">
      <aside className="flex w-60 flex-col border-r border-zinc-800 bg-zinc-900">
        <div className="px-4 py-4">
          <div className="flex items-center gap-2.5">
            <img src={appIcon} alt="" className="h-8 w-8 shrink-0 rounded-lg" />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold tracking-wide text-zinc-100">
                EVE Online Tooling
              </div>
            </div>
          </div>
          <button
            onClick={() => window.dispatchEvent(new Event("palette:open"))}
            title="Open command palette"
            className="mt-3 flex w-full items-center gap-2 rounded border border-zinc-800 bg-zinc-950/50 px-2 py-1.5 text-xs text-zinc-500 hover:border-zinc-700 hover:text-zinc-300"
          >
            <Search size={13} />
            <span className="flex-1 text-left">Search…</span>
            <kbd className="rounded bg-zinc-800 px-1 text-[10px] text-zinc-400">
              ⌘K
            </kbd>
          </button>
        </div>
        <nav className="flex-1 overflow-y-auto px-2 pb-2">
          {pinned.length > 0 && (
            <NavSection
              label="Pinned"
              collapsed={collapsed.includes("pinned")}
              onToggle={() => toggleSection("pinned")}
            >
              {pinned.map((m) => (
                <NavRow key={m.id} {...rowProps(m, "pinned")} />
              ))}
            </NavSection>
          )}
          {MODULE_GROUPS.map((g) => {
            // Group sections keep a fixed (registry) order — only Pinned sorts.
            const items = allModules.filter(
              (m) => m.group === g.key && !hidden.includes(m.id),
            );
            if (items.length === 0) return null;
            return (
              <NavSection
                key={g.key}
                label={g.label}
                collapsed={collapsed.includes(g.key)}
                onToggle={() => toggleSection(g.key)}
              >
                {items.map((m) => (
                  <NavRow key={m.id} {...rowProps(m, g.key)} />
                ))}
              </NavSection>
            );
          })}
          {hiddenModules.length > 0 && (
            // Set apart with a divider so it reads as a distinct "manage hidden"
            // area, not just another group. Its rows can't be hidden or pinned —
            // only restored.
            <div className="mt-2 border-t border-zinc-800 pt-2">
              <NavSection
                label={`Hidden (${hiddenModules.length})`}
                collapsed={collapsed.includes("hidden")}
                onToggle={() => toggleSection("hidden")}
              >
                {hiddenModules.map((m) => (
                  <HiddenRow key={m.id} module={m} onRestore={toggleHidden} />
                ))}
              </NavSection>
            </div>
          )}
        </nav>
        <Characters />
        <div className="border-t border-zinc-800 px-4 py-3">
          <BridgeStatus />
        </div>
      </aside>
      <main className="flex-1 overflow-hidden">
        <ModuleHost onHide={toggleHidden} mods={allModules} />
      </main>
      <CommandPalette />
      <SupportModal />
    </div>
  );
}

/**
 * Keep-alive host for the module pages. Each page is mounted on its first visit
 * and then **kept mounted** (just hidden) when you navigate elsewhere, so
 * switching tabs no longer unmounts/resets a page — its inputs, results and
 * scroll position are all preserved, and its data revalidates in the background.
 * Pages are mounted lazily (only once visited), so nothing fetches up front.
 */
function ModuleHost({
  onHide,
  mods,
}: {
  onHide: (id: string) => void;
  mods: ModuleDef[];
}) {
  const location = useLocation();
  const seg = location.pathname.split("/").filter(Boolean)[0];
  const activeId = mods.some((m) => m.id === seg) ? seg : mods[0].id;

  const [visited, setVisited] = useState<Set<string>>(
    () => new Set([activeId]),
  );
  useEffect(() => {
    setVisited((prev) =>
      prev.has(activeId) ? prev : new Set(prev).add(activeId),
    );
  }, [activeId]);

  // Page chrome (title + hide callback) flows to pages via context; the shared
  // `PageHeader` template renders the hide control inline next to the title in
  // every page state (loading gate, setup, ready), so it never relocates.

  return (
    <>
      {mods
        .filter((m) => visited.has(m.id))
        .map((m) => {
          const active = m.id === activeId;
          return (
            <div
              key={m.id}
              className="relative h-full overflow-auto"
              style={{ display: active ? "block" : "none" }}
            >
              <ModuleChromeContext.Provider
                value={{ title: m.title, hide: () => onHide(m.id) }}
              >
                <ModuleActiveContext.Provider value={active}>
                  <m.Component />
                </ModuleActiveContext.Provider>
              </ModuleChromeContext.Provider>
            </div>
          );
        })}
    </>
  );
}

/** A labelled sidebar section: a small caption above its grouped nav rows. */
function NavSection({
  label,
  collapsed,
  onToggle,
  children,
}: {
  label: string;
  collapsed: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className="mb-2">
      <button
        onClick={onToggle}
        aria-expanded={!collapsed}
        className="flex w-full items-center gap-1 px-2 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-500 hover:text-zinc-300"
      >
        {collapsed ? <ChevronRight size={12} /> : <ChevronDown size={12} />}
        {label}
      </button>
      {!collapsed && <div className="space-y-0.5">{children}</div>}
    </div>
  );
}

/**
 * A sidebar nav entry with a pin toggle (shown on hover, or solid when pinned)
 * and a drag handle for reordering within its group. The whole row is the drag
 * source; dropping onto another row moves this one before it.
 */
function NavRow({
  module,
  pinned,
  onTogglePin,
  color,
  onSetColor,
  sortable,
  isDragging,
  onDragStart,
  onDragEnd,
  onDropRow,
}: {
  module: ModuleDef;
  pinned: boolean;
  onTogglePin: (id: string) => void;
  color: string | null;
  onSetColor: (id: string, key: string | null) => void;
  sortable: boolean;
  isDragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDropRow: () => void;
}) {
  const hex = color ? COLOR_HEX.get(color) : undefined;
  const { unseen, hasEntries } = useInfoAlerts();
  // Shares the ["scripts"] query cache with the Scripts page, so this stays
  // live the moment a script is armed/disarmed/saved there — no polling.
  const scriptsQ = useQuery({ queryKey: ["scripts"], queryFn: scriptsList });
  const runningScripts = (scriptsQ.data ?? []).filter(
    (s) => s.enabled && s.intervalMin != null,
  ).length;
  return (
    <div
      onDragOver={
        sortable
          ? (e) => {
              // Only react while a row drag is in progress.
              e.preventDefault();
              if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
            }
          : undefined
      }
      onDrop={
        sortable
          ? (e) => {
              e.preventDefault();
              onDropRow();
            }
          : undefined
      }
      className={`group flex items-center gap-1 ${isDragging ? "opacity-40" : ""}`}
    >
      {sortable ? (
        <span
          draggable
          aria-hidden
          title="Drag to reorder"
          onDragStart={(e) => {
            // Only the handle is the drag source, so dragging never competes with
            // the NavLink anchor. The id is also kept in component state, which is
            // what the drop handler actually reads.
            if (e.dataTransfer) {
              e.dataTransfer.setData("text/plain", module.id);
              e.dataTransfer.effectAllowed = "move";
            }
            onDragStart();
          }}
          onDragEnd={onDragEnd}
          className="flex shrink-0 cursor-grab select-none items-center px-1 text-zinc-500 opacity-0 group-hover:opacity-100"
        >
          <GripVertical size={14} />
        </span>
      ) : (
        // Spacer keeping group rows aligned with the draggable pinned rows.
        <span aria-hidden className="shrink-0 px-1">
          <span className="block h-3.5 w-3.5" />
        </span>
      )}
      <NavLink
        to={`/${module.id}`}
        title={module.description}
        draggable={false}
        style={({ isActive }) =>
          hex
            ? {
                // Left accent bar in both states; tint the label when inactive.
                boxShadow: `inset 3px 0 0 ${hex}`,
                ...(isActive ? {} : { color: hex }),
              }
            : undefined
        }
        className={({ isActive }) =>
          `flex flex-1 items-center gap-2 rounded px-3 py-2 text-sm ${
            isActive
              ? "bg-zinc-800 text-zinc-100"
              : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
          }`
        }
      >
        {module.icon && (
          <module.icon
            size={14}
            className={`shrink-0 ${module.id === "info" && hasEntries ? "text-red-400" : ""}`}
          />
        )}
        {module.title}
        {module.id === "info" && unseen > 0 && (
          <span
            title={`${unseen} new alert${unseen === 1 ? "" : "s"}`}
            className="ml-auto min-w-4 rounded-full bg-red-600 px-1.5 text-center text-[10px] font-semibold leading-4 text-white"
          >
            {unseen}
          </span>
        )}
        {module.id === "scripts" && runningScripts > 0 && (
          <span
            title={`${runningScripts} script${runningScripts === 1 ? "" : "s"} running on a loop`}
            className="ml-auto min-w-4 rounded-full bg-emerald-600 px-1.5 text-center text-[10px] font-semibold leading-4 text-white"
          >
            {runningScripts}
          </span>
        )}
      </NavLink>
      <ColorPicker
        title={module.title}
        color={color}
        onSetColor={(key) => onSetColor(module.id, key)}
      />
      <button
        onClick={() => onTogglePin(module.id)}
        title={pinned ? "Unpin" : "Pin to top"}
        aria-label={pinned ? `Unpin ${module.title}` : `Pin ${module.title}`}
        className={`flex shrink-0 items-center rounded p-1.5 transition-opacity ${
          pinned
            ? "text-amber-400 hover:text-amber-300"
            : "text-zinc-500 opacity-0 hover:text-zinc-200 group-hover:opacity-100"
        }`}
      >
        <Star size={14} fill={pinned ? "currentColor" : "none"} />
      </button>
    </div>
  );
}

/**
 * A muted row in the Hidden section: the module is still reachable (the label
 * stays a link) but a one-click restore button returns it to its group/pin.
 */
function HiddenRow({
  module,
  onRestore,
}: {
  module: ModuleDef;
  onRestore: (id: string) => void;
}) {
  return (
    <div className="group flex items-center gap-1">
      {/* Spacer keeping labels aligned with the drag-handled rows above. */}
      <span aria-hidden className="shrink-0 px-1">
        <span className="block h-3.5 w-3.5" />
      </span>
      <NavLink
        to={`/${module.id}`}
        title={module.description}
        draggable={false}
        className={({ isActive }) =>
          `block flex-1 rounded px-3 py-2 text-sm ${
            isActive
              ? "bg-zinc-800 text-zinc-300"
              : "text-zinc-500 hover:bg-zinc-800/60 hover:text-zinc-300"
          }`
        }
      >
        {module.title}
      </NavLink>
      <button
        onClick={() => onRestore(module.id)}
        title="Restore to sidebar"
        aria-label={`Restore ${module.title}`}
        className="flex shrink-0 items-center rounded p-1.5 text-zinc-500 hover:text-zinc-200"
      >
        <Eye size={14} />
      </button>
    </div>
  );
}

/**
 * Swatch button that opens a 9-colour palette popover for tagging a nav entry.
 * The swatch stays visible while a colour is set (so it's always changeable);
 * otherwise it only appears on row hover, like the other row controls.
 */
function ColorPicker({
  title,
  color,
  onSetColor,
}: {
  title: string;
  color: string | null;
  onSetColor: (key: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const hex = color ? COLOR_HEX.get(color) : undefined;
  return (
    <div className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Set colour"
        aria-label={`Set colour for ${title}`}
        className={`rounded px-1.5 py-1 transition-opacity ${
          color ? "opacity-100" : "opacity-0 group-hover:opacity-100"
        }`}
      >
        <span
          className="block h-3 w-3 rounded-full border border-zinc-600"
          style={hex ? { backgroundColor: hex, borderColor: hex } : undefined}
        />
      </button>
      {open && (
        <>
          {/* Click-away backdrop. */}
          <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />
          <div className="absolute right-0 z-20 mt-1 grid grid-cols-5 gap-2.5 rounded-md border border-zinc-700 bg-zinc-800 p-3 shadow-lg">
            {COLORS.map((c) => (
              <button
                key={c.key}
                title={c.label}
                aria-label={c.label}
                onClick={() => {
                  onSetColor(c.key);
                  setOpen(false);
                }}
                className={`h-8 w-8 rounded-full ring-1 ring-zinc-900 transition-transform hover:scale-110 ${
                  color === c.key
                    ? "outline outline-2 outline-offset-2 outline-zinc-300"
                    : ""
                }`}
                style={{ backgroundColor: c.hex }}
              />
            ))}
            <button
              title="Clear colour"
              aria-label="Clear colour"
              onClick={() => {
                onSetColor(null);
                setOpen(false);
              }}
              className="flex h-8 w-8 items-center justify-center rounded-full border border-zinc-600 text-zinc-400 transition-transform hover:scale-110 hover:text-zinc-200"
            >
              <X size={14} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
