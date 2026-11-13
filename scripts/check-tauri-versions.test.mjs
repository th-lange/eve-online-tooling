import { describe, expect, it } from "vitest";
import {
  findMismatches,
  npmCounterpart,
  parseCargoLock,
  parseNpmLock,
} from "./check-tauri-versions.mjs";

const cargoLock = (pkgs) =>
  pkgs
    .map(([n, v]) => `[[package]]\nname = "${n}"\nversion = "${v}"\n`)
    .join("\n");

const npmLock = (pkgs) => ({
  packages: {
    "": { name: "app" },
    ...Object.fromEntries(
      pkgs.map(([n, v]) => [`node_modules/${n}`, { version: v }]),
    ),
  },
});

describe("check-tauri-versions", () => {
  it("maps crates to their npm twin", () => {
    expect(npmCounterpart("tauri")).toBe("@tauri-apps/api");
    expect(npmCounterpart("tauri-plugin-opener")).toBe(
      "@tauri-apps/plugin-opener",
    );
    expect(npmCounterpart("tauri-build")).toBeNull();
    expect(npmCounterpart("tauri-plugin")).toBeNull();
  });

  it("accepts matching major.minor with differing patch", () => {
    const crates = parseCargoLock(
      cargoLock([
        ["tauri", "2.11.3"],
        ["tauri-plugin-opener", "2.5.4"],
      ]),
    );
    const npm = parseNpmLock(
      npmLock([
        ["@tauri-apps/api", "2.11.1"],
        ["@tauri-apps/plugin-opener", "2.5.0"],
      ]),
    );
    expect(findMismatches(crates, npm)).toEqual([]);
  });

  it("reports the v0.79.0 skew (tauri 2.11 vs api 2.12)", () => {
    const crates = parseCargoLock(cargoLock([["tauri", "2.11.3"]]));
    const npm = parseNpmLock(npmLock([["@tauri-apps/api", "2.12.4"]]));
    const problems = findMismatches(crates, npm);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("tauri 2.11.3");
    expect(problems[0]).toContain("@tauri-apps/api 2.12.4");
  });

  it("reports plugin skew and ignores crates without an npm package", () => {
    const crates = parseCargoLock(
      cargoLock([
        ["tauri", "2.11.3"],
        ["tauri-plugin-dialog", "2.7.3"],
        ["tauri-plugin-fs", "2.5.2"],
      ]),
    );
    const npm = parseNpmLock(
      npmLock([
        ["@tauri-apps/api", "2.11.1"],
        ["@tauri-apps/plugin-dialog", "2.8.0"],
      ]),
    );
    const problems = findMismatches(crates, npm);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain("tauri-plugin-dialog");
  });

  it("fails loudly when a lockfile lacks the core packages", () => {
    expect(findMismatches(new Map(), new Map())).not.toEqual([]);
  });
});
