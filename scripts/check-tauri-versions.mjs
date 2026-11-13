// Fails when a Tauri Rust crate and its @tauri-apps npm counterpart resolve to
// different major.minor versions in the lockfiles. `tauri build` aborts with
// "Found version mismatched Tauri packages" on that skew, which until now only
// surfaced at tag time (v0.79.0 took three tag pushes, #1200).
//
//   tauri                  <-> @tauri-apps/api
//   tauri-plugin-<name>    <-> @tauri-apps/plugin-<name>
//
// Crates without an installed npm counterpart (e.g. tauri-plugin-fs, pulled in
// transitively) are not compared. Usage: node scripts/check-tauri-versions.mjs
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Crate name -> versions, from the text of a Cargo.lock. */
export function parseCargoLock(text) {
  const crates = new Map();
  for (const block of text.split("[[package]]").slice(1)) {
    const name = /^name = "([^"]+)"/m.exec(block)?.[1];
    const version = /^version = "([^"]+)"/m.exec(block)?.[1];
    if (!name || !version) continue;
    crates.set(name, [...(crates.get(name) ?? []), version]);
  }
  return crates;
}

/** `@tauri-apps/*` package name -> version, from a parsed package-lock.json. */
export function parseNpmLock(lock) {
  const pkgs = new Map();
  for (const [path, meta] of Object.entries(lock.packages ?? {})) {
    const m = /^node_modules\/(@tauri-apps\/[^/]+)$/.exec(path);
    if (m && meta.version) pkgs.set(m[1], meta.version);
  }
  return pkgs;
}

/** npm package name for a crate, or null when the crate has no npm twin. */
export function npmCounterpart(crate) {
  if (crate === "tauri") return "@tauri-apps/api";
  if (crate.startsWith("tauri-plugin-")) {
    return `@tauri-apps/plugin-${crate.slice("tauri-plugin-".length)}`;
  }
  return null;
}

const majorMinor = (v) => v.split(".").slice(0, 2).join(".");

/** Returns human-readable mismatch descriptions (empty = consistent). */
export function findMismatches(crates, npm) {
  const problems = [];
  let compared = 0;
  for (const [crate, versions] of crates) {
    const pkg = npmCounterpart(crate);
    if (!pkg) continue;
    const npmVersion = npm.get(pkg);
    if (!npmVersion) continue;
    compared++;
    for (const v of versions) {
      if (majorMinor(v) !== majorMinor(npmVersion)) {
        problems.push(
          `${crate} ${v} (Cargo.lock) vs ${pkg} ${npmVersion} (package-lock.json)`,
        );
      }
    }
  }
  if (!crates.has("tauri") || !npm.has("@tauri-apps/api")) {
    problems.push(
      "tauri / @tauri-apps/api missing from a lockfile; cannot compare",
    );
  } else if (compared === 0) {
    problems.push("no Tauri crate/npm pairs compared");
  }
  return problems;
}

function main() {
  const root = new URL("../", import.meta.url);
  const crates = parseCargoLock(
    readFileSync(new URL("src-tauri/Cargo.lock", root), "utf8"),
  );
  const npm = parseNpmLock(
    JSON.parse(readFileSync(new URL("package-lock.json", root), "utf8")),
  );
  const problems = findMismatches(crates, npm);
  if (problems.length > 0) {
    console.error("Tauri npm/crate major.minor skew:");
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log("Tauri npm/crate versions are aligned.");
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
