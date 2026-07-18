//! Pochven — entry/logistics helpers (epic #417). `candidates` holds the
//! curated C729 exit-system data (from Electus Matari); `engine` is the pure
//! graph/search core (Dijkstra, Steiner tree, scan order); `commands` is the
//! thin Tauri layer that resolves state, calls the engine, and shapes the
//! responses.

mod candidates;
pub mod commands;
mod engine;
