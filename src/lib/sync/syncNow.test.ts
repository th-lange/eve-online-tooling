import { describe, expect, it, beforeEach, vi } from "vitest";
import { invokeMock, mockInvoke } from "../../test/harness";
import { STORAGE_KEYS } from "../storageKeys";
import { queryClient } from "../queryClient";
import { piKeys } from "../queryKeys";
import { getMeta, setMeta } from "./manifest";
import { syncNow } from "./syncNow";

beforeEach(() => {
  localStorage.clear();
  invokeMock.mockReset();
});

function envelope(
  module: string,
  schema: number,
  updatedAt: number,
  data: unknown,
): string {
  return JSON.stringify({ module, schema, updatedAt, data });
}

describe("syncNow", () => {
  it("exports a module whose local manifest is newer than its remote file", async () => {
    localStorage.setItem(
      STORAGE_KEYS.reminders,
      JSON.stringify([{ id: "r1" }]),
    );
    setMeta("reminders", 5000);
    const written: Record<string, string> = {};
    mockInvoke({
      sync_folder_read: () => [],
      sync_folder_write: (args) => {
        const { name, content } = args as { name: string; content: string };
        written[name] = content;
        return undefined;
      },
      pi_planner_setups_export: () => "[]",
    });

    const result = await syncNow("/tmp/sync");

    expect(result.exported).toContain("reminders");
    expect(JSON.parse(written["reminders.json"])).toEqual({
      module: "reminders",
      schema: 1,
      updatedAt: 5000,
      data: [{ id: "r1" }],
    });
  });

  it("imports a module whose remote file is newer, applying it and live-refreshing localStorage", async () => {
    localStorage.setItem(STORAGE_KEYS.reminders, JSON.stringify([]));
    setMeta("reminders", 1000);
    mockInvoke({
      sync_folder_read: () => [
        {
          name: "reminders.json",
          content: envelope("reminders", 1, 9000, [{ id: "remote" }]),
        },
      ],
      sync_folder_write: () => undefined,
      pi_planner_setups_export: () => "[]",
      pi_planner_setups_import: () => undefined,
    });

    const result = await syncNow("/tmp/sync");

    expect(result.imported).toContain("reminders");
    expect(JSON.parse(localStorage.getItem(STORAGE_KEYS.reminders)!)).toEqual([
      { id: "remote" },
    ]);
    expect(getMeta("reminders")).toBe(9000);
  });

  it("imports PI setups and invalidates the PI setups query", async () => {
    setMeta("reminders", 99_999); // reminders stays local-newer → export, not relevant here
    mockInvoke({
      sync_folder_read: () => [
        {
          name: "pi.json",
          content: envelope("pi", 1, 5000, [{ id: "setup1" }]),
        },
      ],
      sync_folder_write: () => undefined,
      pi_planner_setups_export: () => "[]",
      pi_planner_setups_import: () => undefined,
    });
    const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");

    const result = await syncNow("/tmp/sync");

    expect(result.imported).toContain("pi");
    expect(invokeMock).toHaveBeenCalledWith("pi_planner_setups_import", {
      content: JSON.stringify([{ id: "setup1" }]),
    });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: piKeys.setups });
    invalidateSpy.mockRestore();
  });

  it("leaves a module unchanged when the local manifest matches the remote timestamp", async () => {
    setMeta("reminders", 5000);
    localStorage.setItem(STORAGE_KEYS.reminders, JSON.stringify([]));
    setMeta("pi", 5000);
    mockInvoke({
      sync_folder_read: () => [
        { name: "reminders.json", content: envelope("reminders", 1, 5000, []) },
        { name: "pi.json", content: envelope("pi", 1, 5000, []) },
      ],
    });

    const result = await syncNow("/tmp/sync");

    expect(result.unchanged).toEqual(["reminders", "pi"]);
    expect(result.imported).toEqual([]);
    expect(result.exported).toEqual([]);
  });

  it("ignores a remote file written by an incompatible schema version", async () => {
    setMeta("reminders", 1000);
    localStorage.setItem(STORAGE_KEYS.reminders, JSON.stringify([]));
    mockInvoke({
      sync_folder_read: () => [
        {
          name: "reminders.json",
          content: envelope("reminders", 99, 9000, [{ id: "future-shape" }]),
        },
      ],
      sync_folder_write: () => undefined,
      pi_planner_setups_export: () => "[]",
    });

    const result = await syncNow("/tmp/sync");

    // Schema mismatch → treated as "no remote file": local (1000) beats the
    // absent remote (-1) and exports instead of importing the unknown shape.
    expect(result.exported).toContain("reminders");
    expect(result.imported).not.toContain("reminders");
  });
});
