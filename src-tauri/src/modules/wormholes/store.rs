//! Persistence for the wormhole connection map: the `Connection` type, its
//! load/save lifecycle (with automatic pruning of dead holes), and the
//! `connection_edges` view consumed by the Route module.
//!
//! `pub(crate)`, not `pub`: this is crate-internal shared data, not a curated
//! cross-crate API. Only two modules touch it today (Wormholes' own commands,
//! and Route's "nearest wormhole" lookup). Promote it to a root-level shared
//! service (the `lists.rs` pattern) only if a third module ever needs the
//! connection-edges data — don't do that promotion preemptively.

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::sde::{Sde, SdePaths};
use crate::storage;

const STORE_KEY: &str = "wh_connections";
/// J-space (wormhole) solar systems start at this id.
pub(crate) const WSPACE_MIN_SYSTEM_ID: i64 = 31_000_000;
/// Drop a wormhole this many hours after creation (max life is ~24h + jitter).
const WH_MAX_AGE_HOURS: u64 = 48;
/// Drop an EOL-flagged wormhole this many hours after it was marked (EOL holes
/// collapse within ~4h).
const EOL_GRACE_HOURS: u64 = 4;

/// A stored connection between two systems.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub(crate) struct Connection {
    pub(crate) id: i64,
    pub(crate) source_system_id: i64,
    pub(crate) target_system_id: i64,
    /// "wormhole" | "stargate" | "jumpbridge".
    pub(crate) scope: String,
    /// Wormhole mass status: "fresh" | "reduced" | "critical".
    pub(crate) mass_status: String,
    /// Largest ship that can jump it: "s" | "m" | "l" | "xl".
    pub(crate) jump_mass: String,
    /// End-of-life flagged.
    pub(crate) eol: bool,
    /// Endpoint signature codes (e.g. "K162" ↔ a specific WH code).
    pub(crate) source_sig: Option<String>,
    pub(crate) target_sig: Option<String>,
    /// Where this row came from: "manual" (hand-entered) or "evescout"
    /// (auto-imported from the EVE-Scout Thera/Turnur feed). Defaulted so
    /// connections stored before this field existed still load.
    #[serde(default = "default_source")]
    pub(crate) source: String,
    pub(crate) created_at: u64,
    pub(crate) eol_updated_at: Option<u64>,
}

fn default_source() -> String {
    "manual".to_string()
}

/// A connection enriched with system names for display.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionView {
    pub id: i64,
    pub source_system_id: i64,
    pub source_name: String,
    pub source_wspace: bool,
    pub target_system_id: i64,
    pub target_name: String,
    pub target_wspace: bool,
    pub scope: String,
    pub mass_status: String,
    pub jump_mass: String,
    pub eol: bool,
    pub source_sig: Option<String>,
    pub target_sig: Option<String>,
    /// "manual" | "evescout" — lets the UI badge auto-imported rows.
    pub source: String,
    pub created_at: u64,
}

/// Drop dead wormholes: past max age, or EOL beyond the grace window. Stargate /
/// jumpbridge links are permanent and never pruned. Pure for testability.
fn prune(mut conns: Vec<Connection>, now: u64) -> Vec<Connection> {
    conns.retain(|c| {
        if c.scope != "wormhole" {
            return true; // permanent connections
        }
        let age_h = now.saturating_sub(c.created_at) / 3600;
        if age_h >= WH_MAX_AGE_HOURS {
            return false;
        }
        if c.eol {
            if let Some(t) = c.eol_updated_at {
                if now.saturating_sub(t) / 3600 >= EOL_GRACE_HOURS {
                    return false;
                }
            }
        }
        true
    });
    conns
}

/// Load the stored connections (auto-pruned of dead wormholes), alongside the
/// app data dir the caller will need to save back into.
pub(crate) fn load(app: &AppHandle) -> Result<(std::path::PathBuf, Vec<Connection>), String> {
    let dir = crate::storage::app_data_dir(app)?;
    let conns: Vec<Connection> = storage::load_data(&dir, STORE_KEY).unwrap_or_default();
    Ok((dir, prune(conns, crate::util::time::now_secs())))
}

fn views(dir: &std::path::Path, conns: &[Connection]) -> Result<Vec<ConnectionView>, String> {
    let sde = Sde::open(&SdePaths::new(dir.to_path_buf()).db).map_err(|e| e.to_string())?;
    let info = sde.solar_system_info().map_err(|e| e.to_string())?;
    let name = |id: i64| {
        info.get(&id)
            .map(|(n, _, _)| n.clone())
            .unwrap_or_else(|| format!("J{id}"))
    };
    Ok(conns
        .iter()
        .map(|c| ConnectionView {
            id: c.id,
            source_system_id: c.source_system_id,
            source_name: name(c.source_system_id),
            source_wspace: c.source_system_id >= WSPACE_MIN_SYSTEM_ID,
            target_system_id: c.target_system_id,
            target_name: name(c.target_system_id),
            target_wspace: c.target_system_id >= WSPACE_MIN_SYSTEM_ID,
            scope: c.scope.clone(),
            mass_status: c.mass_status.clone(),
            jump_mass: c.jump_mass.clone(),
            eol: c.eol,
            source_sig: c.source_sig.clone(),
            target_sig: c.target_sig.clone(),
            source: c.source.clone(),
            created_at: c.created_at,
        })
        .collect())
}

/// Persist the given connection set and return the name-enriched view.
pub(crate) fn save_and_view(
    dir: &std::path::Path,
    conns: &[Connection],
) -> Result<Vec<ConnectionView>, String> {
    storage::save_data(dir, STORE_KEY, &conns.to_vec())?;
    views(dir, conns)
}

/// Undirected wormhole/stargate edges from the stored map, for cross-module
/// routing (the Route module's "nearest wormhole"). Returns `(a, b, eol)` per
/// mapped connection, already auto-pruned of dead holes.
pub(crate) fn connection_edges(app: &AppHandle) -> Result<Vec<(i64, i64, bool)>, String> {
    let (_dir, conns) = load(app)?;
    Ok(conns
        .iter()
        .map(|c| (c.source_system_id, c.target_system_id, c.eol))
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn wh(id: i64, age_h: u64, eol: bool, eol_age_h: u64, now: u64) -> Connection {
        Connection {
            id,
            source_system_id: 31000001,
            target_system_id: 30000142,
            scope: "wormhole".into(),
            mass_status: "fresh".into(),
            jump_mass: "xl".into(),
            eol,
            source_sig: None,
            target_sig: None,
            source: "manual".into(),
            created_at: now - age_h * 3600,
            eol_updated_at: eol.then(|| now - eol_age_h * 3600),
        }
    }

    #[test]
    fn prunes_dead_wormholes_keeps_permanent() {
        let now = 1_000_000;
        let conns = vec![
            wh(1, 1, false, 0, now),  // fresh wormhole → keep
            wh(2, 60, false, 0, now), // 60h old → drop (past max age)
            wh(3, 2, true, 5, now),   // EOL 5h ago → drop (past grace)
            wh(4, 2, true, 1, now),   // EOL 1h ago → keep (within grace)
            Connection {
                scope: "stargate".into(),
                created_at: now - 100 * 3600,
                ..wh(5, 0, false, 0, now)
            }, // permanent → keep
        ];
        let kept: Vec<i64> = prune(conns, now).into_iter().map(|c| c.id).collect();
        assert_eq!(kept, vec![1, 4, 5]);
    }
}
