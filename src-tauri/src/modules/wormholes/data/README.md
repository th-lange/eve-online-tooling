# Wormhole system statics snapshot

`wh_systems.json.gz` maps each J-system id → the wormhole **type ids** it always
spawns (its "statics"). This is community-compiled data that the EVE SDE and ESI
do **not** carry. It's bundled gzipped and `include_bytes!`d by
`../reference.rs`; the type ids are resolved to codes + physics at runtime from
the SDE (#304), and system **class** is read from the SDE too — so this file
stays tiny and independent of SDE versions.

## Source & license

- **Source:** [exodus4d/Pathfinder](https://github.com/exodus4d/pathfinder) —
  `export/csv/system_static.csv`.
- **License:** MIT — redistribution is permitted with attribution. See NOTICE below.
- **Snapshot pulled:** 2026-07-01 (2,604 systems / 3,772 statics).

### NOTICE (attribution required by MIT)

> Static wormhole data derived from exodus4d/Pathfinder.
> MIT License — Copyright (c) 2017 Mark Friedrich.
> https://github.com/exodus4d/pathfinder

## Refreshing (manual, before tagging a release)

This is a **manual step and is intentionally not part of the app or release
build** — so if the upstream source changes shape or goes offline, a release
build still succeeds against the last committed snapshot. Re-run it and review
the diff before tagging when you want fresher statics:

```
npm run gen:wh-systems            # pulls the default Pathfinder CSV
# or point at a different export:
node scripts/gen-wh-systems.mjs <sourceCsvUrl>
```

Then:

1. Review the `wh_systems.json.gz` diff (system/static counts are printed).
2. Update the **snapshot pulled** date + counts above.
3. `cd src-tauri && cargo test` (the loader tests read this file).
4. Commit the regenerated snapshot with the doc update, then tag.

### Effect (not yet sourced)

System **effect** (Pulsar / Wolf-Rayet / …) isn't in Pathfinder's CSV or the
SDE dogma; the loader carries an optional `effect` field but it's currently
empty. Deriving it (from the system's star type) or sourcing it is a follow-up.
