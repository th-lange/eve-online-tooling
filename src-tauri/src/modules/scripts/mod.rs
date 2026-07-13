//! Scripts — author, store, and run small user-written snippets.
//!
//! A script is a Rhai or JavaScript snippet run on demand or on a timed loop
//! (the loop is a single Rust background timeline — see [`scheduler`]). Unlike
//! precompiled WASM in a capability sandbox — scripts are the user's own code
//! and get a curated, trusted host API ([`host`]): market/SDE reads, the active
//! character's assets, a desktop notification, a private key/value store, and
//! `log()`. Every run is still resource-bounded ([`engine::Limits`]) so a
//! runaway snippet errors out instead of hanging the app.

pub mod commands;

mod engine;
pub mod examples;
mod host;
mod js_engine;
mod rhai_engine;
pub mod scheduler;
mod store;
pub mod types;
