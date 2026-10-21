import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { invokeMock, mockInvoke } from "../../test/harness";
import { FwHomeDefenseProvider } from "./FwHomeDefenseProvider";
import type { FwSystemNode } from "../../lib/api";
import { intelKeys } from "../../lib/queryKeys";

const sendNotificationMock = vi.fn();
vi.mock("@tauri-apps/plugin-notification", () => ({
  isPermissionGranted: () => Promise.resolve(true),
  requestPermission: () => Promise.resolve("granted"),
  sendNotification: (...args: unknown[]) => sendNotificationMock(...args),
}));

type KillPayload = {
  killmailId: number;
  solarSystemId: number;
  timeSecs: number;
  victimFactionId: number | null;
  attackerFactionIds: number[];
};
let killHandler: ((payload: KillPayload) => void) | undefined;
vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: (e: { payload: unknown }) => void) => {
    if (name === "zkill://kill") {
      killHandler = (payload) => handler({ payload });
    }
    return Promise.resolve(() => {
      killHandler = undefined;
    });
  },
}));

function fireKill(overrides: Partial<KillPayload>) {
  killHandler?.({
    killmailId: 1,
    solarSystemId: 1,
    timeSecs: Math.floor(Date.now() / 1000),
    victimFactionId: null,
    attackerFactionIds: [],
    ...overrides,
  });
}

function node(
  id: number,
  contested: string,
  occupierId = 500003,
): FwSystemNode {
  return {
    systemId: id,
    name: `Sys${id}`,
    region: "Devoid",
    warzone: "Amarr–Minmatar",
    security: 0.3,
    owner: "Amarr",
    occupier: "Amarr",
    ownerId: occupierId,
    occupierId,
    contested,
    vpPct: 0.5,
    kills: 0,
    npcKills: 0,
    jumps: 0,
    battlefield: "frontline",
    vpVelocity: null,
    vpDelta30m: null,
    x: 0,
    z: 0,
  };
}

let qc: QueryClient;
function renderProvider() {
  qc = new QueryClient();
  return render(
    <QueryClientProvider client={qc}>
      <FwHomeDefenseProvider>
        <div>child</div>
      </FwHomeDefenseProvider>
    </QueryClientProvider>,
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  invokeMock.mockReset();
  sendNotificationMock.mockClear();
  localStorage.clear();
  killHandler = undefined;
});

describe("FwHomeDefenseProvider", () => {
  it("notifies on a friendly system's contested -> vulnerable transition, but not again on the next identical poll", async () => {
    let systems = [node(1, "contested", 500003)];
    mockInvoke({
      auth_characters: () => [{ characterId: 1, name: "Bob", scopes: [] }],
      intel_fw_enlistment: () => 500003,
      intel_fw_systems: () => ({ nodes: systems, edges: [] }),
      intel_fw_jumps: () => ({ characterSystemId: 1, jumps: {} }),
    });
    renderProvider();

    // First poll establishes the baseline — no alert yet.
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("intel_fw_systems"),
    );
    expect(sendNotificationMock).not.toHaveBeenCalled();

    // System flips to vulnerable; force a refetch (no interval on this query).
    systems = [node(1, "vulnerable", 500003)];
    await qc.invalidateQueries({ queryKey: intelKeys.fwSystems });
    await waitFor(() =>
      expect(sendNotificationMock).toHaveBeenCalledWith(
        expect.objectContaining({
          title: expect.stringContaining("vulnerable"),
        }),
      ),
    );
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);

    // Same state again on the next poll — no repeat alert.
    await qc.invalidateQueries({ queryKey: intelKeys.fwSystems });
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("intel_fw_systems"),
    );
    expect(sendNotificationMock).toHaveBeenCalledTimes(1);
  });

  it("never queries FW data when both alert rules are disabled", async () => {
    localStorage.setItem("fw.homeDefense.vulnerableAlert", "false");
    localStorage.setItem("fw.homeDefense.nearbyFlipRadius", '"off"');
    mockInvoke({
      auth_characters: () => [{ characterId: 1, name: "Bob", scopes: [] }],
      intel_fw_enlistment: () => 500003,
      intel_fw_systems: () => ({
        nodes: [node(1, "contested", 500003)],
        edges: [],
      }),
      intel_fw_jumps: () => ({ characterSystemId: 1, jumps: {} }),
    });
    renderProvider();

    // Give the effect loop a tick to prove it stays idle, not to catch a race.
    await act(() => delay(50));
    expect(invokeMock).not.toHaveBeenCalledWith("intel_fw_systems");
  });

  it("eagerly refetches FW systems when a live kill lands in a watched system (#926)", async () => {
    mockInvoke({
      auth_characters: () => [{ characterId: 1, name: "Bob", scopes: [] }],
      intel_fw_enlistment: () => 500003,
      intel_fw_systems: () => ({
        nodes: [node(1, "contested", 500003)],
        edges: [],
      }),
      intel_fw_jumps: () => ({ characterSystemId: 1, jumps: {} }),
    });
    renderProvider();
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("intel_fw_systems"),
    );
    const callsBefore = invokeMock.mock.calls.filter(
      (c) => c[0] === "intel_fw_systems",
    ).length;

    await act(async () => {
      fireKill({ solarSystemId: 1 });
      await delay(10);
    });

    await waitFor(() => {
      const callsAfter = invokeMock.mock.calls.filter(
        (c) => c[0] === "intel_fw_systems",
      ).length;
      expect(callsAfter).toBeGreaterThan(callsBefore);
    });
  });

  it("ignores a live kill in a system outside the selected militia's warzone", async () => {
    mockInvoke({
      auth_characters: () => [{ characterId: 1, name: "Bob", scopes: [] }],
      intel_fw_enlistment: () => 500003,
      intel_fw_systems: () => ({
        nodes: [node(1, "contested", 500003)],
        edges: [],
      }),
      intel_fw_jumps: () => ({ characterSystemId: 1, jumps: {} }),
    });
    renderProvider();
    await waitFor(() =>
      expect(invokeMock).toHaveBeenCalledWith("intel_fw_systems"),
    );
    const callsBefore = invokeMock.mock.calls.filter(
      (c) => c[0] === "intel_fw_systems",
    ).length;

    await act(async () => {
      fireKill({ solarSystemId: 999_999 }); // not in the watched warzone
      await delay(50);
    });

    const callsAfter = invokeMock.mock.calls.filter(
      (c) => c[0] === "intel_fw_systems",
    ).length;
    expect(callsAfter).toBe(callsBefore);
  });
});
