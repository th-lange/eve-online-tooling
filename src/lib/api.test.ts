import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the Tauri core invoke so we can exercise the api wrapper without a
// running desktop shell.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  fittingImportEft,
  fittingPrice,
  fittingShipLayout,
  ping,
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
