import { useEffect, useState } from "react";
import { NavLink, useLocation } from "react-router-dom";
import { modules, type ModuleDef } from "../modules/registry";
import { BridgeStatus } from "./BridgeStatus";
import { Characters } from "./Characters";

const PINS_KEY = "sidebar.pins";

function loadPins(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(PINS_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// App shell: a sidebar whose entries are driven by the module registry, plus
// the routed module page in the main area. Modules can be pinned to a group at
// the top (persisted in localStorage).
export function Layout() {
  const [pins, setPins] = useState<string[]>(loadPins);

  const togglePin = (id: string) =>
    setPins((prev) => {
      const next = prev.includes(id) ? prev.filter((p) => p !== id) : [...prev, id];
      localStorage.setItem(PINS_KEY, JSON.stringify(next));
      return next;
    });

  const byId = new Map(modules.map((m) => [m.id, m]));
  // Pinned modules in pin order; everything else keeps registry order.
  const pinned = pins
    .map((id) => byId.get(id))
    .filter((m): m is ModuleDef => m !== undefined);
  const rest = modules.filter((m) => !pins.includes(m.id));

  return (
    <div className="flex h-full bg-zinc-950 text-zinc-200">
      <aside className="flex w-60 flex-col border-r border-zinc-800 bg-zinc-900">
        <div className="px-4 py-4">
          <div className="text-sm font-semibold tracking-wide text-zinc-100">
            EVE Online Tooling
          </div>
          <div className="text-xs text-zinc-500">production &amp; trading</div>
        </div>
        <nav className="flex-1 space-y-1 overflow-y-auto px-2">
          {pinned.length > 0 && (
            <>
              {pinned.map((m) => (
                <NavRow key={m.id} module={m} pinned onTogglePin={togglePin} />
              ))}
              <div className="my-1 border-t border-zinc-800" />
            </>
          )}
          {rest.map((m) => (
            <NavRow key={m.id} module={m} pinned={false} onTogglePin={togglePin} />
          ))}
        </nav>
        <Characters />
        <div className="border-t border-zinc-800 px-4 py-3">
          <BridgeStatus />
        </div>
      </aside>
      <main className="flex-1 overflow-hidden">
        <ModuleHost />
      </main>
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

/** A sidebar nav entry with a pin toggle (shown on hover, or solid when pinned). */
function NavRow({
  module,
  pinned,
  onTogglePin,
}: {
  module: ModuleDef;
  pinned: boolean;
  onTogglePin: (id: string) => void;
}) {
  return (
    <div className="group flex items-center gap-1">
      <NavLink
        to={`/${module.id}`}
        title={module.description}
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
      <button
        onClick={() => onTogglePin(module.id)}
        title={pinned ? "Unpin" : "Pin to top"}
        aria-label={pinned ? `Unpin ${module.title}` : `Pin ${module.title}`}
        className={`shrink-0 rounded px-1.5 py-1 text-xs transition-opacity ${
          pinned
            ? "text-amber-400 hover:text-amber-300"
            : "text-zinc-500 opacity-0 hover:text-zinc-200 group-hover:opacity-100"
        }`}
      >
        {pinned ? "★" : "☆"}
      </button>
    </div>
  );
}
