# Connecting an AI agent (MCP)

EVE Online Tooling can expose a small, **read-only** slice of its data to an
external AI agent through the **Model Context Protocol (MCP)**. Ask an assistant
"what does Tritanium sell for in Jita?" or "look up this item" and it can pull
the answer from the app.

The bridge is **off by default**, **localhost-only**, **token-guarded**, and
exposes **only public data** — no character, wallet, asset, or account
information ever leaves the app, and no tool can change anything in-game.

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

### Plugin-contributed tools

An **active** plugin (see [`plugins.md`](./plugins.md)) can declare its own MCP
tools in its `plugin.json`. They appear here namespaced as `<pluginId>.<tool>`,
but only while that plugin is active, and a call routes through the same
sandboxed plugin path — so the plugin still can't touch the network, and every
data access stays behind its granted capabilities. Deactivate the plugin (or
the bridge) and its tools vanish.

> Not exposed — by design: character/ESI data (assets, wallet, orders, skills,
> industry jobs, contracts, notifications), anything requiring a login token,
> and any in-game action. The bridge is built so a tool physically cannot reach
> those.

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
cloud model. That's fine here because everything exposed is public game data —
and it's the reason character/account data is kept out entirely.
