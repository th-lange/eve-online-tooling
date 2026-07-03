//! Offline wormhole **system** reference (#305): per-J-system statics (which
//! wormhole types a system always spawns) — the community-compiled data the SDE
//! and ESI don't carry. System **class** comes from the SDE at runtime; each
//! static is resolved to its code + physics via the SDE wormhole-type table (#304).
//!
//! Feature-specific → it lives in the wormholes module (per CLAUDE.md's
//! service-vs-module split). The snapshot is sourced from the MIT-licensed
//! exodus4d/Pathfinder export and produced by `scripts/gen-wh-systems.mjs` — a
//! manual, pre-tag step (see `data/README.md`), never run by the app/release
//! build. The committed gzip is `include_bytes!`d, so a broken/blocked fetch can
//! never break a build.

use std::collections::HashMap;
use std::io::Read;
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

use crate::sde::{wormhole_class_label, Sde, WormholeType};

/// Gzipped JSON snapshot: system id (as string) -> raw entry.
static SNAPSHOT_GZ: &[u8] = include_bytes!("data/wh_systems.json.gz");

/// One raw snapshot entry as stored in the committed JSON. Statics/wanderers are
/// wormhole **type ids** (resolved to codes + physics at runtime via the SDE);
/// class/effect are optional overrides (class is otherwise read from the SDE).
#[derive(Debug, Clone, Default, Deserialize)]
struct RawSystem {
    #[serde(default)]
    class: Option<i64>,
    #[serde(default)]
    effect: Option<String>,
    #[serde(default)]
    statics: Vec<i64>,
    #[serde(default)]
    wanderers: Vec<i64>,
}

/// The decompressed snapshot, indexed by system id. Built once (`OnceLock`).
fn snapshot() -> &'static HashMap<i64, RawSystem> {
    static CACHE: OnceLock<HashMap<i64, RawSystem>> = OnceLock::new();
    CACHE.get_or_init(|| parse_snapshot(SNAPSHOT_GZ).unwrap_or_default())
}

/// Decompress + parse the gzipped `{ "<systemId>": entry }` JSON into an id→entry
/// map. Pure over its bytes (testable); a bad/empty asset yields an empty map.
fn parse_snapshot(gz: &[u8]) -> Option<HashMap<i64, RawSystem>> {
    let mut buf = String::new();
    flate2::read::GzDecoder::new(gz)
        .read_to_string(&mut buf)
        .ok()?;
    let raw: HashMap<String, RawSystem> = serde_json::from_str(&buf).ok()?;
    Some(
        raw.into_iter()
            .filter_map(|(id, r)| id.parse::<i64>().ok().map(|id| (id, r)))
            .collect(),
    )
}

/// One static/wanderer wormhole of a system, resolved to its physics.
#[derive(Debug, Clone, Serialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StaticRef {
    pub type_id: i64,
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
    /// Whether the system was present in the statics snapshot.
    pub found: bool,
    pub system_id: i64,
    pub class: Option<i64>,
    pub class_label: Option<String>,
    pub effect: Option<String>,
    pub statics: Vec<StaticRef>,
    pub wanderers: Vec<StaticRef>,
}

/// Resolve a wormhole type id to a display ref via the SDE type map. Pure.
fn resolve_type(type_id: i64, types: &HashMap<i64, WormholeType>) -> StaticRef {
    match types.get(&type_id) {
        Some(w) => StaticRef {
            type_id,
            code: w.code.clone(),
            dest_class_id: w.dest_class_id,
            dest_class_label: w.dest_class_label.clone(),
            max_stable_mass: w.max_stable_mass,
            max_jump_mass: w.max_jump_mass,
            lifetime_min: w.max_stable_time_min,
        },
        None => StaticRef {
            type_id,
            code: String::new(),
            dest_class_id: 0,
            dest_class_label: "unknown".to_string(),
            max_stable_mass: None,
            max_jump_mass: None,
            lifetime_min: None,
        },
    }
}

