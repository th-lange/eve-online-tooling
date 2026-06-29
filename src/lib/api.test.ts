import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the Tauri core invoke so we can exercise the api wrapper without a
// running desktop shell.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

// Mock the event channel so we can assert subscriptions without a shell.
const listenMock = vi.fn();
vi.mock("@tauri-apps/api/event", () => ({
  listen: (...args: unknown[]) => listenMock(...args),
}));

import {
  dpsListLogs,
  dpsStart,
  dpsStop,
  fittingImportEft,
  fittingPrice,
  fittingShipLayout,
  onDpsTick,
  ping,
  type DpsTick,
  type Fit,
} from "./api";

describe("api.ping", () => {
  beforeEach(() => invokeMock.mockReset());

  it("invokes the 'ping' command and returns its result", async () => {
    invokeMock.mockResolvedValue("pong");
    await expect(ping()).resolves.toBe("pong");
    expect(invokeMock).toHaveBeenCalledWith("ping");
  });
});

describe("api.fitting", () => {
  beforeEach(() => invokeMock.mockReset());

  it("maps shipTypeId to the command's typeId arg", async () => {
    invokeMock.mockResolvedValue(null);
    await fittingShipLayout(587);
    expect(invokeMock).toHaveBeenCalledWith("fitting_ship_layout", {
      typeId: 587,
    });
  });

  it("passes EFT text through to fitting_import_eft", async () => {
    invokeMock.mockResolvedValue({ id: "", name: "x", shipTypeId: 1, items: [] });
    await fittingImportEft("[Rifter, x]");
    expect(invokeMock).toHaveBeenCalledWith("fitting_import_eft", {
      text: "[Rifter, x]",
    });
  });

  it("forwards fit + region + station to fitting_price", async () => {
    invokeMock.mockResolvedValue({ buyTotal: 0, sellTotal: 0, lines: [] });
    const fit: Fit = { id: "a", name: "n", shipTypeId: 587, items: [] };
    await fittingPrice(fit, 10000002, null);
    expect(invokeMock).toHaveBeenCalledWith("fitting_price", {
      fit,
      regionId: 10000002,
      stationId: null,
    });
  });
});

describe("api.dpsmeter", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    listenMock.mockReset();
  });

  it("wraps the start/stop/list commands", async () => {
    invokeMock.mockResolvedValue(undefined);
    await dpsStart({ gamelogsDir: "/logs/Gamelogs", windowSecs: 10 });
    expect(invokeMock).toHaveBeenCalledWith("dps_start", {
      settings: { gamelogsDir: "/logs/Gamelogs", windowSecs: 10 },
    });

    await dpsStop();
    expect(invokeMock).toHaveBeenCalledWith("dps_stop");

    invokeMock.mockResolvedValue([]);
    await dpsListLogs("/logs/Gamelogs");
    expect(invokeMock).toHaveBeenCalledWith("dps_list_logs", {
      gamelogsDir: "/logs/Gamelogs",
    });
  });

  it("subscribes onDpsTick to dps://tick and forwards the payload", async () => {
    listenMock.mockResolvedValue(() => {});
    const handler = vi.fn();
    await onDpsTick(handler);
    expect(listenMock).toHaveBeenCalledWith("dps://tick", expect.any(Function));

    // The registered listener should hand the event's payload to our handler.
    const cb = listenMock.mock.calls[0][1] as (e: { payload: DpsTick }) => void;
    const tick = { dpsOut: 123 } as DpsTick;
    cb({ payload: tick });
    expect(handler).toHaveBeenCalledWith(tick);
  });
});
