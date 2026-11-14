# Connecting an AI agent (MCP)

EVE Online Tooling can expose a small, **read-only** slice of its data to an
external AI agent through the **Model Context Protocol (MCP)**. Ask an assistant
"what does Tritanium sell for in Jita?" or "look up this item" and it can pull
the answer from the app.

The bridge is **off by default**, **localhost-only**, **token-guarded**, and
the built-in tools expose **only public data** — no character, wallet, asset,
or account information ever leaves the app through them, and no built-in tool
can change anything in-game. The one exception is [plugin-contributed
tools](#plugin-contributed-tools), which you must enable per plugin and which
can return whatever that plugin is allowed to read.

## Turning it on

1. Open the **Plugins** page.
2. On the **MCP bridge** card, click **Activate**.
3. Copy the **URL** and **Token** shown on the card into your MCP client — or
   copy the ready-made **MCP client config** snippet shown right there.

Optionally set a fixed **Port** on the card first (blank / `0` = an
OS-assigned port). A fixed port keeps your client config stable across
restarts; changing it while the bridge is running restarts it on the new port.

Deactivate any time from the same card; the server stops immediately.

### Hands-free startup (for agent-driven testing)

Check **Start MCP bridge on launch** on the same card to skip the manual
Activate step on every session. When enabled, the bridge starts automatically
with the app, on the port you've configured (auto by default).

While running — whether started manually or via autostart — the app also
writes a **discovery file** to `<app data dir>/mcp.json`:

```json
{ "url": "http://127.0.0.1:<port>/mcp", "token": "<bearer token>" }
```

The file is created with `0600` permissions (owner-only) and removed the
moment the bridge stops or the app exits — so a stale file never outlives a
running server. A local agent (e.g. Claude Code) can launch the app, poll for
this file, and self-configure with no human copy-pasting:

```bash
claude mcp add --transport http eve-online-tooling "$(jq -r .url mcp.json)" \
  --header "Authorization: Bearer $(jq -r .token mcp.json)"
```

Security posture is unchanged by either convenience: still loopback-only,
still a fresh per-session token, still read-only public-data tools. The
discovery file only makes the token readable to the same OS user that could
already read the app's data directory.

## What it exposes

All tools are read-only and operate on public data:

| Tool | Input | Returns |
| --- | --- | --- |
| `ping` | — | `"pong"` (health check) |
| `sde_search` | `query`, `limit?` (≤50) | matching item type ids + names |
| `sde_type_info` | `typeId` | name, group, packaged volume (or null) |
| `market_price` | `typeId`, `regionId?` | sell/buy percentile, adjusted & average price (default region: The Forge / Jita) |
| `appraise` | `items` (`[{name, quantity}]`), `regionId?` | total buy/sell ISK value + cargo volume, per-line prices |
| `route` | `from`, `to` (system names) | shortest stargate jump count between two systems |

Prices come through the app's cached market service, so repeated lookups mostly
hit cache rather than hammering EVE's servers.

### Dev tier (compute engines, off by default)

A second, separately opt-in tier exposes the app's **deterministic compute
engines** — build-vs-buy production profit, fitting stats from an EFT string,
and reprocessing yield — so an agent can drive **live regression checks**
against the app instead of only reading data. Check **Expose compute engines
to MCP** on the MCP bridge card to turn it on; it only takes effect while the
bridge is running.

| Tool | Input | Returns |
| --- | --- | --- |
| `production_profit` | `blueprintTypeId`, `runs?`, `me?`, `regionId?`, `systemCostIndex?`, `facilityTax?` | required material quantities (ME-adjusted), material cost, job fee, revenue, profit |
| `fitting_stats` | `eft` (EFT clipboard text) | resources, validation, DPS, tank, capacitor at all-V skills |
| `reprocessing_yield` | `typeId`, efficiency/region params (see tool schema) | refine-output value vs. sell value at a given efficiency |

These are still **pure and public**: every dev-tier tool takes explicit
inputs and reads only the SDE + cached market prices — never owned
blueprints/fits, ESI, or any character/account data. That boundary is
structural (the capability layer's `HostCtx` is never handed anything else)
and pinned by a Rust test (`mcp_never_reaches_auth_gated_data`) that fails if
an auth-gated capability is ever flipped onto either MCP tier. See
[`testing-mcp.md`](./testing-mcp.md) for a golden-expectation suite an agent
can run end-to-end to verify the engines against independently-computed
facts after a change to `sde/`, `market/`, or an exposed engine.

### Plugin-contributed tools

A plugin (see [`plugins.md`](./plugins.md)) can declare its own MCP tools in
its `plugin.json`. They appear here namespaced as `<pluginId>.<tool>`, but only
while that plugin is **active** *and* you have switched on **Expose these tools
to MCP clients** on its card on the Plugins page (off by default). A call routes
through the sandboxed plugin path with **all of the plugin's own granted
permissions**, so a plugin that holds `assets:read` or `orders:read` can return
that personal data, and one with `net:fetch` can contact its `allowedHosts`.
Unlike the built-in tools, plugin tools are therefore **not** limited to public
data. Only enable this for plugins you trust, and remember a client may forward
the result to a cloud model (see below). Deactivate the plugin, switch the
toggle off, or stop the bridge and its tools vanish.

> Built-in tools never expose character/ESI data (assets, wallet, orders,
> skills, industry jobs, contracts, notifications) or anything requiring a
> login token, and none can take an in-game action; the built-in registry is
> pinned by a test. Plugin-contributed tools are the opt-in exception above.

## Configuring a client

The bridge speaks JSON-RPC 2.0 over HTTP at the URL from the Plugins page, with
the token as a bearer header. A generic MCP HTTP-client entry looks like:

```json
{
  "mcpServers": {
    "eve-online-tooling": {
      "url": "http://127.0.0.1:<port>/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

Use the exact URL + token shown on the MCP bridge card. The **token** is
assigned per session (it changes each time you activate the bridge); the
**port** is whatever you set, or an OS-assigned one when left on auto. Refer to
your client's docs for where its MCP-server config lives.

## A note on "local"

The bridge binds `127.0.0.1` only, so nothing on your network can reach it. But
"local endpoint" does not mean "your data stays on your machine": a client app
(e.g. a desktop assistant) may still forward whatever a tool returns to its own
cloud model. That's fine for the built-in tools because everything they expose is public game
data, which is why character/account data is kept out of them entirely. It is
also why plugin-contributed tools, which can return personal data, are
off until you enable them per plugin.
