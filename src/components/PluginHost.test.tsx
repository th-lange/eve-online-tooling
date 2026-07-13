import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { PluginHost } from "./PluginHost";

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
  it("forwards a guest invoke to plugin_invoke and replies with the result", async () => {
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

    expect(invokeMock).toHaveBeenCalledWith("plugin_invoke", {
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
