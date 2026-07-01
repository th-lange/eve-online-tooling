#!/usr/bin/env node
// Generate the bundled wormhole-system reference snapshot (#305).
//
// Source: the community **Anoik.is** dataset — the per-J-system class / effect /
// statics that are NOT in the EVE SDE or ESI. There is no clean documented public
// JSON API, so this normalizes whatever export is configured below into the shape
// the app loads and writes it gzipped to:
//   src-tauri/src/modules/wormholes/data/wh_systems.json.gz
//
// ⚠️ HITL (#305): before committing the full generated file, a human must confirm
// the Anoik.is source URL and that its licensing permits redistribution (bundling
// a snapshot in this repo / shipped app). Record source + license/date below.
//   Source URL : <fill in the confirmed Anoik.is export endpoint>
//   License    : <fill in — e.g. CC-BY, or "permission granted by maintainer">
//   Snapshot   : <date pulled>
//
// ⚠️ Network: every EVE-adjacent host is egress-blocked in the CI/agent sandbox
// (same caveat as src-tauri/src/evescout/mod.rs) — run this on a normal machine.
//
// Usage:  node scripts/gen-wh-systems.mjs [sourceUrl]
// Output shape (map keyed by system name):
//   { "J100744": { "systemId": 31000744, "class": 4, "effect": "Pulsar",
//                  "statics": ["N766","C247"], "wanderers": [] } }

import { gzipSync } from "node:zlib";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

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

// Default source is intentionally unset — pass the confirmed Anoik.is export URL
// as argv[2] once its licensing is cleared (the HITL step above).
const SOURCE = process.argv[2] ?? "";

/** Normalize one raw Anoik.is system record into our committed shape. Tolerant
 * of field-name variations so the exact export schema can be reconciled here
 * rather than in Rust. */
function normalize(raw) {
  const systemId = Number(raw.systemId ?? raw.system_id ?? raw.solarSystemID ?? raw.id);
  const cls = raw.class ?? raw.wormholeClass ?? raw.systemClass ?? null;
  const statics = (raw.statics ?? raw.staticWormholes ?? [])
    .map((s) => (typeof s === "string" ? s : s.code ?? s.type ?? s.name))
    .filter(Boolean);
  return {
    systemId,
    class: cls == null ? null : Number(cls),
    effect: raw.effect ?? raw.systemEffect ?? null,
    statics,
    wanderers: raw.wanderers ?? [],
  };
}

async function main() {
  if (!SOURCE) {
    console.error(
      "No source URL. Pass the confirmed Anoik.is export URL:\n" +
        "  node scripts/gen-wh-systems.mjs <sourceUrl>\n" +
        "(and fill in the provenance/license header first — #305 is HITL).",
    );
    process.exit(1);
  }
  console.error(`Fetching ${SOURCE} …`);
  const res = await fetch(SOURCE);
  if (!res.ok) throw new Error(`fetch failed: ${res.status} ${res.statusText}`);
  const data = await res.json();

  // Accept either a { name: record } map or an array of records.
  const entries = Array.isArray(data)
    ? data.map((r) => [r.name ?? r.system ?? String(r.systemId ?? r.system_id), normalize(r)])
    : Object.entries(data).map(([name, r]) => [name, normalize(r)]);

  const out = {};
  for (const [name, rec] of entries) {
    if (name && Number.isFinite(rec.systemId)) out[name] = rec;
  }
  const count = Object.keys(out).length;
  if (count === 0) throw new Error("normalized 0 systems — check the source schema");

  writeFileSync(OUT, gzipSync(Buffer.from(JSON.stringify(out)), { level: 9 }));
  console.error(`Wrote ${count} systems → ${OUT}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
