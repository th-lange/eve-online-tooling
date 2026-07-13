# Writing a plugin

eve-online-tooling can load **third-party plugins** dropped into a local folder.
A plugin adds either pure logic/data (a pricing model, a BOM optimizer, a custom
profit engine) or — later — its own UI page.

Plugins are **untrusted**. They run in a WebAssembly sandbox and get **no
ambient authority**: no filesystem, no network, no keychain, no ESI tokens.
The only things a plugin can reach are the host functions the app exposes, and
each of those is gated behind a permission the user explicitly grants at install
time. If a plugin's manifest asks for a capability the user hasn't granted, the
plugin can't even start.

This page documents Phase 1 — **logic plugins** (WASM).

## Where plugins live

```
<app_data_dir>/plugins/<id>/
  plugin.json        # the manifest (required)
  <id>.wasm          # the compiled logic (for a logic plugin)
```

`<app_data_dir>` is the standard per-OS app data directory. `<id>` is the
plugin's id and **must** match the folder name.

The app enumerates this folder on startup, validates each `plugin.json`, and
lists the valid ones (`plugins_list`). An invalid manifest is skipped and
logged — it never stops the app from booting.

## The manifest: `plugin.json`

```json
{
  "id": "pricing-model",
  "name": "Pricing Model (example)",
  "version": "0.1.0",
  "minAppVersion": "0.33.0",
  "wasm": "pricing_model.wasm",
  "permissions": ["sde:read", "storage:own"]
}
```

| Field           | Required | Meaning                                                            |
| --------------- | -------- | ------------------------------------------------------------------ |
| `id`            | yes      | Stable id; must equal the folder name; `[A-Za-z0-9_-]` only.       |
| `name`          | yes      | Human-readable name.                                               |
| `version`       | yes      | Plugin version (semver).                                           |
| `minAppVersion` | yes      | Minimum app version this plugin supports (semver).                 |
| `wasm`          | one of   | Path to the WASM entry point (relative to the plugin folder).      |
| `ui`            | one of   | Path to the UI HTML entry point (Phase 2).                         |
| `permissions`   | no       | Capabilities requested (see below). Empty = a powerless plugin.    |
| `mcpTools`      | no       | MCP tools this plugin backs (see below). Each needs a `wasm` entry. |

At least one of `wasm` / `ui` must be present. Unknown permission strings,
non-semver versions, an id that doesn't match the folder, or a `wasm` path that
escapes the folder are all rejected.

## Permissions

A permission is a string in `permissions`. Each grants access to specific host
functions; nothing else is reachable.

| Permission     | Grants                                                          | Status      |
| -------------- | -------------------------------------------------------------- | ----------- |
| `storage:own`  | `storage_get` / `storage_set` — a private key/value store      | available   |
| `sde:read`     | `sde_type_info` — read the Static Data Export                  | available   |
| `market:read`  | live market prices                                             | planned     |
| `assets:read`  | the user's assets                                              | planned     |

Enforcement is **load-time**: the host only links the host functions your
granted permissions cover. A plugin that imports an un-granted host function
fails to instantiate — there is no runtime path that could slip through.

## Host functions

Declared in the `extism:host/user` namespace. From Rust (extism PDK):

```rust
#[host_fn("extism:host/user")]
extern "ExtismHost" {
    // storage:own — values are scoped to *your* plugin; you cannot see
    // another plugin's data or the app's own storage.
    fn storage_get(key: String) -> String;        // "" if unset
    fn storage_set(key: String, value: String);

    // sde:read — returns the item's TypeInfo as JSON, or "null" if unknown.
    fn sde_type_info(type_id: String) -> String;
}
```

## Being called

The host invokes an exported function by name through a single command:

```
plugin_invoke(pluginId, fn, argsJson) -> Result<JsonValue, AppError>
```

`argsJson` is passed to your exported function as its input, and your return
value is handed back as JSON. Runaway plugins are stopped: each instance has a
memory cap (~64 MiB) and a per-call timeout.

## The reference plugin

A complete, buildable example lives in
[`examples/plugins/pricing-model/`](../examples/plugins/pricing-model/). It reads
an item's volume via `sde:read`, derives a deterministic score, and keeps a call
counter in `storage:own`.

### Build it

```sh
rustup target add wasm32-unknown-unknown
cargo build --release --target wasm32-unknown-unknown \
  --manifest-path examples/plugins/pricing-model/Cargo.toml
cp examples/plugins/pricing-model/target/wasm32-unknown-unknown/release/pricing_model.wasm \
   examples/plugins/pricing-model/pricing_model.wasm
```

### Install it

Copy the `pricing-model/` folder (its `plugin.json` + `pricing_model.wasm`) into
`<app_data_dir>/plugins/`, restart the app, and approve the requested
permissions when prompted.

> The install-time **consent** prompt that grants permissions is tracked
> separately; until it lands, grants are empty, so a plugin that needs a
> capability (like this one) can be exercised through the test suite but not
> yet granted live in the running app.

## Exposing MCP tools

A plugin can offer tools to an external AI agent through the app's [MCP
bridge](./mcp.md). Declare them in `plugin.json`:

```json
"mcpTools": [
  {
    "name": "price_vector",
    "description": "Custom price model for a type.",
    "inputSchema": { "type": "object", "properties": { "typeId": { "type": "integer" } } },
    "function": "price_vector"
  }
]
```

`function` is the exported WASM function that implements the tool; it's called
exactly like `plugin_invoke` (JSON in, JSON out) with your granted
capabilities. The host advertises the tool as `<pluginId>.<name>` — but only
while your plugin **and** the MCP bridge are active. Your plugin never touches
the network; the native bridge proxies the call.

## UI plugins

A plugin can ship an HTML/JS UI that appears as its own page. Point `ui` at the
entry document (relative to the plugin folder):

```json
"ui": "index.html"
```

The UI is served from a distinct `plugin://` origin and rendered in a
`sandbox="allow-scripts"` iframe with **no `allow-same-origin`** — so it is a
unique opaque origin that cannot read the app's DOM or `localStorage`, call
`invoke`, or reach the network (`connect-src 'none'`). Its only channel is a
`postMessage` bridge to the host.

Copy [`examples/plugins/plugin-ui-sdk.js`](../examples/plugins/plugin-ui-sdk.js)
into your UI and call your own logic through it:

```html
<script type="module">
  import { invoke } from "./plugin-ui-sdk.js";
  const result = await invoke("appraise", { items: [/* … */] });
</script>
```

`invoke(fn, args)` runs one of **your own** plugin's exported functions through
the host (`plugin_invoke`) — the broker still enforces the capabilities your
manifest was granted. A UI can drive nothing but its own logic; to pull foreign
data, that logic uses `net:fetch` in the WASM layer, never the iframe.

## Other languages

Rust is the reference, but a logic plugin can be written in **any
Extism-supported language** — Go, TypeScript, AssemblyScript, Zig, or C. The
manifest, permissions, and host-function contract are identical; only the guest
SDK differs.
