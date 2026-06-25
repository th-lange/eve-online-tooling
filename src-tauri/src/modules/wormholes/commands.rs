//! Wormhole mapping — a user-maintained set of system-to-system connections
//! with a mass/EOL lifecycle. Wormhole connections aren't in any API or static
//! data (they're scanned in-game), so this is local, hand-entered state with
//! automatic cleanup of dead links. Modelled on Pathfinder's `ConnectionModel`.

use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

use crate::sde::{Sde, SdePaths};
use crate::storage;

const STORE_KEY: &str = "wh_connections";
/// J-space (wormhole) solar systems start at this id.
const WSPACE_MIN_SYSTEM_ID: i64 = 31_000_000;
/// Drop a wormhole this many hours after creation (max life is ~24h + jitter).
const WH_MAX_AGE_HOURS: u64 = 48;
/// Drop an EOL-flagged wormhole this many hours after it was marked (EOL holes
/// collapse within ~4h).
const EOL_GRACE_HOURS: u64 = 4;

/// A stored connection between two systems.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct Connection {
    id: i64,
    source_system_id: i64,
    target_system_id: i64,
    /// "wormhole" | "stargate" | "jumpbridge".
    scope: String,
    /// Wormhole mass status: "fresh" | "reduced" | "critical".
    mass_status: String,
    /// Largest ship that can jump it: "s" | "m" | "l" | "xl".
    jump_mass: String,
    /// End-of-life flagged.
    eol: bool,
    /// Endpoint signature codes (e.g. "K162" ↔ a specific WH code).
    source_sig: Option<String>,
    target_sig: Option<String>,
    created_at: u64,
    eol_updated_at: Option<u64>,
}

/// What the frontend sends to create a connection.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewConnection {
    pub source_system_id: i64,
    pub target_system_id: i64,
    #[serde(default = "default_scope")]
    pub scope: String,
    #[serde(default)]
    pub source_sig: Option<String>,
    #[serde(default)]
    pub target_sig: Option<String>,
}
fn default_scope() -> String {
    "wormhole".to_string()
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
    pub created_at: u64,
}

fn now_secs() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
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

fn load(app: &AppHandle) -> Result<(std::path::PathBuf, Vec<Connection>), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let conns: Vec<Connection> = storage::load_data(&dir, STORE_KEY).unwrap_or_default();
    Ok((dir, prune(conns, now_secs())))
}

fn views(dir: &std::path::Path, conns: &[Connection]) -> Result<Vec<ConnectionView>, String> {
    let sde = Sde::open(&SdePaths::new(dir.to_path_buf()).db).map_err(|e| e.to_string())?;
    let info = sde.solar_system_info().map_err(|e| e.to_string())?;
    let name = |id: i64| info.get(&id).map(|(n, _, _)| n.clone()).unwrap_or_else(|| format!("J{id}"));
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
            created_at: c.created_at,
        })
        .collect())
}

fn save_and_view(dir: &std::path::Path, conns: &[Connection]) -> Result<Vec<ConnectionView>, String> {
    storage::save_data(dir, STORE_KEY, &conns.to_vec())?;
    views(dir, conns)
}

/// Current connections (auto-pruned of dead wormholes), with system names.
#[tauri::command]
pub fn wh_connections(app: AppHandle) -> Result<Vec<ConnectionView>, String> {
    let (dir, conns) = load(&app)?;
    save_and_view(&dir, &conns)
}

/// Add a connection. New wormholes start fresh, full mass, not EOL.
#[tauri::command]
pub fn wh_add_connection(
    app: AppHandle,
    connection: NewConnection,
) -> Result<Vec<ConnectionView>, String> {
    let (dir, mut conns) = load(&app)?;
    let id = conns.iter().map(|c| c.id).max().unwrap_or(0) + 1;
    conns.push(Connection {
        id,
        source_system_id: connection.source_system_id,
        target_system_id: connection.target_system_id,
        scope: connection.scope,
        mass_status: "fresh".to_string(),
        jump_mass: "xl".to_string(),
        eol: false,
        source_sig: connection.source_sig,
        target_sig: connection.target_sig,
        created_at: now_secs(),
        eol_updated_at: None,
    });
    save_and_view(&dir, &conns)
}

/// Update a connection's mass/jump-mass/EOL/signatures. Setting EOL stamps the
/// time so the lifecycle can collapse it after the grace window.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub fn wh_update_connection(
    app: AppHandle,
    id: i64,
    mass_status: String,
    jump_mass: String,
    eol: bool,
    source_sig: Option<String>,
    target_sig: Option<String>,
) -> Result<Vec<ConnectionView>, String> {
    let (dir, mut conns) = load(&app)?;
    if let Some(c) = conns.iter_mut().find(|c| c.id == id) {
        if eol && !c.eol {
            c.eol_updated_at = Some(now_secs());
        } else if !eol {
            c.eol_updated_at = None;
        }
        c.mass_status = mass_status;
        c.jump_mass = jump_mass;
        c.eol = eol;
        c.source_sig = source_sig;
        c.target_sig = target_sig;
    }
    save_and_view(&dir, &conns)
}

/// Delete a connection.
#[tauri::command]
pub fn wh_delete_connection(app: AppHandle, id: i64) -> Result<Vec<ConnectionView>, String> {
    let (dir, mut conns) = load(&app)?;
    conns.retain(|c| c.id != id);
    save_and_view(&dir, &conns)
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
            Connection { scope: "stargate".into(), created_at: now - 100 * 3600, ..wh(5, 0, false, 0, now) }, // permanent → keep
        ];
        let kept: Vec<i64> = prune(conns, now).into_iter().map(|c| c.id).collect();
        assert_eq!(kept, vec![1, 4, 5]);
    }
}
