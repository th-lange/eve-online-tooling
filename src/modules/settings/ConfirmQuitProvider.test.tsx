import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, render, screen } from "@testing-library/react";

// Capture the registered close-request handler + spy on destroy() so a test
// can drive onCloseRequested without a real Tauri window.
let closeHandler: ((event: { preventDefault: () => void }) => void) | undefined;
const destroyMock = vi.fn();
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: (cb: (event: { preventDefault: () => void }) => void) => {
      closeHandler = cb;
      return Promise.resolve(() => {});
    },
    destroy: destroyMock,
  }),
}));

import { ConfirmQuitProvider } from "./ConfirmQuitProvider";

function fireClose() {
  const event = { preventDefault: vi.fn() };
  act(() => closeHandler!(event));
  return event;
}

beforeEach(() => {
  closeHandler = undefined;
  destroyMock.mockReset();
  localStorage.clear();
});

describe("ConfirmQuitProvider — double-close to quit", () => {
  it("first close press shows the prompt, a second press quits", async () => {
    render(
      <ConfirmQuitProvider>
        <div>app</div>
      </ConfirmQuitProvider>,
    );
    await vi.waitFor(() => expect(closeHandler).toBeDefined());

    // First press: prompt appears, nothing quits yet.
    const first = fireClose();
    expect(first.preventDefault).toHaveBeenCalled();
    expect(
      screen.getByRole("alertdialog", { name: "Confirm quit" }),
    ).toBeInTheDocument();
    expect(destroyMock).not.toHaveBeenCalled();

    // Second press while the prompt is up: treated as confirmation → quit.
    const second = fireClose();
    expect(second.preventDefault).toHaveBeenCalled();
    expect(destroyMock).toHaveBeenCalledTimes(1);
  });

  it("does not intercept the close when the setting is off", async () => {
    localStorage.setItem("settings.confirmBeforeQuit", JSON.stringify(false));
    render(
      <ConfirmQuitProvider>
        <div>app</div>
      </ConfirmQuitProvider>,
    );
    await vi.waitFor(() => expect(closeHandler).toBeDefined());

    const event = fireClose();
    // Setting off → handler returns early: no preventDefault, no prompt, the
    // OS close proceeds normally.
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
    expect(destroyMock).not.toHaveBeenCalled();
  });
});
