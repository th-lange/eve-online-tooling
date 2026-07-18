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

`<app_data_dir>` is the standard per-OS app data directory. For this app it is:

| OS | `<app_data_dir>` |
| --- | --- |
| Linux | `~/.local/share/com.thlange.eve-online-tooling` (or `$XDG_DATA_HOME/com.thlange.eve-online-tooling`) |
| macOS | `~/Library/Application Support/com.thlange.eve-online-tooling` |
| Windows | `%APPDATA%\com.thlange.eve-online-tooling` (i.e. `C:\Users\<you>\AppData\Roaming\com.thlange.eve-online-tooling`) |

So plugins go in `<app_data_dir>/plugins/<id>/`. The **Plugins** page shows the
exact resolved path for your machine. `<id>` is the plugin's id and **must**
match the folder name — you never have to get this right by hand, though: the
easiest way in is drag-and-drop.

### Installing: drag-and-drop

Drag a plugin's folder, or a `.zip` of one, onto the app window (anywhere —
not just the Plugins page) and it's copied into `plugins/<id>/` automatically,
using the `id` from its `plugin.json` regardless of what the dropped
folder/zip was named. A `.zip` may have the plugin's files at its root, or
wrapped one level deep in a single folder — both work, matching the shape of
the release zips linked below. Dropping a plugin whose `id` you already have
installed **replaces** it — that's also how you update one; the update takes
effect on the plugin's next invocation (any already-running instance of the
old version is discarded). A malformed manifest is rejected before anything
is published; nothing changes — an existing install of that `id` stays
intact and keeps working.

Prefer doing it by hand? Copy the folder straight into the path shown on the
Plugins page, then click **Rescan** (or restart the app) to pick it up.

### Removing

Each installed plugin's card has a **Remove** button (a confirm step guards
against a stray click) that deactivates it, evicts its running instance, and
deletes its folder from disk — gone for good, not just deactivated.

The app enumerates the plugins folder on startup, validates each
`plugin.json`, and lists the valid ones (`plugins_list`). An invalid manifest
is skipped and logged — it never stops the app from booting. Added or removed
a plugin outside the app (e.g. editing files directly) while it's running?
Click **Rescan** to pick it up without a restart. On first run the app also
seeds a bundled `hello-ui` example here so there's something to try; delete
it and it stays gone.

## Try a ready-made one

