//! Feature modules. Each exposes its own Tauri commands and reuses the shared
//! services (`esi`, `sde`, `market`, `model`, `storage`).

pub mod daytrading;
pub mod production;
pub mod reprocessing;
pub mod trading;
