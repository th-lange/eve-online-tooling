// Shared colours + node visuals for the Pochven maps. A plain module (no
// components) so react-refresh hot-reloads the map components cleanly.

import type { SystemGraphNode } from "../../components/SystemGraph";
import { POCHVEN_ENTRY_COUNTS, POCHVEN_META, dominantBand } from "./data";

export const BAND_HEX: Record<string, string> = {
  hisec: "#34d399",
  lowsec: "#fbbf24",
  nullsec: "#fb7185",
};

/** Fill colour by system role. */
export const ROLE_HEX: Record<string, string> = {
  Home: "#f59e0b",
  Border: "#38bdf8",
  Internal: "#94a3b8",
};
/** Ring (outline) colour by clade / constellation. */
export const CLADE_HEX: Record<string, string> = {
  Perun: "#fb7185",
  Svarog: "#a78bfa",
  Veles: "#2dd4bf",
};
/** Constellation names, keyed by clade. */
export const CLADE_KRAI: Record<string, string> = {
  Perun: "Krai Perun",
  Svarog: "Krai Svarog",
  Veles: "Krai Veles",
};

/**
 * Colour + sub-label for a Pochven system on the reference map: fill = role
 * (Home / Border / Internal), ring = constellation (Krai Perun/Svarog/Veles),
 * sub-label = where you can enter from.
 */
export function systemVisual(name: string): Partial<SystemGraphNode> {
  const meta = POCHVEN_META[name];
  const c = POCHVEN_ENTRY_COUNTS[name];
  return {
    kind: dominantBand(name),
    sub: c
      ? [
          c.hisec ? `${c.hisec} hi` : "",
          c.lowsec ? `${c.lowsec} low` : "",
          c.nullsec ? `${c.nullsec} null` : "",
        ]
          .filter(Boolean)
          .join(" · ")
      : meta
        ? `${meta.clade} · ${meta.role}`
        : undefined,
    group: meta?.clade,
    ...(meta?.role ? { fill: ROLE_HEX[meta.role] } : {}),
    ...(meta?.clade ? { ring: CLADE_HEX[meta.clade] } : {}),
  };
}
