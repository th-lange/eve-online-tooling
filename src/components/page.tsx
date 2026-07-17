import { useContext, type ReactNode } from "react";
import { EyeOff } from "lucide-react";
import { ModuleChromeContext } from "./moduleChromeContext";

/**
 * Page layout templates. Every module page composes these so all pages share
 * one root geometry and one header anatomy:
 *
 *   <Page>
 *     <PageHeader title="…" subtitle="…" actions={<buttons/>} />
 *     …body…
 *   </Page>
 *
 * Rules:
 * - `Page` is full-width (`p-6`) by default — module pages fill the room.
 *   `narrow` exists for prose-like pages (Support).
 * - `PageHeader` must be rendered in EVERY return path of a page (loading
 *   gates, SDE setup, errors included). It owns the module-hide control, so
 *   rendering it unconditionally is what keeps that control from jumping.
 */
export function Page({
  width = "full",
  children,
}: {
  width?: "full" | "narrow";
  children: ReactNode;
}) {
  return (
    <div className={width === "narrow" ? "mx-auto max-w-lg px-6 py-10" : "p-6"}>
      {children}
    </div>
  );
}

/**
 * Standard page header: title + optional subtitle on the left, optional
 * action cluster (buttons, DataAge, …) on the right. The sidebar-hide button
 * renders inline right after the title whenever the page is hosted by
 * `ModuleHost` — a fixed position in the flow, present from first paint.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  const chrome = useContext(ModuleChromeContext);
  return (
    <header className="flex items-start justify-between gap-4">
      <div className="min-w-0">
        <h1 className="flex items-center gap-2 text-2xl font-semibold text-zinc-100">
          {title}
          {chrome && (
            <button
              onClick={chrome.hide}
              title="Hide this module from the sidebar"
              aria-label={`Hide ${chrome.title} from sidebar`}
              className="rounded p-1 text-zinc-600 opacity-60 transition hover:bg-zinc-800 hover:text-zinc-300 hover:opacity-100"
            >
              <EyeOff size={16} />
            </button>
          )}
        </h1>
        {subtitle != null && (
          <p className="mt-1 max-w-2xl text-sm text-zinc-400">{subtitle}</p>
        )}
      </div>
      {actions != null && (
        <div className="flex shrink-0 flex-col items-end gap-1">{actions}</div>
      )}
    </header>
  );
}

/**
 * Two-pane filter/config layout: side-by-side panels on md+, stacked on
 * small screens, with a visible divider on the right pane.
 */
export function SplitPane({
  left,
  right,
}: {
  left: ReactNode;
  right: ReactNode;
}) {
  return (
    <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
      <div className="rounded border border-zinc-800 bg-zinc-900 p-3">
        {left}
      </div>
      <div className="rounded border border-zinc-800 bg-zinc-900 p-3 md:border-l-2 md:border-l-zinc-700">
        {right}
      </div>
    </div>
  );
}

/** Centered muted notice for loading/error/empty gates. */
export function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="p-10 text-center text-sm text-zinc-500">{children}</div>
  );
}

/**
 * Primary page action: the indigo "do the thing" button used in a page
 * header's `actions` (Calculate/Refresh/Scan/Sync/…). `pending`+`pendingLabel`
 * swap in an in-flight label without the caller re-deriving it inline.
 */
export function PrimaryButton({
  onClick,
  disabled,
  pending,
  pendingLabel,
  title,
  children,
}: {
  onClick: () => void;
  disabled?: boolean;
  pending?: boolean;
  pendingLabel?: ReactNode;
  title?: string;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-indigo-500 disabled:opacity-50"
    >
      {pending ? pendingLabel : children}
    </button>
  );
}
