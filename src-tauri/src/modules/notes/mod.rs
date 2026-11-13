//! Notes — simple documents (text, Markdown) and tables (CSV), organised in
//! named, nestable folders, taggable and fully searchable.
//!
//! Notes are plain files in a directory tree (see [`store`]). They live in the
//! shared folder configured under Settings → Sync (`<shared>/notes/`) when
//! there is one, so every device pointed at it sees the same notes, and in
//! `<app data>/notes/` otherwise.

pub mod commands;

mod store;
pub mod types;
