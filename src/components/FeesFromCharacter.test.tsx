import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

import { FeesFromCharacter } from "./FeesFromCharacter";

function renderControl() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <FeesFromCharacter onApply={() => {}} />
    </QueryClientProvider>,
  );
}

describe("FeesFromCharacter auth-required state", () => {
  it("shows the login prompt (not the raw error) when character_trade_fees rejects with authRequired", async () => {
    invokeMock.mockImplementation((cmd: string) => {
      if (cmd === "character_trade_fees") {
        // Same wire shape as src-tauri/src/model/mod.rs
        // error_tests::auth_required_serializes_with_a_kind_tag.
        return Promise.reject(
          JSON.parse(
            '{"kind":"authRequired","message":"Log in a character first"}',
          ),
        );
      }
      return Promise.resolve(undefined);
    });
    renderControl();

    const button = screen.getByRole("button", { name: /from character/i });
    await waitFor(() =>
      expect(button).toHaveAttribute(
        "title",
        "Log in a character to auto-fill fees from skills + standings",
      ),
    );
    expect(button).toBeDisabled();
  });
});
