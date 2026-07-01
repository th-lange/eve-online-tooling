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
  dpsPlayback,
  dpsStart,
  dpsStop,
  fittingImportEft,
  fittingPrice,
  fittingShipLayout,
  onDpsTick,
  piLockedSet,
  piOverview,
  ping,
  routeNearestWormhole,
  whImportEvescout,
  whJumpPlan,
  whSystemReference,
  whTripwireConnect,
  whTripwireImport,
  whTypeReference,
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

describe("api.wormholes", () => {
  beforeEach(() => invokeMock.mockReset());

  it("invokes wh_import_evescout and returns the merged connections", async () => {
    invokeMock.mockResolvedValue([{ id: 1, source: "evescout" }]);
    await expect(whImportEvescout()).resolves.toEqual([{ id: 1, source: "evescout" }]);
    expect(invokeMock).toHaveBeenCalledWith("wh_import_evescout");
  });

  it("invokes route_nearest_wormhole", async () => {
    invokeMock.mockResolvedValue({ found: true, jumps: 3, entranceName: "Rancer" });
    const r = await routeNearestWormhole();
    expect(r.jumps).toBe(3);
    expect(invokeMock).toHaveBeenCalledWith("route_nearest_wormhole");
  });

  it("forwards ship + wh code + mass status to wh_jump_plan", async () => {
    invokeMock.mockResolvedValue({ found: true, passes: true, remainingCrossings: 12 });
    await whJumpPlan(17738, "N766", "reduced");
    expect(invokeMock).toHaveBeenCalledWith("wh_jump_plan", {
      shipTypeId: 17738,
      whTypeCode: "N766",
      massStatus: "reduced",
    });
  });

  it("invokes wh_type_reference and wh_system_reference", async () => {
    invokeMock.mockResolvedValue([{ code: "N766" }]);
    await whTypeReference();
    expect(invokeMock).toHaveBeenCalledWith("wh_type_reference");

    invokeMock.mockResolvedValue({ found: true, systemId: 31000005, statics: [] });
    await whSystemReference(31000005);
    expect(invokeMock).toHaveBeenCalledWith("wh_system_reference", { systemId: 31000005 });
  });

  it("forwards Tripwire connect args and imports", async () => {
    invokeMock.mockResolvedValue({ configured: true, baseUrl: "https://tripwire.eve-apps.com", username: "u", mask: null });
    await whTripwireConnect("https://tripwire.eve-apps.com", "u", "pw", null);
    expect(invokeMock).toHaveBeenCalledWith("wh_tripwire_connect", {
      baseUrl: "https://tripwire.eve-apps.com",
      username: "u",
      password: "pw",
      mask: null,
    });

    invokeMock.mockResolvedValue([{ id: 1, source: "tripwire" }]);
    await whTripwireImport();
    expect(invokeMock).toHaveBeenCalledWith("wh_tripwire_import");
  });
});

describe("api.pi", () => {
  beforeEach(() => invokeMock.mockReset());

  it("invokes pi_overview and pi_locked_set", async () => {
    invokeMock.mockResolvedValue([{ planetId: 1, extractors: [], balance: [] }]);
    await piOverview();
    expect(invokeMock).toHaveBeenCalledWith("pi_overview");

    invokeMock.mockResolvedValue(undefined);
    await piLockedSet([2389, 2390]);
    expect(invokeMock).toHaveBeenCalledWith("pi_locked_set", { typeIds: [2389, 2390] });
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

    await dpsPlayback({ file: "/logs/a.txt", speed: 4, windowSecs: 10 });
    expect(invokeMock).toHaveBeenCalledWith("dps_playback", {
      settings: { file: "/logs/a.txt", speed: 4, windowSecs: 10 },
    });

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
