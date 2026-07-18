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
  `http://localhost:8765/callback`, scopes `publicData`, `esi-assets.read_assets.v1`,
  `esi-characters.read_blueprints.v1`. Native PKCE flow — no client secret.

## Architecture

The big idea: **feature modules reuse shared services.** Adding a feature (daytrading,
station-trading, …) = one Rust submodule under `src-tauri/src/modules/` exposing its commands, plus
one entry in `src/modules/registry.ts`. The sidebar nav and routes are generated from that registry,
so the UI wires itself up.

### Rust core (`src-tauri/src/`)

- `lib.rs` — Tauri builder: registers plugins and the `invoke_handler`. Module map lives here.
- `commands.rs` — thin command layer bridging the frontend `invoke()` to services.
- Shared services (all implemented; reused by every feature module):
  - `esi/` — EVE SSO (PKCE) auth + rate-limit/error-budget-aware ESI HTTP client with ETag
    conditional caching + endpoint wrappers
  - `sde/` — Static Data Export: bootstrap (md5-gated daily refresh) + query the Fuzzwork SQLite
  - `market/` — pricing: Fuzzwork market **aggregates** (`fuzzwork.rs`) for bulk per region/station
    prices + volume, ESI `/markets/prices` for the adjusted/EIV basis, plus a per-item ESI
    orders/history path; regions/hubs + `Location` in `markets.rs`; TTL cache
  - `model/` — shared domain types
  - `storage/` — OS keychain (refresh tokens + Tripwire password) + on-disk cache
  - `zkill/` — shared zKillboard HTTP client (kill/loss lookups; used by pvp + localintel)
  - `util/` — cross-cutting helpers (`time`: epoch-now, civil-date math, RFC-3339 parsing)
  - `lists.rs` — shared persisted type-id lists (blacklist/favorites) reused across modules
  - `evescout` — EVE-Scout public Thera/Turnur wormhole connections
- `modules/` — the feature modules (24 today: production, trading, fitting, wormholes, PI, the DPS
  meter, …), each exposing its own commands. See `src/modules/registry.ts` for the full list. The
  mapping to `src/modules/registry.ts` entries isn't strictly 1:1: some frontend modules are views
  over a shared service (`universe` → `sde`, `market-search` → `market`), some frontend modules
  share one Rust module (`incursions` + `faction-warfare` → `modules/intel`; `transactions` →
  `modules/accounting`), and some frontend modules are backend-free static pages (`exploration`,
  `support`).

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
  (`latest-sqlite.db.gz`, gzip) on first run. Key tables: `industryActivityMaterials` (inputs,
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

## Dependencies

- `allowScripts` in `package.json` pins `esbuild@0.27.7` as an intentional re-approval gate: it is
  version-pinned (not a range) so a future esbuild bump does not silently re-enable postinstall
  scripts for a new version — bumping the pin requires a deliberate review and re-approval.

## Conventions

- Keep the Rust core well-commented — the maintainer is fluent in C#/Python/TS, newer to Rust.
- New cross-cutting capability → a shared service; feature-specific logic → a module. Don't reach
  around the service layer from a module.
- Expose frontend↔Rust calls through `lib/api.ts`, not inline `invoke("name")`.
- Tauri command naming: every command a module exposes uses one stable prefix unique to that
  module (e.g. `orders_*`, `trading_*`, `accounting_*`, `localintel_*`, `intel_*`, `route_*`,
  `appraisal_*`, `notifications_*`). Shared-service prefixes (`market_`, `sde_`, `auth_`) are
  reserved for services, not feature modules — a module never claims a service's prefix even if
  it only calls that service. `wh_`, `lp_`, `dps_`, and `pi_` are exempted as already-established
  module abbreviations predating this policy; leave them as-is.
