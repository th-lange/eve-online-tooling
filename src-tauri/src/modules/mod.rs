//! Feature modules. Each exposes its own Tauri commands and reuses the shared
//! services (`esi`, `sde`, `market`, `model`, `storage`).

pub mod accounting;
pub mod appraisal;
pub mod assets;
pub mod character;
pub mod contracts;
pub mod daytrading;
pub mod dpsmeter;
pub mod fitting;
pub mod industry;
pub mod intel;
pub mod localintel;
pub mod lpstore;
pub mod notifications;
pub mod orders;
pub mod pi;
pub mod pochven;
pub mod production;
pub mod pvp;
pub mod reprocessing;
pub mod route;
pub mod scripts;
pub mod shopping;
pub mod trading;
pub mod wormholes;
