# tauri-specta pilot (#589)

Spike: pilot `tauri-specta` v2 on the `orders` module (one command,
`orders_list`, one DTO, `OrderRow`) to decide whether to expand it repo-wide
or drop it. Evaluated `tauri-specta = "=2.0.0-rc.21"` /
`specta = "=2.0.0-rc.22"` / `specta-typescript = "0.0.9"` — the last
docs.rs-buildable rc line (rc.22–25 currently fail to build on docs.rs); pinned
with `=` per upstream's own guidance, since this crate is still pre-1.0 and
each rc has broken the public API.

## What shipped

- `#[specta::specta]` on `orders_list`, `#[derive(specta::Type)]` on
  `OrderRow` and `AppError` (the command's `Result<T, E>` needs both sides
  typed).
- `src-tauri/src/bindings.rs`: a **separate**, minimal `tauri_specta::Builder`
  scoped to just this one command — not a replacement for the existing
  `tauri::generate_handler!` list in `lib.rs`, which stays as the real
  runtime dispatch table for all 300+ commands. Wired into `setup()` under
  `#[cfg(debug_assertions)]` for live dev reloads, and exposed as a plain
  `#[test]` (`export_orders_bindings`) so CI/build tooling can regenerate the
  file with `cargo test` alone, without booting the Tauri app or needing
  Node on the Rust side.
- `npm run generate:bindings` chains that `cargo test` with a `prettier
  --write` pass (kept as a separate npm-side step, not a Rust-side
  `Typescript::formatter()` hook, so the Rust test itself has zero Node
  dependency and the plain `cargo test` job in CI is unaffected).
  `npm run build` now runs `generate:bindings` before `tsc && vite build`,
  so one command regenerates and typechecks.
- `src/lib/api/orders.ts` shrank from a 22-line hand-mirrored interface +
  `invoke()` call to a 15-line re-export of the generated `OrderRow` type
  plus a thin `marketOrders()` wrapper that unwraps tauri-specta's
  `Result<T, E>` return shape back into the throwing-`Promise<OrderRow[]>`
  contract the rest of the app already expects. Every other file still only
  imports from `lib/api` (verified: no importer of `lib/api/generated`
  outside `orders.ts` itself).
- CI (`frontend` job): `git diff --exit-code -- src/lib/api/generated` after
  `npm run build`, so a drifted-and-forgotten regeneration fails the build.
  This job now also installs a Rust toolchain + the Tauri Linux deps, since
  `npm run build` transitively needs `cargo` — a real cost of this design
  (see trade-offs below).

## Diff ergonomics observed

- **Net line count dropped**, but not dramatically for a single small DTO:
  the hand-written file was 31 lines: gone; the generated file is ~130 lines
  of boilerplate (imports, a `Result<T, E>` helper type, an unused-in-this-case
  event-listener factory) for one command. For a *single* command the
  generated overhead outweighs the type it replaces; the payoff compounds
  only as more commands share the same builder/boilerplate.
- **Real type-drift protection is the actual win**: today, changing
  `OrderRow`'s Rust fields silently desyncs the hand-written
  `src/lib/api/orders.ts` interface until someone notices at runtime (a
  `Result<T,E>` field mismatch has no compile-time signal on the TS side).
  With this pilot, forgetting to regenerate fails CI immediately via the
  drift check — this is the actual value proposition, not the line count.
- **`i64`/`u64` need an explicit, repo-wide decision.** Specta refuses to
  export any Rust 64-bit integer by default (`BigIntForbidden`) because
  JS `number` can silently lose precision above 2^53. This codebase's
  existing convention (every ESI id is hand-typed as TS `number`) only
  survives because IDs happen to stay inside the safe range in practice; a
  repo-wide rollout needs one global `BigIntExportBehavior` choice
  (`.bigint(BigIntExportBehavior::Number)`, matching current practice) made
  once, not per-module.
- **`Option<T>` and enums "just work".** `OrderRow::best_price: Option<f64>`
  exported as `number | null` with zero extra configuration, and
  `AppError`'s `#[serde(tag = "kind")]` enum exported as the exact
  discriminated union its hand-written callers already pattern-match on.
  `HashMap<K, V>` wasn't exercised by this module but is a documented
  first-class type in specta (exports as `Record<K, V>` / `{ [key: string]: V }`
  for string-keyed maps) — no reason to expect friction there for other
  modules.
- **Non-trivial cross-module macro-scoping gotcha.** `tauri_specta::collect_commands!`
  expands to hidden helper macros (`__cmd__*`, `__specta__fn__*`) that are
  only texually visible in the module where the command is defined —
  calling `collect_commands!` from a different module (e.g. a shared
  `bindings.rs`) hits a hard `rustc` error
  (`macro_expanded_macro_exports_accessed_by_absolute_paths`). The fix is a
  one-line `pub fn specta_commands() -> Commands<Wry>` living in each
  command module, called from the shared builder — mechanical, but a real
  per-module tax any wider rollout has to pay.
- **Ecosystem-quirk workaround baked into the emit.** `tauri-specta` always
  emits an unused `Channel` import and `__makeEvents__` helper even when a
  module registers zero events (upstream `specta-rs/tauri-specta#198`),
  which trips this repo's `noUnusedLocals`/`noUnusedParameters` tsc gate.
  Worked around with a `// @ts-nocheck` header on the generated file (the
  community-standard fix) — acceptable since the file is never hand-read for
  type errors, but it does mean tsc gives zero signal on the generated file
  itself; only its typed *exports*, consumed elsewhere, are checked.

## Recommendation: expand cautiously, module-by-module — not a blanket rollout, not a drop

The pilot outcome is net positive but not a slam dunk:

- **Keep it for `orders`** — the drift-check safety net is real and cheap
  once the one-time per-module wiring (`specta_commands()` fn,
  `specta::Type` derives, bigint policy) is paid.
- **Do not do a mechanical repo-wide migration in one PR.** 300+ commands
  means 300+ `#[specta::specta]` additions, N `specta_commands()` collector
  functions (one per module, due to the macro-scoping constraint above), and
  auditing every DTO for `i64`/`u64` fields against the bigint policy. That
  work is real but bounded and low-risk *per module* — recommend rolling it
  out module-by-module as each module is touched for other reasons, rather
  than a dedicated big-bang migration.
- **Do not keep the CI shape as-is if this expands.** Adding a Rust
  toolchain + Tauri Linux deps to the `frontend` CI job (this pilot's
  approach) works for one module's ~10s `cargo test`, but doesn't scale: a
  full-repo bindings regen means the frontend job pays close to the same
  Rust build cost the `rust` job already pays, twice. A wider rollout should
  instead move bindings generation into the `rust` job (which already has
  the toolchain) as a build artifact the `frontend` job downloads, or accept
  that `npm run build` requiring Rust is now simply a fact of this app and
  stop trying to keep the jobs independent.
- **Fix the bigint policy explicitly before expanding**, not per-module ad
  hoc — one global `.bigint(BigIntExportBehavior::Number)` call is the right
  default given every existing hand-written interface in this repo already
  assumes it.
