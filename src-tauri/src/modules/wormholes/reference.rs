//! Offline wormhole **system** reference (#305): per-J-system class / effect /
//! statics, sourced from the community Anoik.is dataset (which the SDE and ESI
//! don't carry). The snapshot is bundled gzipped and decompressed once; each
//! static code is resolved to its physics via the SDE wormhole-type table (#304).
//!
//! Feature-specific → it lives in the wormholes module (per CLAUDE.md's
//! service-vs-module split). Only a small seed ships today; the full ~2,600-system
//! file is produced by `scripts/gen-wh-systems.mjs` once the dataset is
//! sourced + license-cleared (the #305 hitl step).

use std::collections::HashMap;
use std::io::Read;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use crate::sde::{wormhole_class_label, Sde, WormholeType};

/// Gzipped JSON snapshot: system name ("Thera"/"J100744") -> raw entry.
static SNAPSHOT_GZ: &[u8] = include_bytes!("data/wh_systems.json.gz");

/// One raw snapshot entry as stored in the committed JSON.
#[derive(Debug, Clone, Deserialize)]
struct RawSystem {
    #[serde(rename = "systemId")]
    system_id: i64,
    #[serde(default)]
    class: Option<i64>,
    #[serde(default)]
    effect: Option<String>,
    #[serde(default)]
    statics: Vec<String>,
    #[serde(default)]
    wanderers: Vec<String>,
}

/// A snapshot entry keyed by system id, carrying its display name.
#[derive(Debug, Clone)]
struct SystemEntry {
    name: String,
    class: Option<i64>,
    effect: Option<String>,
    statics: Vec<String>,
    wanderers: Vec<String>,
}

/// The decompressed snapshot, indexed by system id. Built once (`OnceLock`).
fn snapshot() -> &'static HashMap<i64, SystemEntry> {
    static CACHE: OnceLock<HashMap<i64, SystemEntry>> = OnceLock::new();
    CACHE.get_or_init(|| parse_snapshot(SNAPSHOT_GZ).unwrap_or_default())
}

/// Decompress + parse the gzipped name→entry JSON into an id→entry map. Pure over
/// its bytes (testable); a bad/empty asset yields an empty map rather than panic.
fn parse_snapshot(gz: &[u8]) -> Option<HashMap<i64, SystemEntry>> {
    let mut buf = String::new();
    flate2::read::GzDecoder::new(gz).read_to_string(&mut buf).ok()?;
    let raw: HashMap<String, RawSystem> = serde_json::from_str(&buf).ok()?;
    Some(
        raw.into_iter()
            .map(|(name, r)| {
                (
                    r.system_id,
                    SystemEntry {
                        name,
                        class: r.class,
                        effect: r.effect,
                        statics: r.statics,
                        wanderers: r.wanderers,
                    },
                )
            })
            .collect(),
    )
}

/// One static wormhole of a system, resolved to its physics.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StaticRef {
    pub code: String,
    pub dest_class_id: i64,
    pub dest_class_label: String,
    pub max_stable_mass: Option<f64>,
    pub max_jump_mass: Option<f64>,
    pub lifetime_min: Option<f64>,
}

/// The reference view of a solar system: its class/effect and resolved statics.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SystemReference {
    /// Whether the system was present in the snapshot (else only class is filled).
    pub found: bool,
    pub system_id: i64,
    pub name: String,
    pub class: Option<i64>,
    pub class_label: Option<String>,
    pub effect: Option<String>,
    pub statics: Vec<StaticRef>,
    pub wanderers: Vec<String>,
}

/// Merge a snapshot entry with the SDE wormhole-type physics map. Pure (testable):
/// resolves each static code to its destination class + mass/lifetime.
fn resolve(system_id: i64, entry: &SystemEntry, types: &HashMap<String, WormholeType>) -> SystemReference {
    let statics = entry
        .statics
        .iter()
        .map(|code| match types.get(&code.to_ascii_uppercase()) {
            Some(w) => StaticRef {
                code: code.clone(),
                dest_class_id: w.dest_class_id,
                dest_class_label: w.dest_class_label.clone(),
                max_stable_mass: w.max_stable_mass,
                max_jump_mass: w.max_jump_mass,
                lifetime_min: w.max_stable_time_min,
            },
            None => StaticRef {
                code: code.clone(),
                dest_class_id: 0,
                dest_class_label: "unknown".to_string(),
                max_stable_mass: None,
                max_jump_mass: None,
                lifetime_min: None,
            },
        })
        .collect();
    SystemReference {
        found: true,
        system_id,
        name: entry.name.clone(),
        class: entry.class,
        class_label: entry.class.map(wormhole_class_label),
        effect: entry.effect.clone(),
        statics,
        wanderers: entry.wanderers.clone(),
    }
}

/// The reference view for a system: snapshot class/effect/statics merged with SDE
/// type physics. When the system isn't in the snapshot, still return its class
/// from the SDE (`mapLocationWormholeClasses`) so k-space / un-snapshotted holes
/// aren't blank.
pub fn system_reference(sde: &Sde, system_id: i64) -> Result<SystemReference, String> {
    let types: HashMap<String, WormholeType> = sde
        .wormhole_types()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|w| (w.code.to_ascii_uppercase(), w))
        .collect();

    if let Some(entry) = snapshot().get(&system_id) {
        return Ok(resolve(system_id, entry, &types));
    }

    // Not in the snapshot: fall back to the SDE class only.
    let class = sde.wormhole_system_class(system_id).map_err(|e| e.to_string())?;
    Ok(SystemReference {
        found: false,
        system_id,
        name: String::new(),
        class,
        class_label: class.map(wormhole_class_label),
        effect: None,
        statics: Vec::new(),
        wanderers: Vec::new(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_snapshot_parses_and_contains_thera() {
        let snap = snapshot();
        let thera = snap.get(&31000005).expect("Thera in seed");
        assert_eq!(thera.name, "Thera");
        assert_eq!(thera.class, Some(12));
        assert!(thera.statics.is_empty());
    }

    #[test]
    fn resolve_merges_static_codes_with_physics() {
        let mut types = HashMap::new();
        types.insert(
            "N766".to_string(),
            WormholeType {
                type_id: 30832,
                code: "N766".into(),
                dest_class_id: 2,
                dest_class_label: "C2".into(),
                max_stable_mass: Some(2_000_000_000.0),
                max_jump_mass: Some(300_000_000.0),
                max_stable_time_min: Some(1440.0),
                mass_regen: Some(0.0),
            },
        );
        let entry = SystemEntry {
            name: "J100744".into(),
            class: Some(4),
            effect: Some("Pulsar".into()),
            statics: vec!["n766".into(), "X999".into()], // lower-case + an unknown code
            wanderers: vec![],
        };
        let r = resolve(31000744, &entry, &types);
        assert_eq!(r.class_label.as_deref(), Some("C4"));
        assert_eq!(r.effect.as_deref(), Some("Pulsar"));
        assert_eq!(r.statics.len(), 2);
        // Known code resolves (case-insensitively) to its physics.
        assert_eq!(r.statics[0].dest_class_label, "C2");
        assert_eq!(r.statics[0].max_jump_mass, Some(300_000_000.0));
        // Unknown code degrades gracefully.
        assert_eq!(r.statics[1].dest_class_label, "unknown");
        assert_eq!(r.statics[1].max_jump_mass, None);
    }
}
