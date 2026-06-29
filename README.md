# eve-online-tooling

A standalone cross-platform desktop app (Linux / macOS / Windows) for [EVE Online](https://www.eveonline.com/),
built as a set of feature **modules** over a shared service layer.

- **Production** — read your characters' (and corp) blueprints, fetch live market prices, and rank what
  you can manufacture by build-vs-buy **profit**, including recursive build-vs-buy and T2 invention.
- **Station Trading** — scan a hub for profitable buy→sell flips, with a blacklist and favorites.
- **Daytrading** — scans multiple regional hubs for price gaps on the same item, finds the best
  cross-region flip (buy cheapest → sell dearest) after taxes/fees, ranked by ISK/m³.
- **Reprocessing** — ranks ores by reprocess-vs-sell at your refining efficiency.
- **Appraisal** — paste items for a buy/sell valuation across hubs, or a reprocessing mineral yield.
- **Market Search** — find an item's sell orders across any region (or everywhere), with a
  jumps-to-station column (high-sec-only or shortest routing), plus a price &amp; volume history tab.
- **Universe**, **Assets**, **Character** (skills/standings/research/mining/fleet),
  **Accounting** (wallet + FIFO profit), **Public Contracts**, and **LP Store** tools.
- **Route** — per-system jumps & ship/pod/NPC kills (last hour) across known space, a stargate
  neighbourhood "fog-of-war" map, and a live travel breadcrumb spanning known space and wormholes.
- **Local Intel** — paste the in-game Local member list to classify pilots blue/neutral/red by standing,
  corp and alliance, with a corp/alliance watchlist + alerts and zKillboard danger enrichment.
- **Market Orders** — your open buy/sell orders with undercut detection and a one-tick re-list helper.
- **Industry Jobs** — personal + corp jobs ("what's cooking") with finish countdowns, status/location
  filters, and production/science/reaction slot usage.
- **Wormholes** — map your chain by hand with mass/EOL tracking, cross-chain routing (stargates ∪ your
  scanned holes), and probe-scanner signature paste.
- **Fitting** — build a ship fit (EFT import/export + local saves), validate slots / CPU / powergrid /
  calibration / drone bay, price the whole fit, and simulate PYFA-style stats — **DPS, EHP/tank,
  capacitor stability (with a cap-over-time chart), speed/align and targeting** — at all-V or your
  character's real skills. Add modules by text search or by **browsing the market-group tree**.
- **Shopping Lists** — keep named lists of items to buy (a built-in *default* and *production* list,
  plus your own), fed by "add to list" buttons across Market Search, Production, Station Trading and
  Daytrading, with quantity editing and one-click in-game Multibuy export.
- **DPS Meter** — a live combat readout from your gamelog (à la PyEveLiveDPS): damage in/out, remote
  reps, cap warfare and mining as a moving-average graph, with per-pilot / per-weapon breakdowns and
  N× log playback. EULA-safe — it only reads the logs the client already writes.
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

- **App shell** — Tauri 2 + React/TS, module-based navigation. The sidebar groups modules into
  labelled sections (Industry · Trading · Market · Assets · Character · Intel/Space), with
  drag-to-reorder, pinning and per-module colour tags. A **⌘K / Ctrl+K command palette** fuzzy-jumps
  to any module and looks up any item type (routing to Market Search). Lucide icon set throughout.
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
  ("Update data" button reports updated vs already-current), and a best-effort daily check on startup
  keeps it current automatically.
- **Conditional ESI caching** — all ESI traffic flows through one client that revalidates with
  **ETags** (cheap `304 Not Modified` instead of full re-downloads), honours each response's cache
  timer (`Cache-Control`/`Expires`) instead of guessing, persists across restarts, and backs off
  ESI's error budget (with transient-failure retries). Data pages show an "Updated N ago" freshness
  label.
- **EVE SSO login (multi-character)** — add one or more characters via OAuth2 PKCE (sidebar →
  "Add character"); each refresh token is stored in the OS keychain, the roster persists across
  restarts, and removing a character clears its credential.
- **Station-trading module** — scan a hub's ~19k market items for buy→sell flips: profit/unit and
  margin after broker fee + sales tax, with a min-volume filter, plus persisted **blacklist** and
  **favorites** tabs (★/✕ on each row). The table is **sortable** on every column and shows order-book
  depth on each side — **Sell vol** / **Buy vol** (units listed in sell vs buy orders) — alongside
  **Traded/day** (real units moved, from market history; buys and sells are the same quantity, so that
  column isn't split).
- **Daytrading module** — pick a set of regional hubs (or all of them) and a **category whitelist**
  (defaults to Ships + Modules + Charges; "Select all" for the full catalogue), then scan only those
  categories for the best **cross-region** flip on each: buy at the cheapest hub, sell at the dearest,
  after sales tax + broker fee. Scanning a few categories instead of the whole ~19k catalogue means far
  less market data pulled per hub — faster scans, lighter API load. Ranked by **ISK/m³** (cargo is the
  constraint), with the buy→sell route, per-unit profit, margin, item volume, and sell-hub daily-traded
  volume — sortable, searchable, with the same blacklist/favorites.
- **Fitting module** — a **PYFA-grade** ship-fit editor with a data-driven dogma engine, validated
  exact against PYFA across a golden test suite. Pick a hull and add modules from a **slot-driven**
  browser (click a free slot → filtered results, with slot badges); it validates slot/hardpoint counts
  and CPU / powergrid / calibration / drone-bay usage, prices the whole fit, and computes the full stat
  set — turret/missile/drone **DPS** (charges resolve bidirectionally: ammo/crystal damage & rof, plus
  charge→host cap/range/tracking), **EHP** with stacking-penalized resists, **capacitor** stability
  *and* a discrete depletion sim, **speed** (incl. afterburner/MWD boost), **align/signature** and
  **targeting** — at **all-V** or the character's **real skills**. Handles **implants/boosters**,
  **T3 subsystem** slot grants, and **projected** effects (webs/paints/damps). Fits import/export as
  **EFT**, save locally, and sync to your in-game fittings via **ESI** (read *and* write).
- **Shopping Lists module** — a group of named item lists (a non-removable *default* and *production*,
  plus any you create). Add items via a known-item search field, edit quantities inline, and export a
  list straight to the in-game **Multibuy** window. Market Search, Production (a build's material
  shortfall), Station Trading and Daytrading all have an "add to list" button that pushes onto any list.

## Releasing

Installers are produced by the **Release** GitHub Actions workflow (`.github/workflows/release.yml`).
To cut a release:

1. Bump the version in `package.json`, `src-tauri/Cargo.toml`, and `src-tauri/tauri.conf.json`.
2. Commit, then tag and push: `git tag v0.6.0 && git push origin v0.6.0`.

The workflow builds Linux / macOS / Windows installers on their respective runners and attaches them
to the GitHub Release for that tag (it can also be run manually from the **Actions** tab against an
existing tag). Builds are currently **unsigned** — code signing (Apple notarization, Windows
Authenticode) and in-app auto-update can be layered into the same workflow later.

## Status & tracking

Work is tracked as [GitHub issues](https://github.com/th-lange/eve-online-tooling/issues)
(`afk` = mergeable without a human, `hitl` = needs a human).
