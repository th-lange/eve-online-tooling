# Development

Everything you need to build, run and release **eve-online-tooling** from
source. For what the app *is* and how to install a prebuilt binary, see the
[README](https://github.com/th-lange/eve-online-tooling/blob/main/README.md).

Built with **Tauri 2** (Rust core) + **React / TypeScript** (Vite). Market and
character data come from EVE's **ESI** API; blueprint/material data from the
**SDE**.

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

The first time you open the Production module it downloads the EVE **SDE** (a
few hundred MB, Fuzzwork's SQLite build) into your app data dir; that's a
one-off.

> **No audio / `GStreamer element appsink not found` on Linux?** The WebView
> plays audio (the Scripts `play_sound`) through GStreamer. A **snap** terminal
> (e.g. Alacritty-as-snap) exports `GST_PLUGIN_SYSTEM_PATH` / `GST_PLUGIN_SCANNER`
> / `LD_LIBRARY_PATH` pointing at its own sandbox, which lacks those plugins. The
> app now strips those snap paths at startup so audio works regardless; if you
> still hit it (an unusual snap layout), launch from a non-snap terminal or run:
> `env -u GST_PLUGIN_SYSTEM_PATH -u GST_PLUGIN_SCANNER -u GST_PLUGIN_PATH_1_0 -u LD_LIBRARY_PATH npm run tauri dev`.

### 4. (Later) EVE SSO

Reading character assets/blueprints needs a developer application from
[developers.eveonline.com](https://developers.eveonline.com) — a **Client ID**
and the loopback callback **`http://localhost:8765/callback`**. Not required for
the market/production calculations, which use public data.

## Common commands

| Command | What it does |
| --- | --- |
| `npm run tauri dev` | Run the desktop app (hot reload) |
| `npm run tauri build` | Build distributable bundles |
| `npm run build` | Type-check + build the frontend |
| `npm run test` | Frontend unit tests (Vitest) |
| `cd src-tauri && cargo test` | Rust unit tests |

See [`CLAUDE.md`](https://github.com/th-lange/eve-online-tooling/blob/main/CLAUDE.md) for architecture and EVE domain notes, and the
other docs for subsystems: [plugins](plugins.md), [scripts](scripts.md),
[MCP](mcp.md).

## Implementation notes

- **App shell** — Tauri 2 + React/TS, module-based navigation. The sidebar
  groups modules into labelled sections (Industry · Trading · Market · Character
  · Combat/Intel · Support), with drag-to-reorder, pinning and per-module colour
  tags. A **⌘K / Ctrl+K command palette** fuzzy-jumps to any module and looks up
  any item type (routing to Market Search).
- **SDE service** — download/verify the Fuzzwork SQLite; query blueprint
  materials, products, and type info. The static data only re-downloads when
  Fuzzwork's published md5 changes, with a best-effort daily check on startup.
- **Market service** — live ESI prices as a multi-vector model (spot sell/buy,
  daily average, N-day moving average, volume), cached.
- **Conditional ESI caching** — all ESI traffic flows through one client that
  revalidates with **ETags** (cheap `304 Not Modified`), honours each response's
  cache timer, persists across restarts, and backs off ESI's error budget. Data
  pages show an "Updated N ago" freshness label.
- **Production engine** — ME-adjusted material cost + EIV job fee + revenue →
  profit/margin/per-unit, with recursive build-vs-buy down the component tree,
  T2 invention (datacores + job fee + BPC copy, over success probability), T3
  relics, and a per-material drill-down. Validated against EVE-Guru-style output.
- **Fitting engine** — a data-driven dogma engine validated exact against PYFA
  across a golden test suite (DPS, ranges, EHP/resists, cap sim, speed/align,
  targeting; implants/boosters, T3 subsystems, projected effects).
- **EVE SSO (multi-character)** — OAuth2 PKCE; each refresh token in the OS
  keychain, roster persisted across restarts.

## Releasing

Installers are produced by the **Release** GitHub Actions workflow
(`.github/workflows/release.yml`). To cut a release:

1. Bump the version everywhere at once: `scripts/bump-version.sh 0.25.0` (edits
   `package.json`, `src-tauri/Cargo.toml`, `src-tauri/tauri.conf.json` and
   regenerates both lockfiles). Review the diff.
2. Commit, then tag and push:
   `git commit -am "chore(release): v0.25.0" && git tag v0.25.0 && git push origin main --tags`.

The workflow builds **Windows** installers on every tag; **macOS** (universal)
and **Linux** join in on minor releases (`vX.Y.0`) or a manual run with
`all_platforms`. It attaches the installers to the GitHub Release for that tag,
then fills in the release notes with the changelog and the unsigned-build note
(see [`SIGNING.md`](https://github.com/th-lange/eve-online-tooling/blob/main/SIGNING.md)).

## Status & tracking

Work is tracked as
[GitHub issues](https://github.com/th-lange/eve-online-tooling/issues)
(`afk` = mergeable without a human, `hitl` = needs a human).
