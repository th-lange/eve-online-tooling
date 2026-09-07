# EVE Online Tooling

Free, open-source desktop tools for [EVE Online](https://www.eveonline.com/) —
industry, market, character and intel, in one app (Linux · macOS · Windows).
Built with Tauri 2 + React/TypeScript; data from EVE's public **ESI** API and
the **SDE**.

[**⬇ Download the latest release**](https://github.com/th-lange/eve-online-tooling/releases/latest)
· [Source on GitHub](https://github.com/th-lange/eve-online-tooling)

![The Production module ranking every manufacturable item by build-vs-buy profit, with the grouped module sidebar on the left](img/overview.png)

## What it is

- **One app, many modules** — log in one or more characters via EVE SSO (tokens
  live in your OS keychain), or use the public market/industry tools with no
  login at all.
- **Local & private** — everything runs on your machine; ESI/SDE data is cached
  locally. No account, no telemetry, nothing phoning home in the background.
  The one thing that ever leaves your machine is a **Feedback** submission —
  only when you press send, and the app shows you the exact payload first.
- **Free & open source** under the **MIT** license.

## Modules

**Industry** — Production (build-vs-buy profit for every manufacturable item,
recursive, T2 invention, T3 relics), Reprocessing, Industry Jobs, Planetary
Interaction.

**Trading & market** — Station Trading, Daytrading, Market Orders (undercut
detection + build-cost guard), Market Search, Appraisal, Public Contracts,
LP Store.

**Character** — Assets, Character (skills/standings/research), Accounting,
Transactions, Notifications, Fitting (a PYFA-grade fit editor + dogma engine),
Shopping Lists.

**Combat / Intel** — PVP (pilot threat + fit profiler from zKillboard), Local
Intel, DPS Meter, Route, Wormholes, Pochven, Universe, Incursions, Faction
Warfare, Exploration.

**Extend it** — [Scripts](scripts.md) (Rhai/JS on a timer),
[Plugins](plugins.md) (sandboxed WASM + UI), and an [MCP bridge](mcp.md).

**Support** — [Feedback](feedback.md) (rate a module, report a bug, ask for a
feature), Info Panel.

## Install

Grab the installer for your OS from the
[latest release](https://github.com/th-lange/eve-online-tooling/releases/latest):
`.AppImage` / `.deb` / `.rpm` (Linux), `.dmg` (macOS), `.msi` / `-setup.exe`
(Windows).

The builds are **unsigned** — a deliberate call for a free hobby project, so
your OS warns on first launch (macOS: right-click → **Open**; Windows:
**More info → Run anyway**). Full reasoning:
[SIGNING.md](https://github.com/th-lange/eve-online-tooling/blob/main/SIGNING.md).

## Build from source

Prerequisites, dev commands and the release process are in the
[development guide](development.md).
