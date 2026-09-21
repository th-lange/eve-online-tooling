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
- **Merge with auto-merge, gated on CI:** enable it with
  `gh pr merge <n> --auto --merge --delete-branch` so the PR lands
  automatically once the required status checks pass. **Do not bypass checks**
  with `--admin` (or by force-merging) — let CI gate every merge, releases
  included.
- Keep each branch/PR focused on one logical change where practical.
- **Releases follow the same path:** bump the version on a branch, open a PR,
  auto-merge it once green, then tag `vX.Y.Z` on the resulting `main` commit
  and push the tag.

## Everything else

See [CLAUDE.md](CLAUDE.md) for the stack, build/test/type-check commands,
architecture (feature modules over shared services), EVE domain notes, and the
Tauri command naming policy.
