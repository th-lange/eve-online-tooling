import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { ScriptsRunnerProvider } from "./runner";
import { useScriptRuns } from "./runnerContext";
import type { ScriptRun } from "../../lib/api";

// The loop lives in Rust now; the provider only listens for run/sound events.
// Capture the registered listeners by channel so tests can fire events.
const listeners: Record<string, (e: { payload: unknown }) => void> = {};
vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, cb: (e: { payload: unknown }) => void) => {
    listeners[name] = cb;
    return Promise.resolve(() => {});
  },
}));

const RUN_OK: ScriptRun = {
  ok: true,
  result: 42,
  logs: [],
  error: null,
  durationMs: 1,
};

function Probe() {
  const runs = useScriptRuns();
  const r = runs["ticker"];
  return (
    <div data-testid="status">{r ? (r.run.ok ? "ok" : "error") : "none"}</div>
  );
}

beforeEach(() => {
  for (const k of Object.keys(listeners)) delete listeners[k];
});

describe("ScriptsRunnerProvider", () => {
  it("records a scheduled run from the scripts://run event", async () => {
    render(
      <ScriptsRunnerProvider>
        <Probe />
      </ScriptsRunnerProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByTestId("status").textContent).toBe("none");
    expect(listeners["scripts://run"]).toBeTypeOf("function");

    await act(async () => {
      listeners["scripts://run"]({ payload: { id: "ticker", run: RUN_OK } });
    });
    expect(screen.getByTestId("status").textContent).toBe("ok");
  });

  it("subscribes to play-sound requests", async () => {
    render(
      <ScriptsRunnerProvider>
        <Probe />
      </ScriptsRunnerProvider>,
    );
    await act(async () => {
      await Promise.resolve();
    });
    expect(listeners["scripts://play-sound"]).toBeTypeOf("function");
  });
});
