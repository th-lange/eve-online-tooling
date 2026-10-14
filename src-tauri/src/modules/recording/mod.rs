//! Combat recording (#1013) — actuators for the fight detection the PVP
//! overlay already provides. This app never captures video itself; it drives
//! external recorders:
//!
//! - [`commands`] slice 1 (#1014): run user-configured shell commands on fight
//!   start/end (gpu-screen-recorder, ffmpeg, OBS CLI hooks, …).
//! - slice 2 (#1015) adds a native obs-websocket client (replay buffer +
//!   record), slice 3 (#1016) clip sidecar metadata.

pub mod commands;
pub mod obs;
