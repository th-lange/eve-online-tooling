//! Wormhole mapping — a user-maintained set of system-to-system connections
//! with a mass/EOL lifecycle. Wormhole connections aren't in any API or static
//! data (they're scanned in-game), so this is local, hand-entered state with
//! automatic cleanup of dead links. Modelled on Pathfinder's `ConnectionModel`.

use std::collections::{HashMap, HashSet, VecDeque};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::sde::{Sde, SdePaths};
use crate::storage;

use super::tripwire;

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
    /// Where this row came from: "manual" (hand-entered) or "evescout"
    /// (auto-imported from the EVE-Scout Thera/Turnur feed). Defaulted so
    /// connections stored before this field existed still load.
    #[serde(default = "default_source")]
    source: String,
    created_at: u64,
    eol_updated_at: Option<u64>,
}

fn default_source() -> String {
    "manual".to_string()
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
    /// "manual" | "evescout" — lets the UI badge auto-imported rows.
    pub source: String,
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
    let dir = crate::storage::app_data_dir(app)?;
    let conns: Vec<Connection> = storage::load_data(&dir, STORE_KEY).unwrap_or_default();
    Ok((dir, prune(conns, now_secs())))
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

fn save_and_view(
    dir: &std::path::Path,
    conns: &[Connection],
) -> Result<Vec<ConnectionView>, String> {
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
        source: "manual".to_string(),
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

// --- Signature paste (#104) ---

/// One scanned signature.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Signature {
    pub id: String,
    pub group: String,
    pub sig_type: String,
    pub name: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SignatureScan {
    pub signatures: Vec<Signature>,
    /// Sig ids new since the last paste.
    pub added: Vec<String>,
    /// Sig ids that disappeared since the last paste.
    pub removed: Vec<String>,
}

/// EVE signature id format: `ABC-123`.
fn is_sig_id(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 7
        && b[0..3].iter().all(|c| c.is_ascii_alphabetic())
        && b[3] == b'-'
        && b[4..7].iter().all(|c| c.is_ascii_digit())
}

/// Parse the in-game probe-scanner clipboard (tab-separated:
/// `id  group  type  name  signal  distance`). Keeps only real signature rows,
/// deduped by id. Pure (testable).
fn parse_signatures(text: &str) -> Vec<Signature> {
    let mut seen = HashSet::new();
    text.lines()
        .filter_map(|line| {
            let cols: Vec<&str> = line.split('\t').collect();
            let id = cols.first()?.trim();
            if !is_sig_id(id) || !seen.insert(id.to_string()) {
                return None;
            }
            Some(Signature {
                id: id.to_string(),
                group: cols.get(1).unwrap_or(&"").trim().to_string(),
                sig_type: cols.get(2).unwrap_or(&"").trim().to_string(),
                name: cols.get(3).unwrap_or(&"").trim().to_string(),
            })
        })
        .collect()
}

fn sig_key(system_id: i64) -> String {
    format!("wh_sigs_{system_id}")
}

/// Paste a scanner result for a system: store it, return the new set plus the
/// added/removed diff vs the previous paste (what changed in the hole).
#[tauri::command]
pub fn wh_paste_signatures(
    app: AppHandle,
    system_id: i64,
    text: String,
) -> Result<SignatureScan, String> {
    let dir = crate::storage::app_data_dir(&app)?;
    let key = sig_key(system_id);
    let previous: Vec<Signature> = storage::load_data(&dir, &key).unwrap_or_default();
    let incoming = parse_signatures(&text);

    let prev_ids: HashSet<&str> = previous.iter().map(|s| s.id.as_str()).collect();
    let new_ids: HashSet<&str> = incoming.iter().map(|s| s.id.as_str()).collect();
    let added: Vec<String> = incoming
        .iter()
        .filter(|s| !prev_ids.contains(s.id.as_str()))
        .map(|s| s.id.clone())
        .collect();
    let removed: Vec<String> = previous
        .iter()
        .filter(|s| !new_ids.contains(s.id.as_str()))
        .map(|s| s.id.clone())
        .collect();

    storage::save_data(&dir, &key, &incoming)?;
    Ok(SignatureScan {
        signatures: incoming,
        added,
        removed,
    })
}

/// Stored signatures for a system.
#[tauri::command]
pub fn wh_signatures(app: AppHandle, system_id: i64) -> Result<Vec<Signature>, String> {
    let dir = crate::storage::app_data_dir(&app)?;
    Ok(storage::load_data(&dir, &sig_key(system_id)).unwrap_or_default())
}

// --- Cross-chain routing (#103) ---

/// How a hop is reached.
pub(crate) type Via = &'static str; // "origin" | "stargate" | "wormhole"

/// One hop on a route.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteHop {
    pub system_id: i64,
    pub name: String,
    pub security: f64,
    pub wspace: bool,
    pub via: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RouteResult {
    /// Hops origin→destination, or empty if unreachable.
    pub hops: Vec<RouteHop>,
    pub reachable: bool,
    /// Jumps (hops − 1).
    pub jumps: i64,
}

/// BFS shortest path over a unioned adjacency map. Each neighbour carries how
/// it's reached (`stargate`/`wormhole`); returns `(system, via)` from origin to
/// destination, or `None` if unreachable. Pure (testable).
pub(crate) fn shortest_path(
    adj: &HashMap<i64, Vec<(i64, Via)>>,
    origin: i64,
    dest: i64,
) -> Option<Vec<(i64, Via)>> {
    if origin == dest {
        return Some(vec![(origin, "origin")]);
    }
    let mut prev: HashMap<i64, (i64, Via)> = HashMap::new();
    let mut visited: HashSet<i64> = HashSet::from([origin]);
    let mut queue: VecDeque<i64> = VecDeque::from([origin]);
    while let Some(cur) = queue.pop_front() {
        for &(next, via) in adj.get(&cur).into_iter().flatten() {
            if visited.insert(next) {
                prev.insert(next, (cur, via)); // arrived at `next` from `cur` via `via`
                if next == dest {
                    // Walk predecessors back to origin; each node pairs with the
                    // edge used to reach it (origin → "origin").
                    let mut path = Vec::new();
                    let mut node = dest;
                    while node != origin {
                        let (p, v) = prev[&node];
                        path.push((node, v));
                        node = p;
                    }
                    path.push((origin, "origin"));
                    path.reverse();
                    return Some(path);
                }
                queue.push_back(next);
            }
        }
    }
    None
}

/// Route origin→destination over stargates unioned with mapped wormhole
/// connections. `avoid_eol` drops EOL wormholes from the graph.
#[tauri::command]
pub fn wh_route(
    app: AppHandle,
    origin_system_id: i64,
    destination_system_id: i64,
    avoid_eol: bool,
) -> Result<RouteResult, String> {
    let (_dir, conns) = load(&app)?;
    let sde = crate::sde::open_from_app(&app)?;

    // Build the unioned adjacency: stargates ∪ wormhole/jumpbridge connections.
    let mut adj: HashMap<i64, Vec<(i64, Via)>> = HashMap::new();
    for (a, b) in sde.all_stargate_edges().map_err(|e| e.to_string())? {
        adj.entry(a).or_default().push((b, "stargate"));
    }
    for c in &conns {
        if avoid_eol && c.eol {
            continue;
        }
        let via: Via = if c.scope == "stargate" {
            "stargate"
        } else {
            "wormhole"
        };
        adj.entry(c.source_system_id)
            .or_default()
            .push((c.target_system_id, via));
        adj.entry(c.target_system_id)
            .or_default()
            .push((c.source_system_id, via));
    }

    let path = shortest_path(&adj, origin_system_id, destination_system_id);
    let info = sde.solar_system_info().map_err(|e| e.to_string())?;
    match path {
        Some(p) => {
            let hops: Vec<RouteHop> = p
                .into_iter()
                .map(|(sid, via)| {
                    let (name, security, _) = info
                        .get(&sid)
                        .cloned()
                        .unwrap_or_else(|| (format!("J{sid}"), 0.0, String::new()));
                    RouteHop {
                        system_id: sid,
                        name,
                        security,
                        wspace: sid >= WSPACE_MIN_SYSTEM_ID,
                        via: via.to_string(),
                    }
                })
                .collect();
            let jumps = hops.len() as i64 - 1;
            Ok(RouteResult {
                hops,
                reachable: true,
                jumps,
            })
        }
        None => Ok(RouteResult {
            hops: Vec::new(),
            reachable: false,
            jumps: 0,
        }),
    }
}

// --- EVE-Scout auto-import (#298) ---

/// Dedupe key for a connection: unordered endpoints + the hub-side sig. Endpoints
/// are sorted so a manual A↔B hole matches an imported B↔A one.
fn dedupe_key(c: &Connection) -> (i64, i64, Option<String>) {
    let (a, b) = if c.source_system_id <= c.target_system_id {
        (c.source_system_id, c.target_system_id)
    } else {
        (c.target_system_id, c.source_system_id)
    };
    (a, b, c.source_sig.clone())
}

/// Map one EVE-Scout signature to a connection (id assigned later on merge).
/// Hub side (Thera/Turnur) is the source; the far k-space end is the target.
/// Non-wormhole signatures and rows missing an endpoint are skipped. Pure.
fn imported_connection(sig: &crate::evescout::TheraSignature, now: u64) -> Option<Connection> {
    if !sig.is_wormhole() || sig.out_system_id == 0 || sig.in_system_id == 0 {
        return None;
    }
    Some(Connection {
        id: 0,
        source_system_id: sig.out_system_id,
        target_system_id: sig.in_system_id,
        scope: "wormhole".to_string(),
        mass_status: "fresh".to_string(),
        jump_mass: crate::evescout::jump_mass_from_ship_size(sig.max_ship_size.as_deref()),
        eol: false,
        source_sig: sig.out_signature.clone(),
        target_sig: sig.in_signature.clone(),
        source: "evescout".to_string(),
        created_at: now,
        eol_updated_at: None,
    })
}

/// Merge freshly-imported connections from one auto source into the stored set:
/// keep every row from other sources untouched (manual + any other import), drop
/// all previous rows of `source_tag` (the feed is the source of truth, so vanished
/// holes disappear), and add the imported ones — skipping any that collide with a
/// kept row or each other. New ids continue past the highest existing id. Pure.
fn merge_by_source(
    existing: Vec<Connection>,
    imported: Vec<Connection>,
    source_tag: &str,
) -> Vec<Connection> {
    let mut out: Vec<Connection> = existing
        .into_iter()
        .filter(|c| c.source != source_tag)
        .collect();
    let mut keys: HashSet<(i64, i64, Option<String>)> = out.iter().map(dedupe_key).collect();
    let mut next_id = out.iter().map(|c| c.id).max().unwrap_or(0) + 1;
    for mut c in imported {
        if keys.insert(dedupe_key(&c)) {
            c.id = next_id;
            next_id += 1;
            out.push(c);
        }
    }
    out
}

/// Import live Thera/Turnur connections from EVE-Scout into the map. Manual holes
/// are preserved; previously-imported holes are refreshed from the feed. Returns
/// the merged, name-enriched connection set (same shape as `wh_connections`).
#[tauri::command]
pub async fn wh_import_evescout(app: AppHandle) -> Result<Vec<ConnectionView>, String> {
    let (dir, existing) = load(&app)?;
    let sigs = crate::evescout::fetch_signatures(&dir).await?;
    let now = now_secs();
    let imported: Vec<Connection> = sigs
        .iter()
        .filter_map(|s| imported_connection(s, now))
        .collect();
    let merged = merge_by_source(existing, imported, "evescout");
    save_and_view(&dir, &merged)
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

// --- Ship-mass jump planner (#303) ---

/// Fraction of a hole's *total* stable mass still available at each mass status.
/// EVE's bands are fresh (>50%), reduced (10–50%), critical (<10%); we take a
/// representative point in each so the budget is a sensible estimate, not a lie
/// of precision (the exact remaining mass isn't observable in-game).
fn status_remaining_fraction(mass_status: &str) -> f64 {
    match mass_status {
        "critical" => 0.10,
        "reduced" => 0.50,
        _ => 1.00, // fresh / unknown
    }
}

/// The mass verdict for pushing one hull through one hole. Pure (testable).
#[derive(Debug, PartialEq)]
struct MassBudget {
    /// The hull is within the hole's max jump mass (can pass at all).
    passes: bool,
    /// Full crossings before the estimated remaining mass is exhausted.
    remaining_crossings: i64,
    /// Crossings before the hole would drop into the critical (<10%) band.
    crossings_until_critical: i64,
    /// The very next crossing would tip it into (or past) critical.
    crit_risk: bool,
}

/// Weigh a hull against a hole: does it fit, and how many crossings remain before
/// exhaustion / criticality, given the current mass status. Pure.
fn mass_budget(
    ship_mass: f64,
    max_jump_mass: f64,
    max_stable_mass: f64,
    mass_status: &str,
) -> MassBudget {
    let passes = max_jump_mass > 0.0 && ship_mass > 0.0 && ship_mass <= max_jump_mass;
    if !passes {
        return MassBudget {
            passes: false,
            remaining_crossings: 0,
            crossings_until_critical: 0,
            crit_risk: false,
        };
    }
    let remaining = max_stable_mass * status_remaining_fraction(mass_status);
    let crit_threshold = max_stable_mass * 0.10;
    let remaining_crossings = (remaining / ship_mass).floor() as i64;
    let crossings_until_critical =
        ((remaining - crit_threshold).max(0.0) / ship_mass).floor() as i64;
    let crit_risk = remaining - ship_mass <= crit_threshold;
    MassBudget {
        passes,
        remaining_crossings,
        crossings_until_critical,
        crit_risk,
    }
}

/// The jump-planner result for the frontend.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JumpPlan {
    pub found: bool,
    /// Hint when the ship or wormhole type couldn't be resolved.
    pub message: Option<String>,
    pub ship_type_id: i64,
    pub ship_name: String,
    pub ship_mass: f64,
    pub wh_code: String,
    pub dest_class_label: String,
    pub max_jump_mass: f64,
    pub max_stable_mass: f64,
    pub mass_status: String,
    pub passes: bool,
    pub remaining_crossings: i64,
    pub crossings_until_critical: i64,
    pub crit_risk: bool,
}

fn jump_plan_none(message: &str) -> JumpPlan {
    JumpPlan {
        found: false,
        message: Some(message.to_string()),
        ship_type_id: 0,
        ship_name: String::new(),
        ship_mass: 0.0,
        wh_code: String::new(),
        dest_class_label: String::new(),
        max_jump_mass: 0.0,
        max_stable_mass: 0.0,
        mass_status: String::new(),
        passes: false,
        remaining_crossings: 0,
        crossings_until_critical: 0,
        crit_risk: false,
    }
}

/// Plan a hull's crossing of a wormhole type: resolve the hull's mass and the
/// hole's physics from the SDE (#304), then compute the mass budget. `mass_status`
/// is the observed band ("fresh"/"reduced"/"critical"); the WH code is matched
/// case-insensitively (e.g. "N766", "K162").
#[tauri::command]
pub fn wh_jump_plan(
    app: AppHandle,
    ship_type_id: i64,
    wh_type_code: String,
    mass_status: String,
) -> Result<JumpPlan, String> {
    let sde = crate::sde::open_from_app(&app)?;

    let Some((ship_name, ship_mass)) = sde.ship_mass(ship_type_id).map_err(|e| e.to_string())?
    else {
        return Ok(jump_plan_none("Unknown ship."));
    };
    let code = wh_type_code.trim();
    let wh = sde
        .wormhole_types()
        .map_err(|e| e.to_string())?
        .into_iter()
        .find(|w| w.code.eq_ignore_ascii_case(code));
    let Some(wh) = wh else {
        return Ok(jump_plan_none(&format!(
            "Unknown wormhole type \"{code}\"."
        )));
    };

    let max_jump = wh.max_jump_mass.unwrap_or(0.0);
    let max_stable = wh.max_stable_mass.unwrap_or(0.0);
    let b = mass_budget(ship_mass, max_jump, max_stable, &mass_status);
    Ok(JumpPlan {
        found: true,
        message: None,
        ship_type_id,
        ship_name,
        ship_mass,
        wh_code: wh.code,
        dest_class_label: wh.dest_class_label,
        max_jump_mass: max_jump,
        max_stable_mass: max_stable,
        mass_status,
        passes: b.passes,
        remaining_crossings: b.remaining_crossings,
        crossings_until_critical: b.crossings_until_critical,
        crit_risk: b.crit_risk,
    })
}

// --- Wormhole reference exposure (#306) ---

/// The wormhole-type reference table (code → destination class + physics), from
/// the bundled SDE (#304). Feeds the sig-code auto-fill + type table (#307).
#[tauri::command]
pub fn wh_type_reference(app: AppHandle) -> Result<Vec<crate::sde::WormholeType>, String> {
    let sde = crate::sde::open_from_app(&app)?;
    sde.wormhole_types().map_err(|e| e.to_string())
}

/// A system's reference view: class / effect / statics (Anoik.is snapshot, #305)
/// with each static resolved to its physics from the SDE type table.
#[tauri::command]
pub fn wh_system_reference(
    app: AppHandle,
    system_id: i64,
) -> Result<super::reference::SystemReference, String> {
    let sde = crate::sde::open_from_app(&app)?;
    super::reference::system_reference(&sde, system_id)
}

// --- Tripwire import (#302, opt-in) ---

/// Turn a Tripwire chain (signatures + wormholes) into our connections: each
/// wormhole links two signatures, whose systems become the endpoints. Jump-mass
/// class comes from the WH type via the SDE (`jump_mass_by_code`); rows whose
/// endpoints don't resolve to a system are skipped. Pure (testable).
fn tripwire_connections(
    sigs: &[tripwire::RawSignature],
    whs: &[tripwire::RawWormhole],
    jump_mass_by_code: &HashMap<String, String>,
    now: u64,
) -> Vec<Connection> {
    let mut sig_map: HashMap<i64, (i64, Option<String>)> = HashMap::new();
    for s in sigs {
        if let Some(sys) = s.system_id.filter(|&v| v != 0) {
            let sig = s.signature_id.clone().filter(|x| !x.is_empty());
            sig_map.insert(s.id, (sys, sig));
        }
    }
    whs.iter()
        .filter_map(|w| {
            let (src_sys, src_sig) = sig_map.get(&w.initial_id)?.clone();
            let (tgt_sys, tgt_sig) = sig_map.get(&w.secondary_id)?.clone();
            let code = w.wh_type.clone().unwrap_or_default();
            let jump_mass = jump_mass_by_code
                .get(&code.to_ascii_uppercase())
                .cloned()
                .unwrap_or_else(|| "xl".to_string());
            let eol = w.life.as_deref() == Some("critical");
            Some(Connection {
                id: 0,
                source_system_id: src_sys,
                target_system_id: tgt_sys,
                scope: "wormhole".to_string(),
                mass_status: tripwire::mass_status(w.mass.as_deref()),
                jump_mass,
                eol,
                source_sig: src_sig,
                target_sig: tgt_sig,
                source: "tripwire".to_string(),
                created_at: now,
                eol_updated_at: eol.then_some(now),
            })
        })
        .collect()
}

/// Opt-in Tripwire connection status for the frontend (never returns the password).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TripwireStatus {
    pub configured: bool,
    pub base_url: String,
    pub username: String,
    pub mask: Option<String>,
}

fn tripwire_status_from(dir: &std::path::Path) -> TripwireStatus {
    let cfg: tripwire::TripwireConfig =
        storage::load_data(dir, tripwire::CONFIG_KEY).unwrap_or_default();
    let has_secret = storage::load_secret(tripwire::SECRET_KEY)
        .ok()
        .flatten()
        .is_some();
    TripwireStatus {
        configured: !cfg.username.is_empty() && has_secret,
        base_url: if cfg.base_url.is_empty() {
            tripwire::DEFAULT_BASE_URL.to_string()
        } else {
            cfg.base_url
        },
        username: cfg.username,
        mask: cfg.mask,
    }
}

/// Current Tripwire opt-in status (configured? base URL, username, mask).
#[tauri::command]
pub fn wh_tripwire_status(app: AppHandle) -> Result<TripwireStatus, String> {
    let dir = crate::storage::app_data_dir(&app)?;
    Ok(tripwire_status_from(&dir))
}

/// Opt in: store the Tripwire base URL + username (+ optional mask) and the
/// password (in the OS keychain).
#[tauri::command]
pub fn wh_tripwire_connect(
    app: AppHandle,
    base_url: String,
    username: String,
    password: String,
    mask: Option<String>,
) -> Result<TripwireStatus, String> {
    let dir = crate::storage::app_data_dir(&app)?;
    let base = base_url.trim();
    let mask = mask.map(|m| m.trim().to_string()).filter(|m| !m.is_empty());
    let cfg = tripwire::TripwireConfig {
        base_url: if base.is_empty() {
            tripwire::DEFAULT_BASE_URL.to_string()
        } else {
            base.to_string()
        },
        username: username.trim().to_string(),
        mask,
    };
    storage::save_data(&dir, tripwire::CONFIG_KEY, &cfg)?;
    storage::store_secret(tripwire::SECRET_KEY, &password)?;
    Ok(tripwire_status_from(&dir))
}

/// Opt out: clear the stored Tripwire config + keychain password.
#[tauri::command]
pub fn wh_tripwire_disconnect(app: AppHandle) -> Result<TripwireStatus, String> {
    let dir = crate::storage::app_data_dir(&app)?;
    storage::save_data(
        &dir,
        tripwire::CONFIG_KEY,
        &tripwire::TripwireConfig::default(),
    )?;
    storage::delete_secret(tripwire::SECRET_KEY)?;
    Ok(tripwire_status_from(&dir))
}

/// Import the configured Tripwire chain, merged into the map (manual + other
/// imports untouched; previous Tripwire rows refreshed). Mask defaults to the
/// active character's personal chain (`<id>.1`) when not overridden.
#[tauri::command]
pub async fn wh_tripwire_import(app: AppHandle) -> Result<Vec<ConnectionView>, String> {
    let (dir, sde) = crate::sde::dir_and_sde(&app)?;
    let cfg: tripwire::TripwireConfig =
        storage::load_data(&dir, tripwire::CONFIG_KEY).unwrap_or_default();
    if cfg.username.is_empty() {
        return Err("Connect Tripwire first".to_string());
    }
    let password = storage::load_secret(tripwire::SECRET_KEY)?
        .ok_or_else(|| "Connect Tripwire first".to_string())?;
    let mask = cfg
        .mask
        .clone()
        .or_else(|| storage::primary_character(&dir).map(|id| format!("{id}.1")))
        .ok_or_else(|| "No Tripwire mask set and no active character to derive one".to_string())?;

    let (sigs, whs) = tripwire::fetch(&cfg, &password, &mask).await?;

    let jump_mass_by_code: HashMap<String, String> = sde
        .wormhole_types()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|w| {
            (
                w.code.to_ascii_uppercase(),
                tripwire::jump_mass_class(w.max_jump_mass),
            )
        })
        .collect();

    let (_dir, existing) = load(&app)?;
    let imported = tripwire_connections(&sigs, &whs, &jump_mass_by_code, now_secs());
    let merged = merge_by_source(existing, imported, "tripwire");
    save_and_view(&dir, &merged)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tripwire_maps_wormholes_to_connections() {
        let sigs = vec![
            tripwire::RawSignature {
                id: 5,
                signature_id: Some("ABC".into()),
                system_id: Some(31000005),
            },
            tripwire::RawSignature {
                id: 6,
                signature_id: Some("DEF".into()),
                system_id: Some(30000142),
            },
            tripwire::RawSignature {
                id: 7,
                signature_id: None,
                system_id: None,
            }, // unresolved endpoint
        ];
        let whs = vec![
            tripwire::RawWormhole {
                initial_id: 5,
                secondary_id: 6,
                wh_type: Some("N766".into()),
                life: Some("critical".into()),
                mass: Some("destab".into()),
            },
            tripwire::RawWormhole {
                initial_id: 5,
                secondary_id: 7, // sig 7 has no system → skipped
                wh_type: Some("K162".into()),
                life: Some("stable".into()),
                mass: Some("stable".into()),
            },
        ];
        let mut jm = HashMap::new();
        jm.insert("N766".to_string(), "l".to_string());

        let conns = tripwire_connections(&sigs, &whs, &jm, 100);
        assert_eq!(conns.len(), 1);
        let c = &conns[0];
        assert_eq!(c.source_system_id, 31000005);
        assert_eq!(c.target_system_id, 30000142);
        assert_eq!(c.source_sig.as_deref(), Some("ABC"));
        assert_eq!(c.jump_mass, "l");
        assert_eq!(c.mass_status, "reduced");
        assert!(c.eol);
        assert_eq!(c.source, "tripwire");
    }

    fn evescout_sig(out: i64, in_: i64, sig: &str, size: &str) -> crate::evescout::TheraSignature {
        crate::evescout::TheraSignature {
            signature_type: "wormhole".into(),
            out_system_id: out,
            out_system_name: "Thera".into(),
            out_signature: Some(sig.into()),
            in_system_id: in_,
            in_system_name: "Far".into(),
            in_region_name: None,
            in_signature: Some("K162".into()),
            wh_type: Some("K162".into()),
            max_ship_size: Some(size.into()),
            remaining_hours: Some(3.0),
        }
    }

    #[test]
    fn imports_only_wormholes_and_maps_fields() {
        let s = evescout_sig(31000005, 30002086, "ABC", "large");
        let c = imported_connection(&s, 100).unwrap();
        assert_eq!(c.source_system_id, 31000005);
        assert_eq!(c.target_system_id, 30002086);
        assert_eq!(c.jump_mass, "l");
        assert_eq!(c.source, "evescout");
        assert_eq!(c.source_sig.as_deref(), Some("ABC"));

        // Non-wormhole / incomplete rows are skipped.
        let mut data = evescout_sig(31000005, 30000142, "X", "frigate");
        data.signature_type = "data".into();
        assert!(imported_connection(&data, 100).is_none());
    }

    #[test]
    fn merge_preserves_manual_and_refreshes_imports() {
        let now = 1_000_000;
        let manual = Connection {
            source: "manual".into(),
            ..wh(1, 1, false, 0, now)
        };
        // An older imported row that should be dropped and replaced by the feed.
        let stale = Connection {
            id: 2,
            source: "evescout".into(),
            source_system_id: 31000005,
            target_system_id: 39999999,
            ..wh(2, 1, false, 0, now)
        };
        let existing = vec![manual.clone(), stale];

        let imported = vec![
            imported_connection(&evescout_sig(31000005, 30002086, "ABC", "large"), now).unwrap(),
            // Duplicate of the imported one → skipped.
            imported_connection(&evescout_sig(31000005, 30002086, "ABC", "large"), now).unwrap(),
        ];

        let merged = merge_by_source(existing, imported, "evescout");
        // Manual kept, stale import gone, one fresh import added with a new id.
        assert_eq!(merged.len(), 2);
        assert!(merged.iter().any(|c| c.id == 1 && c.source == "manual"));
        let imp: Vec<&Connection> = merged.iter().filter(|c| c.source == "evescout").collect();
        assert_eq!(imp.len(), 1);
        assert_eq!(imp[0].target_system_id, 30002086);
        assert!(imp[0].id > 1);
    }

    #[test]
    fn merge_skips_import_colliding_with_manual() {
        // Manual A↔B; feed reports B↔A with the same hub sig → not duplicated.
        let manual = Connection {
            id: 7,
            source: "manual".into(),
            source_system_id: 30002086,
            target_system_id: 31000005,
            source_sig: Some("ABC".into()),
            ..wh(7, 1, false, 0, 1_000_000)
        };
        let imported =
            vec![
                imported_connection(&evescout_sig(31000005, 30002086, "ABC", "large"), 1_000_000)
                    .unwrap(),
            ];
        let merged = merge_by_source(vec![manual], imported, "evescout");
        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].source, "manual");
    }

    #[test]
    fn mass_budget_verdicts() {
        // C2 static N766: 300 Mkg jump, 2 Bkg total. A 13 Mkg cruiser passes.
        let cruiser = mass_budget(13_000_000.0, 300_000_000.0, 2_000_000_000.0, "fresh");
        assert!(cruiser.passes);
        // 2 Bkg / 13 Mkg ≈ 153 full crossings.
        assert_eq!(cruiser.remaining_crossings, 153);
        // Critical band is <10% (200 Mkg): (2000-200)/13 ≈ 138.
        assert_eq!(cruiser.crossings_until_critical, 138);
        assert!(!cruiser.crit_risk);

        // A 1.3 Bkg freighter exceeds the 300 Mkg jump limit → blocked.
        let freighter = mass_budget(1_300_000_000.0, 300_000_000.0, 2_000_000_000.0, "fresh");
        assert!(!freighter.passes);
        assert_eq!(freighter.remaining_crossings, 0);

        // Reduced hole (~50% left) roughly halves the crossings.
        let reduced = mass_budget(13_000_000.0, 300_000_000.0, 2_000_000_000.0, "reduced");
        assert_eq!(reduced.remaining_crossings, 76);

        // Critical hole: one more big-but-legal jump tips it over.
        let crit = mass_budget(150_000_000.0, 300_000_000.0, 2_000_000_000.0, "critical");
        assert!(crit.passes);
        assert!(crit.crit_risk);
    }

    #[test]
    fn parses_scanner_paste_and_filters_noise() {
        let text = "ABC-123\tCosmic Signature\tWormhole\tUnstable Wormhole\t100.0%\t1.2 AU\n\
                    header line that is not a sig\n\
                    XYZ-789\tCosmic Signature\tData\tRuined Site\t12.0%\t3 AU\n\
                    ABC-123\tdup\t\t\t\t"; // dup id ignored
        let sigs = parse_signatures(text);
        assert_eq!(sigs.len(), 2);
        assert_eq!(sigs[0].id, "ABC-123");
        assert_eq!(sigs[0].sig_type, "Wormhole");
        assert_eq!(sigs[1].id, "XYZ-789");
        assert!(!is_sig_id("nope"));
        assert!(is_sig_id("ABC-123"));
    }

    #[test]
    fn routes_over_stargates_and_wormholes() {
        // 1-2-3 by stargate; a wormhole 1↔4 lets us reach 4 in one hop.
        let mut adj: HashMap<i64, Vec<(i64, Via)>> = HashMap::new();
        adj.insert(1, vec![(2, "stargate"), (4, "wormhole")]);
        adj.insert(2, vec![(1, "stargate"), (3, "stargate")]);
        adj.insert(3, vec![(2, "stargate")]);
        adj.insert(4, vec![(1, "wormhole")]);

        let p = shortest_path(&adj, 1, 3).unwrap();
        assert_eq!(p.iter().map(|(s, _)| *s).collect::<Vec<_>>(), vec![1, 2, 3]);

        // 4 is only reachable via the wormhole edge.
        let p2 = shortest_path(&adj, 1, 4).unwrap();
        assert_eq!(p2.last().unwrap(), &(4, "wormhole"));

        // Unreachable.
        assert!(shortest_path(&adj, 1, 99).is_none());
        // Same system.
        assert_eq!(shortest_path(&adj, 5, 5).unwrap(), vec![(5, "origin")]);
    }

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
