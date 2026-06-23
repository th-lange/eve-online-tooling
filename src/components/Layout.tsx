import { NavLink, Outlet } from "react-router-dom";
import { modules } from "../modules/registry";
import { BridgeStatus } from "./BridgeStatus";
import { Characters } from "./Characters";

// App shell: a sidebar whose entries are driven by the module registry, plus
// the routed module page in the main area.
export function Layout() {
  return (
    <div className="flex h-full bg-zinc-950 text-zinc-200">
      <aside className="flex w-60 flex-col border-r border-zinc-800 bg-zinc-900">
        <div className="px-4 py-4">
          <div className="text-sm font-semibold tracking-wide text-zinc-100">
            EVE Online Tooling
          </div>
          <div className="text-xs text-zinc-500">production &amp; trading</div>
        </div>
        <nav className="flex-1 space-y-1 px-2">
          {modules.map((m) => (
            <NavLink
              key={m.id}
              to={`/${m.id}`}
              title={m.description}
              className={({ isActive }) =>
                `block rounded px-3 py-2 text-sm ${
                  isActive
                    ? "bg-zinc-800 text-zinc-100"
                    : "text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-200"
                }`
              }
            >
              {m.title}
            </NavLink>
          ))}
        </nav>
        <Characters />
        <div className="border-t border-zinc-800 px-4 py-3">
          <BridgeStatus />
        </div>
      </aside>
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
