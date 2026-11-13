import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { mockInvoke, renderWithQuery } from "../test/harness";

// Capture the backend event handlers so a test can fire the events it emits:
// `auth://persist-failed` (failure set changed) and `auth://login-url`.
const handlers: Record<string, (e: { payload: unknown }) => void> = {};
let persistFailedHandler: (() => void) | undefined;
vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn((event: string, cb: (e: { payload: unknown }) => void) => {
    handlers[event] = cb;
    if (event === "auth://persist-failed") {
      persistFailedHandler = () => cb({ payload: undefined });
    }
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

describe("Characters — cancellable SSO login (#1143)", () => {
  it("offers the login link and Cancel while waiting, and Cancel frees the button", async () => {
    let finishLogin!: (e: unknown) => void;
    mockInvoke({
      auth_characters: () => ROSTER,
      auth_active_character: () => 1,
      auth_persist_failures: () => [],
      auth_login: () => new Promise((_, reject) => (finishLogin = reject)),
      auth_login_cancel: () => {
        finishLogin({ kind: "message", message: "login cancelled" });
      },
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText },
      configurable: true,
    });
    renderWithQuery(<Characters />);

    fireEvent.click(await screen.findByText("+ Add character"));
    expect(await screen.findByText("Waiting for login…")).toBeDisabled();

    await waitFor(() => expect(handlers["auth://login-url"]).toBeDefined());
    act(() =>
      handlers["auth://login-url"]({
        payload: "https://sso.example/authorize",
      }),
    );
    fireEvent.click(await screen.findByText("Copy login link"));
    expect(writeText).toHaveBeenCalledWith("https://sso.example/authorize");

    fireEvent.click(screen.getByText("Cancel"));
    expect(await screen.findByText("+ Add character")).toBeEnabled();
    // A cancelled login is not a failure.
    expect(screen.queryByText(/Login failed/)).not.toBeInTheDocument();
  });
});
