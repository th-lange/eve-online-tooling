//! Shopping Lists — named groups of items + quantities you assemble while
//! browsing other modules.
//!
//! A *group* is a flat collection of lists. Two lists are built in and can't be
//! removed: `default` and `production`. Every other module (Market Search,
//! Production, Station Trading, Daytrading) can push an item onto any list via
//! the `shopping_add_item` command, so the lists act as a shared cart.
//!
//! Storage is a single JSON document in the app data dir (see [`commands`]);
//! item *names* are resolved from the SDE on read so they follow SDE updates,
//! mirroring [`crate::lists`].

pub mod commands;
