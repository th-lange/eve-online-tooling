//! Folder-based cross-device sync (#1128) — a deliberately dumb transport: the
//! frontend decides what to import/export per module (newer-`updatedAt`-wins,
//! whole-module replace, no field merge — see `src/lib/sync/`), this module
//! just lets it read/write JSON files in a user-chosen folder.

pub mod commands;
