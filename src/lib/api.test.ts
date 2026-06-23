import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock the Tauri core invoke so we can exercise the api wrapper without a
// running desktop shell.
const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { ping } from "./api";

describe("api.ping", () => {
  beforeEach(() => invokeMock.mockReset());

  it("invokes the 'ping' command and returns its result", async () => {
    invokeMock.mockResolvedValue("pong");
    await expect(ping()).resolves.toBe("pong");
    expect(invokeMock).toHaveBeenCalledWith("ping");
  });
});
