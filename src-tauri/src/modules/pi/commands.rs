//! Planetary Interaction commands. Reads the character's colonies from ESI
//! (`/characters/{id}/planets/` + per-planet detail) and joins them with SDE
//! factory schematics to show: an overview, extractor restart timers, storage
//! usage, the required-vs-available commodity balance, and the products the user
//! has "locked in".
//!
//! Requires the `esi-planets.manage_planets.v1` scope (must be enabled on the EVE
//! app + a re-login before this returns data).

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

use crate::esi::{authed_get, AuthState};
use crate::sde::{PlanetSchematic, Sde};
use crate::storage;

/// Persisted list of "locked in" produced type ids.
const LOCKED_LIST: &str = "pi_locked";

// --- Raw ESI shapes ---

#[derive(Debug, Deserialize)]
struct EsiColony {
    planet_id: i64,
    solar_system_id: i64,
    planet_type: String,
    upgrade_level: i64,
    num_pins: i64,
}

#[derive(Debug, Deserialize)]
struct EsiPlanet {
    #[serde(default)]
    pins: Vec<EsiPin>,
}

#[derive(Debug, Deserialize)]
struct EsiPin {
    #[allow(dead_code)]
    pin_id: i64,
    type_id: i64,
    #[serde(default)]
    schematic_id: Option<i64>,
    /// When an extractor's current program started — with `expiry_time` this
    /// gives the program's total length (for the elapsed/remaining bar).
    #[serde(default)]
    install_time: Option<String>,
    /// When an extractor's current program ends (needs restart). Present on
    /// extractor pins.
    #[serde(default)]
    expiry_time: Option<String>,
    #[serde(default)]
    contents: Vec<EsiContent>,
    #[serde(default)]
    extractor_details: Option<EsiExtractor>,
}

#[derive(Debug, Deserialize)]
struct EsiContent {
    type_id: i64,
    amount: i64,
}

#[derive(Debug, Deserialize)]
struct EsiExtractor {
    #[serde(default)]
    product_type_id: Option<i64>,
    #[serde(default)]
    cycle_time: Option<i64>,
    #[serde(default)]
    qty_per_cycle: Option<i64>,
}

