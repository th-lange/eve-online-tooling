//! Feature modules. Each exposes its own Tauri commands and reuses the shared
//! services (`esi`, `sde`, `market`, `model`, `storage`).

pub mod accounting;
pub mod appraisal;
pub mod assets;
pub mod character;
pub mod contracts;
pub mod daytrading;
pub mod industry;
pub mod localintel;
pub mod lpstore;
pub mod orders;
pub mod production;
pub mod reprocessing;
pub mod route;
pub mod trading;
pub mod wormholes;
