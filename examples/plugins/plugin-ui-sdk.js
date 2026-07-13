// EVE Online Tooling — plugin UI SDK (issue #501).
//
// Drop this into your plugin's UI folder and load it from `index.html`:
//
//   <script type="module">
//     import { invoke } from "./plugin-ui-sdk.js";
//     const price = await invoke("appraise", { items: [...] });
//   </script>
//
// Your UI runs in a sandboxed `plugin://` iframe with **no network and no
// access to the app**. Its only channel is this bridge: `invoke(fn, args)`
// calls your plugin's own WASM logic through the host, which enforces the
// capabilities your `plugin.json` was granted. Reaching foreign data requires
// `net:fetch` + `allowedHosts` and happens in your WASM, not here.

const CHANNEL = "eve-plugin";

let nextId = 1;
const pending = new Map();

window.addEventListener("message", (event) => {
  const m = event.data;
  if (!m || m.channel !== CHANNEL || m.kind !== "result") return;
  const entry = pending.get(m.id);
  if (!entry) return;
  pending.delete(m.id);
  if (m.ok) entry.resolve(m.result);
  else entry.reject(new Error(m.error));
});

/**
 * Call one of your plugin's exported functions and await its result.
 * @param {string} fn   - exported function name in your plugin's WASM.
 * @param {unknown} args - JSON-serialisable argument.
 * @returns {Promise<unknown>}
 */
export function invoke(fn, args) {
  const { promise, resolve, reject } = Promise.withResolvers();
  const id = nextId++;
  pending.set(id, { resolve, reject });
  parent.postMessage({ channel: CHANNEL, kind: "invoke", id, fn, args }, "*");
  return promise;
}
