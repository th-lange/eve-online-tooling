//! Mass Production (#883) — paste a list of blueprint names you own, and get
//! the materials to buy to run every owned copy, bucketed into Multibuy-ready
//! shopping-list groups.
//!
//! Pure reuse of existing services: [`crate::esi::commands::owned_blueprints_core`]
//! for real ME/runs across the whole roster + corp hangars,
//! [`crate::sde::Sde::blueprint_materials`] for the bill of materials, and
//! [`crate::modules::production::required_quantity`] for the same ME-rounding
//! formula Production and the MCP `production_profit` capability use. The
//! only new logic here is the per-copy summation (never averaged) and the
//! `invGroups.groupName` bucketing.

pub mod commands;
