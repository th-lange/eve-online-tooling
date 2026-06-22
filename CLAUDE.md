# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A standalone cross-platform desktop app (Linux/Mac/Windows) for EVE Online, built as **feature
modules** that share a common service layer. The first module is **Production**: log in a character
via EVE SSO, read their assets + blueprints, fetch live market prices, and rank manufacturable items
by build-vs-buy **profit** (= product sell value − material cost − industry fees/taxes).

Stack: **Tauri 2** (Rust core) + **React 19 / TypeScript** (Vite) UI. Market data comes from ESI
directly. Work is tracked as GitHub issues on `th-lange/eve-online-tooling` (`afk` = mergeable
without a human, `hitl` = needs a human).

## Commands

Run from the repo root unless noted.

| Task | Command |
| --- | --- |
| Run the desktop app (dev) | `npm run tauri dev` |
| Build distributable bundles | `npm run tauri build` |
| Frontend type-check + build | `npm run build` (`tsc && vite build`) |
| Frontend tests (once) | `npm run test` (Vitest) |
| Frontend tests (watch) | `npm run test:watch` |
| Single frontend test file | `npx vitest run src/lib/api.test.ts` |
| Single frontend test by name | `npx vitest run -t "registers the production module"` |
| Rust tests | `cd src-tauri && cargo test` |
| Single Rust test | `cd src-tauri && cargo test ping_returns_pong` |
| Rust type-check | `cd src-tauri && cargo check` |

Anything that compiles Rust (`cargo *`, `tauri dev/build`) requires the system prerequisites below;
pure-frontend commands (`vite`, `vitest`) do not.

## Prerequisites

- **Node** (used 26) and npm.
- **Rust** toolchain via rustup; `cargo` must be on `PATH` (`. "$HOME/.cargo/env"`).
- **Linux system libs** for the WebView/build (without these `cargo` fails at `glib-sys`/`webkit`):
  ```
  sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
    libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev pkg-config
  ```
- **EVE developer application** (needed once SSO lands, issue #3): register at
  https://developers.eveonline.com for a **Client ID**, set the callback to the app's loopback
  (e.g. `http://localhost:8765/callback`), scopes `publicData`, `esi-assets.read_assets.v1`,
  `esi-characters.read_blueprints.v1`. Native PKCE flow — no client secret.

## Architecture

The big idea: **feature modules reuse shared services.** Adding a feature (daytrading,
station-trading, …) = one Rust submodule under `src-tauri/src/modules/` exposing its commands, plus
one entry in `src/modules/registry.ts`. The sidebar nav and routes are generated from that registry,
so the UI wires itself up.

### Rust core (`src-tauri/src/`)

- `lib.rs` — Tauri builder: registers plugins and the `invoke_handler`. Module map lives here.
- `commands.rs` — thin command layer bridging the frontend `invoke()` to services (currently `ping`).
- Shared services (stubs today, each filled by its tracking issue):
  - `esi/` — EVE SSO auth + rate-limit-aware ESI HTTP client + endpoint wrappers (#3/#4/#5)
  - `sde/` — Static Data Export: bootstrap + query the Fuzzwork SQLite (#2)
  - `market/` — multi-vector price service + cache (#5)
  - `model/` — shared domain types
  - `storage/` — OS keychain (refresh tokens) + on-disk cache (#2/#3/#5)
- `modules/production/` — the profit engine (#6); future modules sit beside it.

### Frontend (`src/`)

- `main.tsx` — providers (`QueryClientProvider`) + router; routes are generated from the registry.
- `modules/registry.ts` — the list of feature modules (id, title, description, page component).
- `modules/<feature>/` — each module's pages/components/hooks (e.g. `production/ProductionPage.tsx`).
- `components/` — shared UI (`Layout` = registry-driven sidebar shell; `BridgeStatus` = `invoke` health).
- `lib/api.ts` — typed wrappers over `invoke` (components depend on this, not raw command strings).
- `lib/queryClient.ts` — shared TanStack Query client.

Styling is Tailwind v4 via `@tailwindcss/vite` (`@import "tailwindcss"` in `src/index.css`). Tests are
Vitest (jsdom), config in `vite.config.ts`, setup in `src/test/setup.ts`. To test code that calls
`invoke`, mock `@tauri-apps/api/core` (see `src/lib/api.test.ts`).

## EVE domain notes

- **SDE** (what a blueprint produces and its material inputs): download the Fuzzwork prebuilt SQLite
  (`sqlite-latest.sqlite.bz2`) on first run. Key tables: `industryActivityMaterials` (inputs,
  `activityID=1` manufacturing, `8` invention), `industryActivityProducts` (output type + qty),
  `industryActivityProbabilities` (invention chance), `invTypes` (names/groups).
- **ESI** (`https://esi.evetech.net`): `/characters/{id}/assets/` and `/blueprints/` (gives ME/TE/runs;
  paginated via `X-Pages`), `/markets/prices/` (global adjusted/average for the job-fee basis),
  `/markets/{region}/orders/?type_id=` and `/markets/{region}/history/?type_id=` for The Forge
  (region `10000002`, Jita), `/industry/systems/` (per-system cost index). Respect cache headers and
  the `X-Esi-Error-Limit-*` budget (back off when low).
- **SSO**: OAuth2 PKCE against `login.eveonline.com/v2/oauth/{authorize,token}`; access token is a JWT
  (parse `character_id`/name); refresh token stored in the OS keychain via the `keyring` crate.
- **Profit / EIV** (per blueprint, ME, runs):
  - `required_qty(mat) = max(runs, ceil(base_qty * runs * (1 - ME/100)))` (min 1 per run)
  - `material_cost = Σ required_qty * price(mat)` using a configurable price vector
  - `job_fee = (Σ base_qty * adjusted_price) * system_cost_index * (1 + facility_tax)`
  - `profit = product_qty * product_price − material_cost − job_fee`; also margin % and per-unit
  - **T2** adds invention EV: `invention_cost / (success_probability × runs_per_success)` (#9).
  - **T3/reactions** use a recursive build-vs-buy BOM (#10). Keep the engine **activity-aware and
    tree-shaped** (a build step is `(activity, inputs, output)`) so #9/#10 are additive, not rewrites.
- **Price vectors**: the market service exposes more than spot — sell-min/buy-max, daily average,
  N-day moving average, and daily volume/order_count (liquidity), with a configurable basis per role.

## Conventions

- Keep the Rust core well-commented — the maintainer is fluent in C#/Python/TS, newer to Rust.
- New cross-cutting capability → a shared service; feature-specific logic → a module. Don't reach
  around the service layer from a module.
- Expose frontend↔Rust calls through `lib/api.ts`, not inline `invoke("name")`.