/// Merge a snapshot entry with the SDE type physics map + an SDE-derived class
/// fallback. Pure (testable): resolves each static/wanderer type id to its code,
/// destination class and mass/lifetime; class prefers the snapshot then the SDE.
fn resolve(
    system_id: i64,
    entry: &RawSystem,
    types: &HashMap<i64, WormholeType>,
    sde_class: Option<i64>,
) -> SystemReference {
    let class = entry.class.or(sde_class);
    SystemReference {
        found: true,
        system_id,
        class,
        class_label: class.map(wormhole_class_label),
        effect: entry.effect.clone(),
        statics: entry
            .statics
            .iter()
            .map(|&t| resolve_type(t, types))
            .collect(),
        wanderers: entry
            .wanderers
            .iter()
            .map(|&t| resolve_type(t, types))
            .collect(),
    }
}

/// The reference view for a system: snapshot statics merged with SDE type physics,
/// plus the SDE-derived class (from `mapLocationWormholeClasses`) so k-space /
/// un-snapshotted systems still report their class.
pub fn system_reference(sde: &Sde, system_id: i64) -> Result<SystemReference, String> {
    let types: HashMap<i64, WormholeType> = sde
        .wormhole_types()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|w| (w.type_id, w))
        .collect();
    let sde_class = sde
        .wormhole_system_class(system_id)
        .map_err(|e| e.to_string())?;
    // Effect isn't in the statics snapshot; derive it from the star type (#314).
    // Swallow any SDE-variant error so a missing column never breaks the call.
    let sde_effect = sde.system_effect(system_id).ok().flatten();

    match snapshot().get(&system_id) {
        Some(entry) => {
            let mut r = resolve(system_id, entry, &types, sde_class);
            if r.effect.is_none() {
                r.effect = sde_effect;
            }
            Ok(r)
        }
        None => Ok(SystemReference {
            found: false,
            system_id,
            class: sde_class,
            class_label: sde_class.map(wormhole_class_label),
            effect: sde_effect,
            statics: Vec::new(),
            wanderers: Vec::new(),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn seed_snapshot_parses_with_statics() {
        // The committed dataset has systems keyed by id, each with static type ids.
        let snap = snapshot();
        assert!(!snap.is_empty(), "snapshot should not be empty");
        assert!(
            snap.values().any(|e| !e.statics.is_empty()),
            "at least one system should carry statics",
        );
    }

    fn type_map() -> HashMap<i64, WormholeType> {
        let mut m = HashMap::new();
        m.insert(
            34140,
            WormholeType {
                type_id: 34140,
                code: "N766".into(),
                dest_class_id: 2,
                dest_class_label: "C2".into(),
                max_stable_mass: Some(2_000_000_000.0),
                max_jump_mass: Some(300_000_000.0),
                max_stable_time_min: Some(1440.0),
                mass_regen: Some(0.0),
            },
        );
        m
    }

    #[test]
    fn resolve_merges_static_type_ids_with_physics() {
        let entry = RawSystem {
            class: Some(4),
            effect: Some("Pulsar".into()),
            statics: vec![34140, 99999], // one known, one unknown type id
            wanderers: vec![],
        };
        let r = resolve(31002604, &entry, &type_map(), Some(4));
        assert_eq!(r.class_label.as_deref(), Some("C4"));
        assert_eq!(r.effect.as_deref(), Some("Pulsar"));
        assert_eq!(r.statics.len(), 2);
        assert_eq!(r.statics[0].code, "N766");
        assert_eq!(r.statics[0].dest_class_label, "C2");
        assert_eq!(r.statics[0].max_jump_mass, Some(300_000_000.0));
        // Unknown type id degrades gracefully.
        assert_eq!(r.statics[1].dest_class_label, "unknown");
        assert_eq!(r.statics[1].code, "");
    }

    #[test]
    fn class_falls_back_to_sde_when_snapshot_omits_it() {
        let entry = RawSystem {
            class: None,
            statics: vec![34140],
            ..Default::default()
        };
        let r = resolve(31002604, &entry, &type_map(), Some(3));
        assert_eq!(r.class, Some(3));
        assert_eq!(r.class_label.as_deref(), Some("C3"));
    }
}
