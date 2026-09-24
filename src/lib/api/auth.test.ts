import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Tauri core invoke so the wrapper can be exercised without a
// running desktop shell — same pattern as src/lib/api.test.ts.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  activeCharacter,
  authCharacters,
  authLogin,
  authLogout,
  characterShip,
  openInfoWindow,
  openMarketWindow,
  ownedBlueprints,
  rosterStock,
  setActiveCharacter,
  setWaypoint,
  type Character,
} from "./auth";

describe("auth api wrapper", () => {
  beforeEach(() => invokeMock.mockReset());

  it("invokes auth_login with no args and returns the logged-in character", async () => {
    const character: Character = {
      characterId: 123,
      name: "Test Pilot",
      scopes: ["esi-location.read_ship_type.v1"],
    };
    invokeMock.mockResolvedValue(character);
    await expect(authLogin()).resolves.toEqual(character);
    expect(invokeMock).toHaveBeenCalledWith("auth_login");
  });

  it("invokes auth_characters with no args", async () => {
    invokeMock.mockResolvedValue([]);
    await authCharacters();
    expect(invokeMock).toHaveBeenCalledWith("auth_characters");
  });

  it("forwards characterId to auth_logout as a named param", async () => {
    invokeMock.mockResolvedValue([]);
    await authLogout(456);
    expect(invokeMock).toHaveBeenCalledWith("auth_logout", {
      characterId: 456,
    });
  });

  it("forwards characterId to auth_set_active_character", async () => {
    invokeMock.mockResolvedValue(undefined);
    await setActiveCharacter(789);
    expect(invokeMock).toHaveBeenCalledWith("auth_set_active_character", {
      characterId: 789,
    });
  });

  it("invokes auth_active_character with no args", async () => {
    invokeMock.mockResolvedValue(789);
    await expect(activeCharacter()).resolves.toBe(789);
    expect(invokeMock).toHaveBeenCalledWith("auth_active_character");
  });

  it("invokes esi_character_ship with no args", async () => {
    invokeMock.mockResolvedValue(null);
    await characterShip();
    expect(invokeMock).toHaveBeenCalledWith("esi_character_ship");
  });

  it("invokes esi_owned_blueprints with no args", async () => {
    invokeMock.mockResolvedValue([]);
    await ownedBlueprints();
    expect(invokeMock).toHaveBeenCalledWith("esi_owned_blueprints");
  });

  it("forwards typeId to esi_open_market_window", async () => {
    invokeMock.mockResolvedValue(undefined);
    await openMarketWindow(34);
    expect(invokeMock).toHaveBeenCalledWith("esi_open_market_window", {
      typeId: 34,
    });
  });

  it("forwards targetId to esi_open_info_window", async () => {
    invokeMock.mockResolvedValue(undefined);
    await openInfoWindow(98000001);
    expect(invokeMock).toHaveBeenCalledWith("esi_open_info_window", {
      targetId: 98000001,
    });
  });

  it("forwards systemId to esi_set_waypoint", async () => {
    invokeMock.mockResolvedValue(undefined);
    await setWaypoint(30000142);
    expect(invokeMock).toHaveBeenCalledWith("esi_set_waypoint", {
      systemId: 30000142,
    });
  });

  it("invokes esi_roster_stock with no args", async () => {
    invokeMock.mockResolvedValue({ "34": 100 });
    await expect(rosterStock()).resolves.toEqual({ "34": 100 });
    expect(invokeMock).toHaveBeenCalledWith("esi_roster_stock");
  });
});

// A separate describe block (no `beforeEach` hook) — vitest's unhandled-
// rejection detector spuriously flags a rejected mock awaited inside a
// describe block whose `beforeEach` touches the same mock, even after this
// test's own explicit reset.
describe("auth api wrapper — rejection", () => {
  it("surfaces a rejected invoke through the wrapper unchanged", async () => {
    invokeMock.mockReset();
    const err = { kind: "authRequired", message: "Log in a character first" };
    invokeMock.mockRejectedValue(err);
    let caught: unknown;
    try {
      await authCharacters();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(err);
  });
});
