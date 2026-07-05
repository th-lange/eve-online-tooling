import type { ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

/**
 * Wraps a kill count (or any label) as a link to the system's zKillboard page.
 * Stops propagation so it composes with clickable rows/tiles.
 */
export function ZkillSystemLink({
  systemId,
  children,
  className = "",
}: {
  systemId: number;
  children: ReactNode;
  className?: string;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        void openUrl(`https://zkillboard.com/system/${systemId}/`).catch(
          () => {},
        );
      }}
      title="Open this system on zKillboard"
      className={`cursor-pointer underline decoration-dotted decoration-zinc-600 underline-offset-2 hover:decoration-current ${className}`}
    >
      {children}
    </button>
  );
}