// --- View shapes (to the frontend) ---

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtractorView {
    pub product_type_id: i64,
    pub product: String,
    pub qty_per_cycle: i64,
    pub cycle_time: i64,
    /// ISO time the current extraction program started (bar total = expiry − start).
    pub install_time: Option<String>,
    /// ISO time the current extraction program ends (the restart timer).
    pub expiry_time: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContentRow {
    pub type_id: i64,
    pub name: String,
    pub amount: i64,
    pub volume: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StorageView {
    pub name: String,
    pub used_volume: f64,
    pub capacity: f64,
    pub contents: Vec<ContentRow>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BalanceRow {
    pub type_id: i64,
    pub name: String,
    pub produced_per_hour: f64,
    pub consumed_per_hour: f64,
    /// produced − consumed; negative = deficit (extract/import more).
    pub net: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProducedItem {
    pub type_id: i64,
    pub name: String,
    pub locked: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ColonyView {
    pub character_id: i64,
    pub character_name: String,
    pub planet_id: i64,
    pub system_id: i64,
    pub system_name: String,
    pub planet_type: String,
    pub upgrade_level: i64,
    pub pin_count: i64,
    pub extractors: Vec<ExtractorView>,
    pub storage: Vec<StorageView>,
    pub balance: Vec<BalanceRow>,
    pub produced: Vec<ProducedItem>,
    /// True if any extractor program has ended or any commodity is in deficit.
    pub needs_attention: bool,
}

/// Per-hour produced/consumed totals per commodity across a colony. Pure so the
/// balance maths can be unit-tested without ESI/SDE. Factories consume their
/// schematic inputs and produce its outputs over `cycle_time`; extractors add
/// `qty_per_cycle` of their product over their own cycle. Returns
/// `type_id -> (produced_per_hour, consumed_per_hour)`.
fn per_hour_balance(
    factories: &[&PlanetSchematic],
    extractors: &[(i64, i64, i64)], // (product_type_id, qty_per_cycle, cycle_time_secs)
) -> HashMap<i64, (f64, f64)> {
    let mut bal: HashMap<i64, (f64, f64)> = HashMap::new();
    for s in factories {
        if s.cycle_time <= 0 {
            continue;
        }
        let per_hour = 3600.0 / s.cycle_time as f64;
        for &(tid, qty) in &s.inputs {
            bal.entry(tid).or_default().1 += qty as f64 * per_hour;
        }
        for &(tid, qty) in &s.outputs {
            bal.entry(tid).or_default().0 += qty as f64 * per_hour;
        }
    }
    for &(product, qty, cycle) in extractors {
        if cycle <= 0 {
            continue;
        }
        bal.entry(product).or_default().0 += qty as f64 * (3600.0 / cycle as f64);
    }
    bal
}

fn now_rfc3339_cmp(expiry: &str) -> bool {
    // A cheap "has this ISO instant passed?" — lexicographic compare works for
    // UTC RFC3339 (both Z-suffixed, same width). Good enough for the flag.
    let now = chrono_like_now();
    expiry <= now.as_str()
}

/// Current UTC time as an RFC3339 string (seconds precision, `Z`). Avoids adding
/// a date crate: derive from the unix epoch.
fn chrono_like_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    // Convert epoch seconds → civil date (days since 1970) using Howard Hinnant's
    // algorithm, then format. Only used for a coarse "expired?" comparison.
    let days = (secs / 86_400) as i64;
    let rem = secs % 86_400;
    let (y, m, d) = civil_from_days(days);
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}Z",
        y,
        m,
        d,
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// days since 1970-01-01 → (year, month, day). Hinnant's civil_from_days.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = (if mp < 10 { mp + 3 } else { mp - 9 }) as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

/// Colonies overview with extractor timers, storage usage, and the balance.
/// Fans out over [`storage::target_characters`] so "All characters" merges
/// every roster member's colonies; a character whose ESI fetch fails is
/// skipped rather than failing the whole call.
#[tauri::command]
pub async fn pi_overview(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
) -> Result<Vec<ColonyView>, crate::model::AppError> {
    let (dir, sde) = crate::sde::dir_and_sde(&app)?;
    let character_ids = storage::target_characters(&dir);
    if character_ids.is_empty() {
        return Err(crate::model::AppError::auth_required());
    }

    let schematics = sde.planet_schematics().map_err(|e| e.to_string())?;
    let systems = sde.solar_system_info().map_err(|e| e.to_string())?;
    let locked: HashSet<i64> = storage::load_id_list(&dir, LOCKED_LIST)
        .into_iter()
        .collect();
    let names = storage::character_names(&dir);

    let mut views = Vec::new();
    for character_id in character_ids {
        let character_name = names
            .get(&character_id)
            .cloned()
            .unwrap_or_else(|| format!("Character {character_id}"));

        let colonies: Vec<EsiColony> = match authed_get(
            &auth_state,
            character_id,
            &format!("/latest/characters/{character_id}/planets/"),
        )
        .await
        {
            Ok(colonies) => colonies,
            Err(_) => continue,
        };

        for c in &colonies {
            let planet: EsiPlanet = match authed_get(
                &auth_state,
                character_id,
                &format!("/latest/characters/{character_id}/planets/{}/", c.planet_id),
            )
            .await
            {
                Ok(planet) => planet,
                Err(_) => continue,
            };

            if let Ok(view) = build_colony(
                c,
                &planet,
                &schematics,
                &systems,
                &sde,
                &locked,
                character_id,
                &character_name,
            ) {
                views.push(view);
            }
        }
    }
    Ok(views)
}

/// Assemble one colony's view (splits ESI + SDE joins from the async fetch).
#[allow(clippy::too_many_arguments)]
fn build_colony(
    colony: &EsiColony,
    planet: &EsiPlanet,
    schematics: &HashMap<i64, PlanetSchematic>,
    systems: &HashMap<i64, (String, f64, String)>,
    sde: &Sde,
    locked: &HashSet<i64>,
    character_id: i64,
    character_name: &str,
) -> Result<ColonyView, String> {
    // Classify pins: extractor (has extractor_details), factory (has schematic),
    // else storage-like (command centre / storage / launchpad).
    let factories: Vec<&PlanetSchematic> = planet
        .pins
        .iter()
        .filter_map(|p| p.schematic_id.and_then(|s| schematics.get(&s)))
        .collect();

    let extractor_tuples: Vec<(i64, i64, i64)> = planet
        .pins
        .iter()
        .filter_map(|p| p.extractor_details.as_ref())
        .filter_map(|e| {
            Some((
                e.product_type_id?,
                e.qty_per_cycle.unwrap_or(0),
                e.cycle_time.unwrap_or(0),
            ))
        })
        .collect();

    let balance_raw = per_hour_balance(&factories, &extractor_tuples);

    // Gather every type id we need names/dims for.
    let mut needed: HashSet<i64> = HashSet::new();
    needed.extend(balance_raw.keys().copied());
    for p in &planet.pins {
        for ct in &p.contents {
            needed.insert(ct.type_id);
        }
        needed.insert(p.type_id);
        if let Some(e) = &p.extractor_details {
            if let Some(t) = e.product_type_id {
                needed.insert(t);
            }
        }
    }
    let ids: Vec<i64> = needed.iter().copied().collect();
    let names = sde.type_name_map(&ids).map_err(|e| e.to_string())?;
    let dims = sde.types_dims(&ids).map_err(|e| e.to_string())?;
    let name_of = |id: i64| names.get(id);
    let volume_of = |id: i64| dims.get(&id).map(|(v, _)| *v).unwrap_or(0.0);

    // Extractors (with restart timers).
    let extractors: Vec<ExtractorView> = planet
        .pins
        .iter()
        .filter_map(|p| p.extractor_details.as_ref().map(|e| (p, e)))
        .filter_map(|(p, e)| {
            let product = e.product_type_id?;
            Some(ExtractorView {
                product_type_id: product,
                product: name_of(product),
                qty_per_cycle: e.qty_per_cycle.unwrap_or(0),
                cycle_time: e.cycle_time.unwrap_or(0),
                install_time: p.install_time.clone(),
                expiry_time: p.expiry_time.clone(),
            })
        })
        .collect();

    // Storage-like pins (have capacity, aren't extractor/factory).
    let storage: Vec<StorageView> = planet
        .pins
        .iter()
        .filter(|p| p.extractor_details.is_none() && p.schematic_id.is_none())
        .map(|p| {
            let capacity = dims.get(&p.type_id).map(|(_, c)| *c).unwrap_or(0.0);
            let contents: Vec<ContentRow> = p
                .contents
                .iter()
                .map(|ct| ContentRow {
                    type_id: ct.type_id,
                    name: name_of(ct.type_id),
                    amount: ct.amount,
                    volume: ct.amount as f64 * volume_of(ct.type_id),
                })
                .collect();
            let used_volume = contents.iter().map(|c| c.volume).sum();
            StorageView {
                name: name_of(p.type_id),
                used_volume,
                capacity,
                contents,
            }
        })
        .collect();

    // Balance rows, sorted worst-deficit first.
    let mut balance: Vec<BalanceRow> = balance_raw
        .iter()
        .map(|(&tid, &(prod, cons))| BalanceRow {
            type_id: tid,
            name: name_of(tid),
            produced_per_hour: prod,
            consumed_per_hour: cons,
            net: prod - cons,
        })
        .collect();
    balance.sort_by(|a, b| {
        a.net
            .partial_cmp(&b.net)
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    // Produced items = factory outputs (what this colony makes), with lock state.
    let mut produced_ids: Vec<i64> = factories
        .iter()
        .flat_map(|s| s.outputs.iter().map(|(t, _)| *t))
        .collect();
    produced_ids.sort_unstable();
    produced_ids.dedup();
    let produced: Vec<ProducedItem> = produced_ids
        .into_iter()
        .map(|t| ProducedItem {
            type_id: t,
            name: name_of(t),
            locked: locked.contains(&t),
        })
        .collect();

    // "Needs attention" = an extractor program has ended and wants a restart.
    // A running colony normally shows negative balance rows (intermediates are
    // consumed as fast as they're made; import-fed inputs read as deficits), so
    // net<0 is NOT an alarm — it's shown in the balance table for information only.
    let needs_attention = extractors.iter().any(|e| {
        e.expiry_time
            .as_deref()
            .map(now_rfc3339_cmp)
            .unwrap_or(false)
    });

    let system_name = systems
        .get(&colony.solar_system_id)
        .map(|(n, _, _)| n.clone())
        .unwrap_or_else(|| format!("System {}", colony.solar_system_id));

    Ok(ColonyView {
        character_id,
        character_name: character_name.to_string(),
        planet_id: colony.planet_id,
        system_id: colony.solar_system_id,
        system_name,
        planet_type: colony.planet_type.clone(),
        upgrade_level: colony.upgrade_level,
        pin_count: colony.num_pins,
        extractors,
        storage,
        balance,
        produced,
        needs_attention,
    })
}

/// Route the character to the colony's system in-game. ESI's `/ui/openwindow/
/// information/` endpoint only accepts character/corporation/alliance target
/// ids (CCP never extended it to planets or systems — esi-issues#358), so a
/// Show Info window for a planet or system isn't something ESI can open; the
/// closest *working* hook is setting the autopilot destination to the system.
/// Requires `esi-ui.write_waypoint.v1`.
#[tauri::command]
pub async fn pi_show_in_game(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
    system_id: i64,
) -> Result<(), crate::model::AppError> {
    let (_, character_id) = storage::dir_and_primary_character(&app)?;
    crate::esi::set_autopilot_waypoint(&auth_state, character_id, system_id)
        .await
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// The type ids the user has locked in as "produced by PI".
#[tauri::command]
pub fn pi_locked_get(app: AppHandle) -> Result<Vec<i64>, String> {
    let dir = crate::storage::app_data_dir(&app)?;
    Ok(storage::load_id_list(&dir, LOCKED_LIST))
}

/// Replace the locked-in produced type ids.
#[tauri::command]
pub fn pi_locked_set(app: AppHandle, type_ids: Vec<i64>) -> Result<(), String> {
    let dir = crate::storage::app_data_dir(&app)?;
    storage::save_id_list(&dir, LOCKED_LIST, &type_ids)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn schem(
        id: i64,
        cycle: i64,
        inputs: Vec<(i64, i64)>,
        outputs: Vec<(i64, i64)>,
    ) -> PlanetSchematic {
        PlanetSchematic {
            schematic_id: id,
            name: format!("S{id}"),
            cycle_time: cycle,
            inputs,
            outputs,
        }
    }

    #[test]
    fn balance_nets_production_against_consumption() {
        // A factory turning 2x P1(#100) into 1x P2(#200) each 1800s (2/hour).
        let f = schem(1, 1800, vec![(100, 2)], vec![(200, 1)]);
        // An extractor pulling 6000 P0(#10) per 3600s cycle.
        let ext = [(10i64, 6000i64, 3600i64)];
        let bal = per_hour_balance(&[&f], &ext);

        // P1 consumed 2*2/hr = 4; produced 0 → deficit.
        assert_eq!(bal[&100], (0.0, 4.0));
        // P2 produced 1*2/hr = 2; consumed 0.
        assert_eq!(bal[&200], (2.0, 0.0));
        // P0 extracted 6000/hr.
        assert_eq!(bal[&10], (6000.0, 0.0));
    }

    #[test]
    fn zero_cycle_is_ignored() {
        let f = schem(1, 0, vec![(100, 2)], vec![(200, 1)]);
        assert!(per_hour_balance(&[&f], &[(10, 5, 0)]).is_empty());
    }

    #[test]
    fn civil_date_roundtrips_epoch() {
        // 2021-01-01T00:00:00Z is 18628 days after epoch.
        assert_eq!(civil_from_days(18628), (2021, 1, 1));
        assert_eq!(civil_from_days(0), (1970, 1, 1));
    }
}
