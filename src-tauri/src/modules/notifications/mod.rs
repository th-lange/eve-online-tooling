//! Notifications — the character's in-game notification feed (war decs,
//! structure attacks, industry/PI events, insurance, corp mail, …), humanised
//! and categorised, with local per-notification dismissal.
//!
//! Requires the `esi-characters.read_notifications.v1` scope (must be enabled on
//! the EVE app + a re-login before this returns data).

pub mod commands;
