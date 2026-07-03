#!/usr/bin/env node
// Generate the bundled wormhole-system statics snapshot (#305).
//
// MANUAL, PRE-TAG STEP — this is never run by the app or release build. The app
// only `include_bytes!`s the committed output, so a broken/blocked fetch here can
// never break a build. Re-run it (and review the diff) before tagging a release
// when you want fresher statics. See src-tauri/src/modules/wormholes/data/README.md.
//
// Source: exodus4d/Pathfinder `export/csv/system_static.csv` — MIT licensed
// (redistribution OK with attribution; see the data/README.md NOTICE). It maps
// each J-system id to the wormhole *type ids* it always spawns. Those type ids
// are resolved to codes + physics at runtime from the bundled SDE (#304), so this
// file stays tiny and SDE-version-independent.
//
// Output (gzipped) → src-tauri/src/modules/wormholes/data/wh_systems.json.gz
//   { "31002604": { "statics": [34140, 34136] }, ... }
//
// Usage:  node scripts/gen-wh-systems.mjs [sourceCsvUrl]

import { gzipSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const DEFAULT_SOURCE =
  "https://raw.githubusercontent.com/exodus4d/pathfinder/master/export/csv/system_static.csv";
const SOURCE = process.argv[2] ?? DEFAULT_SOURCE;

const OUT = join(
  dirname(fileURLToPath(import.meta.url)),
  "..",
  "src-tauri",
  "src",
  "modules",
  "wormholes",
  "data",
  "wh_systems.json.gz",
);

/** Parse Pathfinder's `id;systemId;typeId` CSV into system id → sorted type ids. */
function parseStatics(csv) {
  const lines = csv.trim().split(/\r?\n/);
  const header = lines.shift()?.toLowerCase() ?? "";
  const cols = header.split(";");
  const sysIdx = cols.indexOf("systemid");
  const typeIdx = cols.indexOf("typeid");
  if (sysIdx < 0 || typeIdx < 0) {
    throw new Error(
      `unexpected header "${header}" — expected systemId + typeId columns`,
    );
  }
  const bySystem = new Map();
  for (const line of lines) {
    const f = line.split(";");
    const systemId = Number(f[sysIdx]);
    const typeId = Number(f[typeIdx]);
    if (!Number.isFinite(systemId) || !Number.isFinite(typeId)) continue;
    const set = bySystem.get(systemId) ?? new Set();
    set.add(typeId);
    bySystem.set(systemId, set);
  }
  const out = {};
  for (const [systemId, types] of [...bySystem].sort((a, b) => a[0] - b[0])) {
    out[String(systemId)] = { statics: [...types].sort((a, b) => a - b) };
  }
  return out;
}

async function main() {
  console.error(`Fetching ${SOURCE} …`);
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
  const csv = await res.text();

  const out = parseStatics(csv);
  const systems = Object.keys(out).length;
  const statics = Object.values(out).reduce((n, s) => n + s.statics.length, 0);
  if (systems === 0)
    throw new Error("parsed 0 systems — check the source schema");

  writeFileSync(OUT, gzipSync(Buffer.from(JSON.stringify(out)), { level: 9 }));
  console.error(`Wrote ${systems} systems / ${statics} statics → ${OUT}`);
  console.error(`Source: ${SOURCE}`);
  console.error(
    `Pulled: ${new Date().toISOString().slice(0, 10)} — update data/README.md provenance.`,
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
