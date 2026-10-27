import { useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";

const OPEN_STATE_PREFIX = "settings.sectionOpen.";

function readStoredOpen(id: string, defaultOpen: boolean): boolean {
  try {
    const raw = localStorage.getItem(OPEN_STATE_PREFIX + id);
    if (raw != null) return raw === "1";
  } catch {
    // Storage unavailable — fall back to the default.
  }
  return defaultOpen;
}

/**
 * A collapsible group of settings controls: a clickable header (title +
 * optional description + chevron) toggling a body of children. Expanded by
 * default; the open/closed state is remembered per `id` in localStorage, so
 * a user's preferred layout survives a restart.
 */
export function SettingsSection({
  id,
  title,
  description,
  defaultOpen = true,
  children,
}: {
  id: string;
  title: string;
  description?: string;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(() => readStoredOpen(id, defaultOpen));

  function toggle() {
    setOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(OPEN_STATE_PREFIX + id, next ? "1" : "0");
      } catch {
        // Storage unavailable — section still toggles in-memory.
      }
      return next;
    });
  }

  return (
    <section className="overflow-hidden rounded-lg border border-zinc-800 bg-zinc-900/40">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 p-4 text-left"
      >
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-zinc-100">
            {title}
          </span>
          {description && (
            <span className="mt-0.5 block text-xs text-zinc-500">
              {description}
            </span>
          )}
        </span>
        {open ? (
          <ChevronDown className="h-4 w-4 shrink-0 text-zinc-500" />
        ) : (
          <ChevronRight className="h-4 w-4 shrink-0 text-zinc-500" />
        )}
      </button>
      {open && (
        <div className="divide-y divide-zinc-800 border-t border-zinc-800">
          {children}
        </div>
      )}
    </section>
  );
}
