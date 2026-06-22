# eve-online-tooling

A standalone cross-platform desktop app (Linux / macOS / Windows) for [EVE Online](https://www.eveonline.com/),
built as a set of feature **modules** over a shared service layer.

- **Production** *(in progress)* — log in a character, read assets & blueprints, fetch live market
  prices, and rank what you can manufacture by build-vs-buy **profit**.
- **Daytrading**, **station-trading**, **mission-running** — planned.

Built with **Tauri 2** (Rust core) + **React / TypeScript** (Vite). Market and character data come
from EVE's **ESI** API; blueprint/material data from the **SDE**.

## Quick start

```bash
# Prerequisites (Linux): Node + npm, Rust (rustup), and WebView/build libs:
sudo apt-get install -y libwebkit2gtk-4.1-dev build-essential curl wget file \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev pkg-config

npm install            # frontend deps
npm run tauri dev      # run the desktop app
npm run test           # frontend unit tests (Vitest)
cd src-tauri && cargo test   # Rust unit tests
```

To use SSO you'll need a developer application from
[developers.eveonline.com](https://developers.eveonline.com) (Client ID + loopback callback).

See [`CLAUDE.md`](./CLAUDE.md) for architecture, the full command list, and EVE domain notes.

## Status

Early scaffold. Work is tracked as
[GitHub issues](https://github.com/th-lange/eve-online-tooling/issues) (`afk` = mergeable without a
human, `hitl` = needs a human).
