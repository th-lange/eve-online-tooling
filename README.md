# eve-online-tooling

A standalone cross-platform desktop app (Linux / macOS / Windows) for [EVE Online](https://www.eveonline.com/),
built as a set of feature **modules** over a shared service layer.

- **Production** — read your characters' (and corp) blueprints, fetch live market prices, and rank what
  you can manufacture by build-vs-buy **profit**, including recursive build-vs-buy and T2 invention.
- **Station Trading** — scan a hub for profitable buy→sell flips, with a blacklist and favorites.
- **Daytrading** — scans multiple regional hubs for price gaps on the same item, finds the best
  cross-region flip (buy cheapest → sell dearest) after taxes/fees, ranked by ISK/m³.
- **Reprocessing** — ranks ores by reprocess-vs-sell at your refining efficiency.
- **Mission-running** and more — planned.

Built with **Tauri 2** (Rust core) + **React / TypeScript** (Vite). Market and character data come
from EVE's **ESI** API; blueprint/material data from the **SDE**.

## Install

Grab the installer for your OS from the
[latest release](https://github.com/th-lange/eve-online-tooling/releases/latest):

- **Linux** — `.AppImage` (`chmod +x` it, then run) or `.deb`
  (`sudo apt install ./eve-online-tooling_*.deb`).
- **macOS** — open the `.dmg` and drag the app to Applications. The build is **unsigned**, so on first
  launch right-click the app → **Open** (or run
  `xattr -dr com.apple.quarantine "/Applications/EVE Online Tooling.app"`).
- **Windows** — run the `.msi` (or the NSIS `-setup.exe`). SmartScreen may warn (unsigned):
  **More info → Run anyway**.

Prefer to run from source? See *Getting started* below.

## Getting started

### 1. Install prerequisites

- **Node.js** (18+) and npm.
- **Rust** via [rustup](https://rustup.rs/):
  ```bash
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh
  ```
- **Linux only** — WebView/build libraries (without these the Rust build fails at `glib-sys`):
  ```bash
  sudo apt-get update && sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential \
    curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev pkg-config
  ```
  (macOS: Xcode command-line tools. Windows: the WebView2 runtime + MSVC build tools.)

### 2. Install dependencies

```bash
npm install
```

### 3. Run the app

```bash
npm run tauri dev      # launches the desktop app with hot reload
```

The first time you open the Production module it downloads the EVE **SDE** (a few hundred MB,
Fuzzwork's SQLite build) into your app data dir; that's a one-off.

### 4. (Later) EVE SSO

Reading character assets/blueprints needs a developer application from
[developers.eveonline.com](https://developers.eveonline.com) — a **Client ID** and a loopback
callback URL. Not required for the market/production calculations, which use public data.

## Common commands

| Command | What it does |
| --- | --- |
| `npm run tauri dev` | Run the desktop app (hot reload) |
| `npm run tauri build` | Build distributable bundles |
| `npm run build` | Type-check + build the frontend |
| `npm run test` | Frontend unit tests (Vitest) |
| `cd src-tauri && cargo test` | Rust unit tests |

See [`CLAUDE.md`](./CLAUDE.md) for architecture and EVE domain notes.

## What works today

- **App shell** — Tauri 2 + React/TS, module-based navigation.
- **SDE service** — download/verify the Fuzzwork SQLite; query blueprint materials, products, and
  type info.
- **Market service** — live ESI prices for Jita/The Forge as a multi-vector model (spot sell/buy,
  daily average, N-day moving average, volume), cached.
- **Production profit engine** — ME-adjusted material cost + EIV job fee + revenue → profit, margin,
  and per-unit, with a per-material breakdown.
- **Production workbench** — a single window that ranks **every** manufacturable item by build-vs-buy
  profit at a chosen market, then filters (EVE-Guru-style):
  - **Pricing** via [Fuzzwork market aggregates](https://market.fuzzwork.co.uk/) — pick a **region**
    and optionally a **hub** (Jita, Amarr, Dodixie, Rens, Hek); region = region average, hub = station
    prices. Prices/ROI follow the selection.
  - **Filters** in tabs (Item / Market / Thresholds): name, Category/Type, Meta (Tech I/II/III,
    Faction, Officer…), price basis (sell/buy percentile, min/max, average), runs / ME / cost index /
    facility tax / **per-run blueprint cost**, **min ROI**, and **min volume** (when a hub is picked).
  - Sortable table — price · **ROI** · margin · **profit/item** (net, can be negative) · volume · market — with a per-material cost
    drill-down. Column headers carry hover/`ⓘ` descriptions, and the chosen **sort sticks** across
    recalcs and restarts. **T2 items include the amortized invention cost** (datacores + invention job
    fee + the T1 BPC copy fee, divided by success probability × runs per success), with a configurable
    **invention skill level** (0–5, default all-V) scaling the probability and an optional
    **decryptor** (shifts the invented ME / runs / probability and is priced per attempt).
  - **T3 strategic cruisers & subsystems** — invented from **Ancient Relics**, whose market cost is
    consumed and priced into the invention attempt.
  - **Recursive build-vs-buy**: intermediate components are resolved down the tree (manufacturing +
    reactions) and each takes the cheaper of building or buying; the drill-down tags inputs that are
    cheaper to **build**.
  - **Owned-only** / **Favorites-only** filters, plus persisted **blacklist** and **favorites**
    (★/✕ on each row, with Opportunities / Favorites / Blacklist tabs).
- **Smart SDE caching** — the static data only re-downloads when Fuzzwork's published md5 changes
  ("Update data" button reports updated vs already-current).
- **EVE SSO login (multi-character)** — add one or more characters via OAuth2 PKCE (sidebar →
  "Add character"); each refresh token is stored in the OS keychain, the roster persists across
  restarts, and removing a character clears its credential.
- **Station-trading module** — scan a hub's ~19k market items for buy→sell flips: profit/unit and
  margin after broker fee + sales tax, with a min-volume filter, plus persisted **blacklist** and
  **favorites** tabs (★/✕ on each row). The table is **sortable** on every column and shows order-book
  depth on each side — **Sell vol** / **Buy vol** (units listed in sell vs buy orders) — alongside
  **Traded/day** (real units moved, from market history; buys and sells are the same quantity, so that
  column isn't split).
- **Daytrading module** — pick a set of regional hubs (or all of them) and scan ~19k items for the
  best **cross-region** flip on each: buy at the cheapest hub, sell at the dearest, after sales tax +
  broker fee. Ranked by **ISK/m³** (cargo is the constraint), with the buy→sell route, per-unit
  profit, margin, item volume, and sell-hub daily-traded volume — sortable, searchable, with the same
  blacklist/favorites.

## Releasing

Installers are produced by the **Release** GitHub Actions workflow (`.github/workflows/release.yml`).
To cut a release:

1. Bump the version in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`.
2. Commit, then tag and push: `git tag v0.5.0 && git push origin v0.5.0`.

The workflow builds Linux / macOS / Windows installers on their respective runners and attaches them
to the GitHub Release for that tag (it can also be run manually from the **Actions** tab against an
existing tag). Builds are currently **unsigned** — code signing (Apple notarization, Windows
Authenticode) and in-app auto-update can be layered into the same workflow later.

## Status & tracking

Work is tracked as [GitHub issues](https://github.com/th-lange/eve-online-tooling/issues)
(`afk` = mergeable without a human, `hitl` = needs a human).
