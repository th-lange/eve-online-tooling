import { useEffect, useState, type ReactNode } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { ChevronDown, ChevronRight, GripVertical, Search, Star, X } from "lucide-react";
import { modules, MODULE_GROUPS, type ModuleDef } from "../modules/registry";
import { BridgeStatus } from "./BridgeStatus";
import { Characters } from "./Characters";
import { CommandPalette } from "./CommandPalette";
import appIcon from "../assets/app-icon.png";

const PINS_KEY = "sidebar.pins";
const ORDER_KEY = "sidebar.order";
const COLORS_KEY = "sidebar.colors";
const COLLAPSED_KEY = "sidebar.collapsed";

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

function loadIds(key: string): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(key) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** Load the `{ moduleId: colorKey }` map, keeping only known color keys. */
function loadColors(): Record<string, string> {
  try {
    const raw = JSON.parse(localStorage.getItem(COLORS_KEY) ?? "{}");
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, string> = {};
    for (const [id, key] of Object.entries(raw)) {
      if (typeof key === "string" && COLOR_HEX.has(key)) out[id] = key;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Sort the registry by a user-defined order of ids. Ids missing from `order`
 * (newly-added modules) fall back to their registry position, appended in a
 * stable way so adding a module doesn't shuffle an existing saved order.
 */
function applyOrder(order: string[]): ModuleDef[] {
  const rank = new Map(order.map((id, i) => [id, i]));
  return modules
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
  const [pins, setPins] = useState<string[]>(() => loadIds(PINS_KEY));
  // Custom order over all modules; defaults to registry order until dragged.
  const [order, setOrder] = useState<string[]>(() =>
    applyOrder(loadIds(ORDER_KEY)).map((m) => m.id),
  );
  const [colors, setColors] = useState<Record<string, string>>(loadColors);
  // Collapsed section ids (sections default to open — only collapsed ones persist).
  const [collapsed, setCollapsed] = useState<string[]>(() => loadIds(COLLAPSED_KEY));
  // A drag in progress, tagged with the section it started in — a pinned module
  // shows in both the Pinned section and its group, so reordering is scoped to
  // the section the row was dragged from.
  const [drag, setDrag] = useState<{ id: string; section: string } | null>(null);

  const toggleSection = (id: string) =>
    setCollapsed((prev) => {
      const next = prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id];
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(next));
      return next;
    });

  // Assign (or clear, when `key` is null) a module's accent colour.
  const setColor = (id: string, key: string | null) =>
    setColors((prev) => {
      const next = { ...prev };
      if (key) next[id] = key;
      else delete next[id];
      localStorage.setItem(COLORS_KEY, JSON.stringify(next));
      return next;
    });

  const togglePin = (id: string) =>
    setPins((prev) => {
      const next = prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id];
      localStorage.setItem(PINS_KEY, JSON.stringify(next));
      return next;
    });

  // Drop the dragged row onto `targetId` — only reorders within the same visible
  // section (the row carries the section it was dragged from), so dragging never
  // (un)pins an item or hops it between sections. Reordering the shared custom
  // order reorders the row wherever it appears.
  const handleDrop = (targetId: string, targetSection: string) => {
    if (drag === null) return;
    if (drag.section === targetSection && drag.id !== targetId) {
      setOrder((prev) => {
        const next = moveBefore(prev, drag.id, targetId);
        localStorage.setItem(ORDER_KEY, JSON.stringify(next));
        return next;
      });
    }
    setDrag(null);
  };

  const ordered = applyOrder(order);
  // Pinned modules mirror into a Pinned section on top; every module also stays
  // in its own group section (so pinning doesn't remove it from the group).
  const pinned = ordered.filter((m) => pins.includes(m.id));

  const rowProps = (m: ModuleDef, section: string) => ({
    module: m,
    pinned: pins.includes(m.id),
    onTogglePin: togglePin,
    color: colors[m.id] ?? null,
    onSetColor: setColor,
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
            <img
              src={appIcon}
              alt=""
              className="h-8 w-8 shrink-0 rounded-lg"
            />
            <div className="min-w-0">
              <div className="truncate text-sm font-semibold tracking-wide text-zinc-100">
                EVE Online Tooling
              </div>
              <div className="truncate text-xs text-zinc-500">
                production &amp; trading
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
            const items = ordered.filter((m) => m.group === g.key);
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
        </nav>
        <Characters />
        <div className="border-t border-zinc-800 px-4 py-3">
          <BridgeStatus />
        </div>
      </aside>
      <main className="flex-1 overflow-hidden">
        <ModuleHost />
      </main>
      <CommandPalette />
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
function ModuleHost() {
  const location = useLocation();
  const seg = location.pathname.split("/").filter(Boolean)[0];
  const activeId = modules.some((m) => m.id === seg) ? seg : modules[0].id;

  const [visited, setVisited] = useState<Set<string>>(() => new Set([activeId]));
  useEffect(() => {
    setVisited((prev) => (prev.has(activeId) ? prev : new Set(prev).add(activeId)));
  }, [activeId]);

  return (
    <>
      {modules
        .filter((m) => visited.has(m.id))
        .map((m) => (
          <div
            key={m.id}
            className="h-full overflow-auto"
            style={{ display: m.id === activeId ? "block" : "none" }}
          >
            <m.Component />
          </div>
        ))}
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
  isDragging: boolean;
  onDragStart: () => void;
  onDragEnd: () => void;
  onDropRow: () => void;
}) {
  const hex = color ? COLOR_HEX.get(color) : undefined;
  return (
    <div
      onDragOver={(e) => {
        // Only react while a row drag is in progress (effectAllowed === "move").
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
      }}
      onDrop={(e) => {
        e.preventDefault();
        onDropRow();
      }}
      className={`group flex items-center gap-1 ${isDragging ? "opacity-40" : ""}`}
    >
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
          `block flex-1 rounded px-3 py-2 text-sm ${
            isActive
              ? "bg-zinc-800 text-zinc-100"
              : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
          }`
        }
      >
        {module.title}
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
          <div className="absolute left-0 z-20 mt-1 grid grid-cols-10 gap-2.5 rounded-md border border-zinc-700 bg-zinc-800 p-3 shadow-lg">
            {COLORS.map((c) => (
              <button
                key={c.key}
                title={c.label}
                aria-label={c.label}
                onClick={() => {
                  onSetColor(c.key);
                  setOpen(false);
                }}
                className={`h-7 w-7 rounded-full ring-1 ring-zinc-900 transition-transform hover:scale-110 ${
                  color === c.key ? "outline outline-2 outline-offset-2 outline-zinc-300" : ""
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
              className="flex h-7 w-7 items-center justify-center rounded-full border border-zinc-600 text-zinc-400 transition-transform hover:scale-110 hover:text-zinc-200"
            >
              <X size={14} />
            </button>
          </div>
        </>
      )}
    </div>
  );
}
