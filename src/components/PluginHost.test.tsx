import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MAX_IN_FLIGHT_INVOKES, PluginHost } from "./PluginHost";

const invokeMock = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (...args: unknown[]) => invokeMock(...args),
}));

const CHANNEL = "eve-plugin";

/**
 * Give the plugin iframe a controllable window so the test doesn't depend on
 * jsdom's (unstable) real iframe navigation. Returns the stub, whose
 * `postMessage` is the host's reply channel.
 */
function stubFrameWindow() {
  const frame = screen.getByTitle("plugin-pricing-model") as HTMLIFrameElement;
  const win = { postMessage: vi.fn() } as unknown as Window;
  Object.defineProperty(frame, "contentWindow", {
    configurable: true,
    value: win,
  });
  return win;
}

/** Deliver a message with an explicit `source` window (which the host checks). */
function postFrom(source: unknown, data: unknown) {
  const event = new MessageEvent("message", { data });
  Object.defineProperty(event, "source", { value: source });
  window.dispatchEvent(event);
}
const flush = () => new Promise((r) => setTimeout(r, 20));

describe("PluginHost", () => {
  beforeEach(() => {
    invokeMock.mockReset();
  });

  it("forwards a guest invoke to plugins_invoke and replies with the result", async () => {
    invokeMock.mockResolvedValue({ isk: 42 });
    render(<PluginHost pluginId="pricing-model" />);
    const win = stubFrameWindow();

    postFrom(win, {
      channel: CHANNEL,
      kind: "invoke",
      id: 7,
      fn: "appraise",
      args: { items: ["Tritanium"] },
    });
    await flush();

    expect(invokeMock).toHaveBeenCalledWith("plugins_invoke", {
      pluginId: "pricing-model",
      fn: "appraise",
      args: { items: ["Tritanium"] },
    });
    expect(win.postMessage).toHaveBeenCalledWith(
      {
        channel: CHANNEL,
        kind: "result",
        id: 7,
        ok: true,
        result: { isk: 42 },
      },
      "*",
    );
  });

  it("replies with an error when the plugin call rejects", async () => {
    invokeMock.mockImplementation(() =>
      Promise.reject(new Error("not active")),
    );
    render(<PluginHost pluginId="pricing-model" />);
    const win = stubFrameWindow();

    postFrom(win, { channel: CHANNEL, kind: "invoke", id: 1, fn: "x" });
    await flush();

    expect(win.postMessage).toHaveBeenCalledWith(
      {
        channel: CHANNEL,
        kind: "result",
        id: 1,
        ok: false,
        error: "not active",
      },
      "*",
    );
  });

  it("keeps the message when the command rejects with an AppError object", async () => {
    // `plugins_invoke` rejects with the serialized Rust error, which is a plain
    // object. Stringifying it naively produced "[object Object]" in the guest,
    // hiding real diagnoses like a 403 from the API a plugin fetches.
    invokeMock.mockImplementation(() =>
      Promise.reject({ kind: "Other", message: "Firestore denied the read" }),
    );
    render(<PluginHost pluginId="pricing-model" />);
    const win = stubFrameWindow();

    postFrom(win, {
      channel: CHANNEL,
      kind: "invoke",
      id: 2,
      fn: "fetch_feedback",
    });
    await flush();

    expect(win.postMessage).toHaveBeenCalledWith(
      {
        channel: CHANNEL,
        kind: "result",
        id: 2,
        ok: false,
        error: "Firestore denied the read",
      },
      "*",
    );
  });

  it("rejects invokes above the in-flight cap and frees slots as calls settle", async () => {
    const pending: Array<(v: unknown) => void> = [];
    invokeMock.mockImplementation(
      () => new Promise((resolve) => pending.push(resolve)),
    );
    render(<PluginHost pluginId="pricing-model" />);
    const win = stubFrameWindow();

    for (let id = 1; id <= MAX_IN_FLIGHT_INVOKES + 1; id++) {
      postFrom(win, { channel: CHANNEL, kind: "invoke", id, fn: "slow" });
    }
    await flush();

    // Only the first MAX calls reached the backend; the extra one was refused
    // immediately with a clear error.
    expect(invokeMock).toHaveBeenCalledTimes(MAX_IN_FLIGHT_INVOKES);
    expect(win.postMessage).toHaveBeenCalledTimes(1);
    expect(win.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        id: MAX_IN_FLIGHT_INVOKES + 1,
        ok: false,
        error: expect.stringContaining("busy"),
      }),
      "*",
    );

    // Settling one call frees a slot for the next invoke.
    pending[0]("done");
    await flush();
    postFrom(win, { channel: CHANNEL, kind: "invoke", id: 99, fn: "slow" });
    await flush();
    expect(invokeMock).toHaveBeenCalledTimes(MAX_IN_FLIGHT_INVOKES + 1);
  });

  it("ignores messages from a foreign source window", async () => {
    render(<PluginHost pluginId="pricing-model" />);
    stubFrameWindow();
    const before = invokeMock.mock.calls.length;
    // A different window object is not the plugin iframe's contentWindow.
    postFrom(
      { postMessage: vi.fn() },
      {
        channel: CHANNEL,
        kind: "invoke",
        id: 2,
        fn: "x",
      },
    );
    await flush();
    expect(invokeMock.mock.calls.length).toBe(before);
  });

  it("ignores malformed messages from the iframe", async () => {
    render(<PluginHost pluginId="pricing-model" />);
    const win = stubFrameWindow();
    const before = invokeMock.mock.calls.length;
    postFrom(win, { channel: "other", kind: "invoke", id: 3, fn: "x" });
    postFrom(win, { channel: CHANNEL, kind: "nope" });
    postFrom(win, "not-an-object");
    await flush();
    expect(invokeMock.mock.calls.length).toBe(before);
  });
});
