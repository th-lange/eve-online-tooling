// Shared colours + node visuals for the Pochven maps. A plain module (no
// components) so react-refresh hot-reloads the map components cleanly.

import type { SystemGraphNode } from "../../components/SystemGraph";
import type { EntryBands } from "../../lib/api";
import { POCHVEN_META } from "./data";

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

/** The band most of a system's C729 candidates sit in (ties → safer). */
export function dominantBand(c: EntryBands): "hisec" | "lowsec" | "nullsec" {
  if (c.hisec >= c.lowsec && c.hisec >= c.nullsec) return "hisec";
  if (c.lowsec >= c.nullsec) return "lowsec";
  return "nullsec";
}

/**
 * Colour + sub-label for a Pochven system on the reference map: fill = role
 * (Home / Border / Internal), ring = constellation (Krai Perun/Svarog/Veles),
 * sub-label = where you can enter from. `bands` comes from the backend
 * (`pochven_map`); while it's still loading the sub-label falls back to
 * clade · role and the band colour to "unknown".
 */
export function systemVisual(
  name: string,
  bands?: EntryBands,
): Partial<SystemGraphNode> {
  const meta = POCHVEN_META[name];
  return {
    kind: bands ? dominantBand(bands) : "unknown",
    sub: bands
      ? [
          bands.hisec ? `${bands.hisec} hi` : "",
          bands.lowsec ? `${bands.lowsec} low` : "",
          bands.nullsec ? `${bands.nullsec} null` : "",
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
