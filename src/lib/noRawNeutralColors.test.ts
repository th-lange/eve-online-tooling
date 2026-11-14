import { describe, expect, it } from "vitest";

// Guard for the Light theme (#1213). Light works by remapping Tailwind's palette
// variables (theme-light.css), which only reaches colours that go through them.
// A hard-coded zinc-family hex in a chart or style object stays dark in Light.
// Use `var(--color-zinc-800)` etc. instead (see scripts/gen-light-palette.mjs).
const sources = import.meta.glob(
  [
    "/src/**/*.{ts,tsx}",
    "!/src/**/*.test.{ts,tsx}",
    "!/src/lib/api/generated/**",
  ],
  { query: "?raw", import: "default", eager: true },
) as Record<string, string>;

const NEUTRAL_HEX =
  /#(?:fafafa|f4f4f5|e4e4e7|d4d4d8|a1a1aa|71717a|52525b|3f3f46|27272a|18181b|09090b)\b/gi;

/** Files where a neutral grey is *data*, not chrome: a fallback swatch for an
 *  unknown faction/militia, often concatenated with an alpha suffix
 *  (`${hex}26`), which `var()` cannot express. */
const DATA_FALLBACKS = new Set([
  "/src/modules/faction-warfare/FactionWarfarePage.tsx",
  "/src/modules/faction-warfare/SystemTable.tsx",
  "/src/modules/faction-warfare/Warzone.tsx",
  "/src/modules/localintel/PilotTable.tsx",
  "/src/modules/localintel/Summary.tsx",
  "/src/modules/pvp/PvpPage.tsx",
]);

describe("no hard-coded neutral colours outside data palettes", () => {
  it("chart/chrome code uses palette variables so it follows the theme", () => {
    const offenders: string[] = [];
    for (const [file, text] of Object.entries(sources)) {
      if (DATA_FALLBACKS.has(file)) continue;
      const hits = text.match(NEUTRAL_HEX);
      if (hits) offenders.push(`${file}: ${[...new Set(hits)].join(", ")}`);
    }
    expect(offenders).toEqual([]);
  });
});
