import { describe, expect, it } from "vitest";
import {
  DEFAULT_FIGHT_RECORDING,
  migrateRecordingSettings,
} from "./recordingContext";

describe("migrateRecordingSettings", () => {
  it("maps the legacy flat shape onto provider blocks", () => {
    expect(
      migrateRecordingSettings({
        enabled: true,
        startCommand: "start.sh {start}",
        endCommand: "",
        postRollSecs: 30,
        obsEnabled: true,
        obsUrl: "ws://test:4455",
        obsPassword: "pw",
      }),
    ).toEqual({
      enabled: true,
      postRollSecs: 30,
      character: "",
      obs: { enabled: true, url: "ws://test:4455", password: "pw" },
      // Old builds had no hooks switch — a configured command meant active.
      hooks: {
        enabled: true,
        startCommand: "start.sh {start}",
        endCommand: "",
      },
    });
  });

  it("legacy settings without commands leave the hooks provider off", () => {
    const migrated = migrateRecordingSettings({
      enabled: true,
      startCommand: "",
      endCommand: "  ",
      postRollSecs: 10,
    });
    expect(migrated.hooks.enabled).toBe(false);
    expect(migrated.obs).toEqual(DEFAULT_FIGHT_RECORDING.obs);
  });

  it("fills missing per-provider fields of the current shape with defaults", () => {
    const migrated = migrateRecordingSettings({
      enabled: true,
      obs: { enabled: true },
    });
    expect(migrated.obs).toEqual({
      enabled: true,
      url: DEFAULT_FIGHT_RECORDING.obs.url,
      password: "",
    });
    expect(migrated.hooks).toEqual(DEFAULT_FIGHT_RECORDING.hooks);
    expect(migrated.postRollSecs).toBe(DEFAULT_FIGHT_RECORDING.postRollSecs);
  });

  it("falls back to defaults for junk", () => {
    expect(migrateRecordingSettings(null)).toEqual(DEFAULT_FIGHT_RECORDING);
    expect(migrateRecordingSettings("nope")).toEqual(DEFAULT_FIGHT_RECORDING);
  });
});
