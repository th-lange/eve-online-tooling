# AGENTS.md

Working agreement for AI agents (Claude Code and others) in this repository.
Project stack, commands, architecture, and naming conventions live in
[CLAUDE.md](CLAUDE.md) — this file covers **how we make and land changes**.

## Git workflow (required)

- **Never commit or push directly to `main`.** `main` is protected and only
  advances through merged pull requests.
- **Start every task on a fresh branch** cut from the latest `main`, named by
  intent: `feat/<slug>`, `fix/<slug>`, `chore/<slug>`, or `docs/<slug>`.
- **Land changes via a pull request** — push the branch and merge the PR; do
  not fast-forward or merge into `main` locally and push.
- **Run the full check suite locally before every commit** — never rely on CI
  to catch a formatting/lint/test failure. Match what CI runs:
  `npm run lint`, `npm run format:check`, `npm run test`, `npm run build`, and
  in `src-tauri`: `cargo fmt --check`, `cargo clippy --all-targets -- -D warnings`,
  `cargo test`. Auto-fix formatting first with `npx prettier --write .` and
  `cargo fmt`.
- **Merge with auto-merge, gated on CI:** enable it with
  `gh pr merge <n> --auto --merge --delete-branch` so the PR lands
  automatically once the required status checks pass. **Do not bypass checks**
  with `--admin` (or by force-merging) — let CI gate every merge, releases
  included.
- **Group related work into a single pull request.** Prefer one PR that covers
  a cohesive change (and its tests/docs) over many tiny PRs; don't open a
  separate PR for each small edit. Only split when the changes are genuinely
  independent.
- **Releases follow the same path:** bump the version on a branch, open a PR,
  auto-merge it once green, then tag `vX.Y.Z` on the resulting `main` commit
  and push the tag.
- **Versioning:** use semantic versioning (major.minor.patch). Small fixes,
  cleanups, and non-substantial changes are always patch releases. Features
  and bug fixes that change observable behavior are minor. Breaking changes
  are major.

## Everything else

See [CLAUDE.md](CLAUDE.md) for the stack, build/test/type-check commands,
architecture (feature modules over shared services), EVE domain notes, and the
Tauri command naming policy.