Don't want to build anything? Grab a prebuilt example from the
[latest release](https://github.com/th-lange/eve-online-tooling/releases/latest):

- **[pricing-model-plugin.zip](https://github.com/th-lange/eve-online-tooling/releases/latest/download/pricing-model-plugin.zip)**
  — the logic **+** UI reference documented below (needs the SDE: open the
  Production module once so it downloads).
- **[hello-ui-plugin.zip](https://github.com/th-lange/eve-online-tooling/releases/latest/download/hello-ui-plugin.zip)**
  — a minimal UI-only plugin.

Drag the downloaded `.zip` onto the app window and it's installed — no need
to unzip it yourself first. Then activate it from the Plugins page. To build
one yourself instead, read on — the full source is in
[`examples/plugins/`](https://github.com/th-lange/eve-online-tooling/tree/main/examples/plugins).

## The manifest: `plugin.json`

```json
{
  "id": "pricing-model",
  "name": "Pricing Model (example)",
  "version": "0.1.0",
  "minAppVersion": "0.33.0",
  "wasm": "pricing_model.wasm",
  "permissions": ["sde:read", "market:read", "storage:own"]
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
| `allowedHosts`  | no       | Hosts the plugin may contact; required (and only valid) with `net:fetch`. |

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
| `market:read`  | `market_price` / `appraise` via `host_call`                    | available   |
| `assets:read`  | `assets` / `corp_assets` via `host_call`                       | available   |
| `orders:read`  | `my_orders` via `host_call`                                    | available   |
| `net:fetch`    | outbound HTTP, but only to the manifest's `allowedHosts`       | available   |
| `info:write`   | `send_alarm` / `write_message` — post to the Info Panel        | available   |

Enforcement is **load-time**: the host only links the host functions your
granted permissions cover. A plugin that imports an un-granted host function
fails to instantiate — there is no runtime path that could slip through.

`net:fetch` is enforced differently: rather than linking a host function, the
host builds the sandbox with an outbound-HTTP allow-list set to exactly the
plugin's `allowedHosts`. A request to any other host is refused by the runtime,
and a plugin without `net:fetch` has an empty allow-list — no network at all.

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

    // info:write — post an alarm / message to the app's Info Panel (under
    // Support). Tagged as coming from your plugin.
    fn send_alarm(text: String);
    fn write_message(text: String);
}
```

### The capability registry (`host_call`)

Beyond the specific functions above, a plugin can reach the app's shared
**capability registry** — the same read/compute operations scripts and the MCP
bridge use, so data is fetched and cached once — through one generic gateway:

```rust
#[host_fn("extism:host/user")]
extern "ExtismHost" {
    // Call a registry capability by name; args + result are JSON strings.
    // e.g. host_call("market_price", "{\"typeId\":34}")
    fn host_call(name: String, args_json: String) -> String;
}
```

Unlike the specific host functions (gated at load time), `host_call` is always
linked and gated **per call**: each capability declares the permission it
needs, and a call is refused unless your manifest was granted it. Capabilities
today: `market_price`, `sde_type_info`, `sde_search`, `appraise`, `route`
(read-only) and `assets`, `corp_assets`, `my_orders` (need the matching
`assets:read` / `orders:read` grant + a logged-in character).

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
[`examples/plugins/pricing-model/`](https://github.com/th-lange/eve-online-tooling/tree/main/examples/plugins/pricing-model). It reads
an item's volume via `sde:read` and its Jita price via `market:read`, derives a
volume-only density plus a price-aware ISK-per-m³ score, and keeps a call
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

Drag the `pricing-model/` folder (its `plugin.json` + `pricing_model.wasm`)
onto the app window, or copy it into `<app_data_dir>/plugins/` and click
**Rescan**. Then approve the requested permissions when prompted.

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

A plugin can ship an HTML/JS UI that appears as its own **sidebar page** once
the plugin is activated. Declare it in the manifest and name the entry document
`index.html` at your plugin's root:

```json
"ui": "index.html"
```

The UI loads from a distinct `plugin://` origin in a `sandbox="allow-scripts"`
iframe with **no `allow-same-origin`** — a unique opaque origin that can't read
the app's DOM or `localStorage`, call `invoke`, or reach the network
(`connect-src 'none'`). Its only channel to the app is a `postMessage` bridge.

### The bridge

Your UI reaches its own logic through one call, `invoke(fn, args)`: it runs one
of **your own** plugin's exported WASM functions through the host
(`plugin_invoke`) and resolves with the JSON return value. The broker still
enforces the capabilities your manifest was granted, and the host only ever
dispatches to _your_ plugin — a UI can drive nothing but its own logic. To pull
foreign data, that logic uses `net:fetch` in the WASM layer, never the iframe.

`args` reaches your export exactly as `plugin_invoke` sends it: the
JSON-serialised value. A function taking a bare `String` (like the reference's
`evaluate(type_id: String)`) wants a JSON **number** / unquoted value, not a
quoted string; a function taking a struct wants an object.

`invoke` is a thin wrapper over `postMessage`. For a **single-file UI** the
simplest thing is to inline it — no import, works on any build:

```html
<script>
  const CHANNEL = "eve-plugin";
  const pending = new Map();
  let nextId = 1;
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m || m.channel !== CHANNEL || m.kind !== "result") return;
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    m.ok ? p.resolve(m.result) : p.reject(new Error(m.error));
  });
  function invoke(fn, args) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      parent.postMessage({ channel: CHANNEL, kind: "invoke", id, fn, args }, "*");
    });
  }
  // const r = await invoke("evaluate", 34);
</script>
```

Under the hood that's this wire protocol, if you'd rather implement it yourself:

```js
// your window → parent
{ channel: "eve-plugin", kind: "invoke", id: 1, fn: "evaluate", args: 34 }
// parent → your window
{ channel: "eve-plugin", kind: "result", id: 1, ok: true, result: {} }
// or, on failure
{ channel: "eve-plugin", kind: "result", id: 1, ok: false, error: "…" }
```

For a **multi-file / TypeScript UI**, copy
[`plugin-ui-sdk.js`](https://github.com/th-lange/eve-online-tooling/blob/main/examples/plugins/plugin-ui-sdk.js)
(and [`plugin-ui-sdk.d.ts`](https://github.com/th-lange/eve-online-tooling/blob/main/examples/plugins/plugin-ui-sdk.d.ts)
for types) into your UI and `import { invoke }` from it. The `plugin://` host
sends `Access-Control-Allow-Origin`, so a sandboxed frame can ES-module-import
its own assets (app builds from v0.40).

### Reference

[`examples/plugins/pricing-model/`](https://github.com/th-lange/eve-online-tooling/tree/main/examples/plugins/pricing-model)
is a complete logic **+** UI plugin: its Rust WASM scores an item by name
(`search` resolves the name via `sde_search`, `evaluate` scores its cargo
density and price-aware ISK/m³ via `sde_type_info` + `market_price`),
and `index.html` drives it through the bridge as a self-contained
single-file UI. Drop the folder into your plugins dir, activate it, and it
shows up as a **Pricing Model** page.

## Other languages

Rust is the reference, but a logic plugin can be written in **any
Extism-supported language** — Go, TypeScript, AssemblyScript, Zig, or C. The
manifest, permissions, and host-function contract are identical; only the guest
SDK differs.
