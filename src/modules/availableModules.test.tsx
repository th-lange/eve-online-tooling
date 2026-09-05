import { describe, expect, it, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useAvailableModules } from "./availableModules";
import { modules } from "./registry";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

function mockRoster(characters: { characterId: number; name: string }[]) {
  invokeMock.mockImplementation((cmd: string) => {
    switch (cmd) {
      case "auth_characters":
        return Promise.resolve(characters);
      case "plugins_list":
        return Promise.resolve([]);
      default:
        return Promise.reject(new Error(`unexpected command ${cmd}`));
    }
  });
}

function render() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(() => useAvailableModules(), { wrapper });
}

beforeEach(() => {
  invokeMock.mockReset();
});

describe("useAvailableModules", () => {
  it("leaves out character-gated modules while the roster is empty", async () => {
    mockRoster([]);
    const { result } = render();
    await waitFor(() =>
      expect(result.current.map((m) => m.id)).toContain("production"),
    );
    expect(result.current.map((m) => m.id)).not.toContain("feedback");
  });

  it("offers them once a character is logged in", async () => {
    mockRoster([{ characterId: 1, name: "Some Capsuleer" }]);
    const { result } = render();
    await waitFor(() =>
      expect(result.current.map((m) => m.id)).toContain("feedback"),
    );
  });

  it("never hides an ungated module", async () => {
    mockRoster([]);
    const { result } = render();
    await waitFor(() => expect(result.current.length).toBeGreaterThan(0));
    const ungated = modules
      .filter((m) => !m.requiresCharacter)
      .map((m) => m.id);
    expect(result.current.map((m) => m.id)).toEqual(
      expect.arrayContaining(ungated),
    );
  });
});
