import { beforeEach, describe, expect, it, vi } from "vitest";

// Mock the Tauri core invoke so the wrapper can be exercised without a
// running desktop shell — same pattern as src/lib/api.test.ts.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import {
  productionDecryptors,
  productionProfit,
  productionSystemCostIndex,
  type ProfitParams,
} from "./production";

describe("production api wrapper", () => {
  beforeEach(() => invokeMock.mockReset());

  it("forwards the whole params object to production_profit under a params key", async () => {
    invokeMock.mockResolvedValue([]);
    const params: ProfitParams = { regionId: 10000002, runs: 10, me: 10 };
    await productionProfit(params);
    expect(invokeMock).toHaveBeenCalledWith("production_profit", { params });
  });

  it("invokes production_decryptors with no args", async () => {
    invokeMock.mockResolvedValue([]);
    await productionDecryptors();
    expect(invokeMock).toHaveBeenCalledWith("production_decryptors");
  });

  it("forwards systemId to production_system_cost_index", async () => {
    invokeMock.mockResolvedValue(0.05);
    await expect(productionSystemCostIndex(30000142)).resolves.toBe(0.05);
    expect(invokeMock).toHaveBeenCalledWith("production_system_cost_index", {
      systemId: 30000142,
    });
  });

  it("resolves null when the system has no cost index", async () => {
    invokeMock.mockResolvedValue(null);
    await expect(productionSystemCostIndex(31000005)).resolves.toBeNull();
  });
});

// A separate describe block (no `beforeEach` hook) — vitest's unhandled-
// rejection detector spuriously flags a rejected mock awaited inside a
// describe block whose `beforeEach` touches the same mock, even after this
// test's own explicit reset.
describe("production api wrapper — rejection", () => {
  it("surfaces a rejected invoke through the wrapper unchanged", async () => {
    invokeMock.mockReset();
    const err = { kind: "message", message: "unknown blueprint" };
    invokeMock.mockRejectedValue(err);
    let caught: unknown;
    try {
      await productionDecryptors();
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(err);
  });
});
