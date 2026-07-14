//! PVP module — paste pilot names, profile their PvP threat from zKillboard.
//!
//! Slice 1 (#532): shared name→id resolution + per-pilot **general stats** from
//! zKill (`/stats/characterID/{id}/`) — ships & ISK destroyed/lost, solo vs
//! gang, danger. Later slices add each pilot's most-used hulls (#533), their
//! lost fits (#534), dogma-engine fit analysis (#535), and community-typical
//! fits for hulls they fly but haven't lost (#536).

pub mod commands;
