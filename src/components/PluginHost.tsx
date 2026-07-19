import { useEffect, useRef } from "react";
import { pluginInvoke } from "../lib/api";

/**
 * Renders an untrusted plugin's UI (issue #501).
 *
 * The UI loads from the `plugin://` origin inside a `sandbox="allow-scripts"`
 * iframe — **no** `allow-same-origin`, so the frame is a unique opaque origin
 * that cannot read the app DOM, its `localStorage`, or call `invoke`. Its only
 * channel to the app is `postMessage`: the guest posts capability requests, this
 * host validates them and forwards to `plugins_invoke` **against this plugin's own
 * id only**, so a UI can drive nothing but its own (already sandboxed, broker-
 * gated) logic. The served `plugin://` document also carries `connect-src 'none'`,
 * so the iframe itself has no network — foreign data flows through the plugin's
 * WASM (`net:fetch`), never the UI.
 */

/** Wire channel shared with the guest SDK (`plugin-ui-sdk.js` in
 *  github.com/th-lange/eve-online-tooling-plugins). */
const CHANNEL = "eve-plugin";

interface InvokeRequest {
  channel: typeof CHANNEL;
  kind: "invoke";
  /** Correlates the guest's request with this host's reply. */
  id: number;
  fn: string;
  args?: unknown;
}

type HostReply =
  | {
      channel: typeof CHANNEL;
      kind: "result";
      id: number;
      ok: true;
      result: unknown;
    }
  | {
      channel: typeof CHANNEL;
      kind: "result";
      id: number;
      ok: false;
      error: string;
    };

function isInvokeRequest(data: unknown): data is InvokeRequest {
  if (typeof data !== "object" || data === null) return false;
  const m = data as Record<string, unknown>;
  return (
    m.channel === CHANNEL &&
    m.kind === "invoke" &&
    typeof m.id === "number" &&
    typeof m.fn === "string"
  );
}

export function PluginHost({
  pluginId,
  className,
}: {
  pluginId: string;
  className?: string;
}) {
  const ref = useRef<HTMLIFrameElement>(null);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      // Only accept messages from *our* iframe's window. A sandboxed frame
      // without allow-same-origin has a null origin, so source identity — not
      // `event.origin` — is the trustworthy check; anything else is ignored.
      const frame = ref.current;
      if (!frame || event.source !== frame.contentWindow) return;
      if (!isInvokeRequest(event.data)) return;

      const { id, fn, args } = event.data;
      const reply = (r: HostReply) => frame.contentWindow?.postMessage(r, "*");

      // Forward to this plugin's own logic only — the broker still gates every
      // capability inside plugins_invoke.
      pluginInvoke(pluginId, fn, args)
        .then((result) =>
          reply({ channel: CHANNEL, kind: "result", id, ok: true, result }),
        )
        .catch((err: unknown) =>
          reply({
            channel: CHANNEL,
            kind: "result",
            id,
            ok: false,
            error: err instanceof Error ? err.message : String(err),
          }),
        );
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [pluginId]);

  return (
    <iframe
      ref={ref}
      title={`plugin-${pluginId}`}
      src={`plugin://localhost/${pluginId}/index.html`}
      sandbox="allow-scripts"
      className={className ?? "h-full w-full border-0"}
    />
  );
}
