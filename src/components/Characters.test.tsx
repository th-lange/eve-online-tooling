import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, screen, waitFor } from "@testing-library/react";
import { mockInvoke, renderWithQuery } from "../test/harness";

// Capture the `auth://persist-failed` handler so a test can fire the event the
// backend emits when the failure set changes.
let persistFailedHandler: (() => void) | undefined;
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((_event: string, cb: () => void) => {
    persistFailedHandler = cb;
    return Promise.resolve(() => {});
  }),
}));

import { Characters } from "./Characters";

const ROSTER = [
  { characterId: 1, name: "Alice", scopes: [] },
  { characterId: 2, name: "Bob", scopes: [] },
];

beforeEach(() => {
  persistFailedHandler = undefined;
});

describe("Characters — unsaved-login warning (#1036)", () => {
  it("warns which characters' rotated login couldn't be saved, and clears when the backend says so", async () => {
    let failures: number[] = [2];
    mockInvoke({
      auth_characters: () => ROSTER,
      auth_active_character: () => 1,
      auth_persist_failures: () => failures,
    });
    renderWithQuery(<Characters />);

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Couldn't save the login for Bob");
    expect(alert).not.toHaveTextContent("Alice");

    // The keychain recovered (or the character re-logged in): the backend
    // fires the event and the next read returns an empty set.
    failures = [];
    await waitFor(() => expect(persistFailedHandler).toBeDefined());
    act(() => persistFailedHandler!());
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
  });

  it("shows no warning when nothing failed to persist", async () => {
    mockInvoke({
      auth_characters: () => ROSTER,
      auth_active_character: () => 1,
      auth_persist_failures: () => [],
    });
    renderWithQuery(<Characters />);

    await screen.findByLabelText("Active character");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
});
