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
    let now = crate::util::time::format_rfc3339(crate::util::time::now_secs());
    expiry <= now.as_str()
}

/// Colonies overview with extractor timers, storage usage, and the balance.
/// Fans out over [`storage::target_characters`] so "All characters" merges
/// every roster member's colonies; a character whose ESI fetch fails is
/// skipped rather than failing the whole call. The Tauri command's core,
/// factored out so `capabilities::cap_pi_overview` can call it with a
/// [`HostCtx`](crate::capabilities::HostCtx)-supplied dir/auth instead of a
/// Tauri `AppHandle`/`State`.
pub async fn pi_overview_core(
    dir: &std::path::Path,
    sde: Sde,
    auth: &AuthState,
) -> Result<Vec<ColonyView>, crate::model::AppError> {
    let character_ids = storage::target_characters(dir);
    if character_ids.is_empty() {
        return Err(crate::model::AppError::auth_required());
    }

    let schematics = sde.planet_schematics().map_err(|e| e.to_string())?;
    let systems = crate::sde::cached_system_info(dir)?;
    let locked: HashSet<i64> = storage::load_id_list(dir, LOCKED_LIST)
        .into_iter()
        .collect();
    let names = storage::character_names(dir);

    let mut views = Vec::new();
    for character_id in character_ids {
        let character_name = names
            .get(&character_id)
            .cloned()
            .unwrap_or_else(|| format!("Character {character_id}"));

        let colonies: Vec<EsiColony> = match authed_get(
            auth,
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
                auth,
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

/// Colonies overview with extractor timers, storage usage, and the balance.
#[tauri::command]
pub async fn pi_overview(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
) -> Result<Vec<ColonyView>, crate::model::AppError> {
    let (dir, sde) = crate::sde::dir_and_sde(&app)?;
    pi_overview_core(&dir, sde, &auth_state).await
}

/// A colony's minimal "needs attention" summary — just enough to name it in
/// an alert, not the full extractor/storage/balance detail `pi_overview`
/// ships for the UI.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct IdleColony {
    pub character_id: i64,
    pub character_name: String,
    pub system_name: String,
    pub planet_type: String,
}

/// Every colony flagged `needs_attention`, trimmed down to just enough to
/// name it. Pure — a view over an already-fetched [`ColonyView`] list, so
/// it's directly unit-testable.
pub fn idle_colonies(views: &[ColonyView]) -> Vec<IdleColony> {
    views
        .iter()
        .filter(|c| c.needs_attention)
        .map(|c| IdleColony {
            character_id: c.character_id,
            character_name: c.character_name.clone(),
            system_name: c.system_name.clone(),
            planet_type: c.planet_type.clone(),
        })
        .collect()
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
    crate::esi::set_autopilot_waypoint(&auth_state, character_id, system_id).await?;
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

// --- Production-chain planner (#882) ---

/// One node of a P1–P4 commodity's production-chain tree, from the target
/// down to its P0 raw-material leaves.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChainNode {
    pub type_id: i64,
    pub name: String,
    /// 0 = a raw P0 resource (no schematic produces it), 1..=4 = P1..P4.
    pub tier: u8,
    /// How much of this node the *parent* schematic consumes per cycle; 0 for
    /// the root (nothing consumes it) and for tier-0 leaves.
    pub qty_per_cycle: i64,
    /// Planet types that alone can supply this node's whole subtree (every
    /// input available on the same planet); empty means no single planet can
    /// — the colony needs imports.
    pub planet_types: Vec<String>,
    pub children: Vec<ChainNode>,
}

/// A tree shape identical to [`ChainNode`] but keyed by type id instead of
/// name, so the recursive walk doesn't need a name lookup (and therefore
/// doesn't need to hit the SDE) per node — names for every id in the tree are
/// batch-resolved once after the shape (and `planet_types`, which only
/// depends on ids) is fully known.
struct RawNode {
    type_id: i64,
    tier: u8,
    qty_per_cycle: i64,
    planet_types: Vec<&'static str>,
    children: Vec<RawNode>,
}

/// Reverse index of `planet_schematics()`: product type id → the schematic
/// that outputs it (each PI commodity has exactly one producing schematic).
fn schematics_by_product(schematics: &HashMap<i64, PlanetSchematic>) -> HashMap<i64, i64> {
    let mut by_product = HashMap::new();
    for schematic in schematics.values() {
        for &(type_id, _) in &schematic.outputs {
            by_product.insert(type_id, schematic.schematic_id);
        }
    }
    by_product
}

/// The planet types common to every child's `planet_types` — a node's whole
/// subtree needs every input available on the *same* planet, so this is a
/// straight set intersection (empty children list ⇒ empty, since a P0 leaf
/// computes its own `planet_types` directly instead of going through this).
fn intersect_planet_types(children: &[RawNode]) -> Vec<&'static str> {
    let Some((first, rest)) = children.split_first() else {
        return Vec::new();
    };
    let mut set: HashSet<&'static str> = first.planet_types.iter().copied().collect();
    for child in rest {
        let child_set: HashSet<&'static str> = child.planet_types.iter().copied().collect();
        set.retain(|pt| child_set.contains(pt));
    }
    // Keep PLANET_TYPE_RESOURCES's declared order rather than HashSet order.
    super::planet_types::PLANET_TYPE_RESOURCES
        .iter()
        .map(|&(name, _)| name)
        .filter(|name| set.contains(name))
        .collect()
}

fn build_raw_node(
    type_id: i64,
    qty_per_cycle: i64,
    schematics: &HashMap<i64, PlanetSchematic>,
    by_product: &HashMap<i64, i64>,
) -> RawNode {
    match by_product.get(&type_id).and_then(|sid| schematics.get(sid)) {
        // No schematic produces this type — it's a raw P0 resource.
        None => RawNode {
            type_id,
            tier: 0,
            qty_per_cycle: 0,
            planet_types: super::planet_types::planet_types_for(type_id),
            children: Vec::new(),
        },
        Some(schematic) => {
            let children: Vec<RawNode> = schematic
                .inputs
                .iter()
                .map(|&(child_id, child_qty)| {
                    build_raw_node(child_id, child_qty, schematics, by_product)
                })
                .collect();
            let tier = children.iter().map(|c| c.tier).max().unwrap_or(0) + 1;
            let planet_types = intersect_planet_types(&children);
            RawNode {
                type_id,
                tier,
                qty_per_cycle,
                planet_types,
                children,
            }
        }
    }
}

fn collect_type_ids(node: &RawNode, out: &mut Vec<i64>) {
    out.push(node.type_id);
    for child in &node.children {
        collect_type_ids(child, out);
    }
}

fn to_chain_node(node: RawNode, names: &crate::sde::TypeNameMap) -> ChainNode {
    ChainNode {
        name: names.get(node.type_id),
        type_id: node.type_id,
        tier: node.tier,
        qty_per_cycle: node.qty_per_cycle,
        planet_types: node.planet_types.into_iter().map(String::from).collect(),
        children: node
            .children
            .into_iter()
            .map(|c| to_chain_node(c, names))
            .collect(),
    }
}

/// Build the [`ChainNode`] production-chain tree for a P1–P4 commodity —
/// recursively walks `planetSchematics` inputs down to P0 raw-material
/// leaves, intersecting each node's children's `planet_types` bottom-up (a
/// node's whole subtree needs every input available on the *same* planet;
/// this is what makes e.g. Robotics Plasma-only despite each individual P0
/// input being available on 2-4 planet types). Pure — testable without ESI.
pub fn production_chain(sde: &Sde, type_id: i64) -> Result<ChainNode, crate::sde::SdeError> {
    let schematics = sde.planet_schematics()?;
    let by_product = schematics_by_product(&schematics);
    let raw = build_raw_node(type_id, 0, &schematics, &by_product);
    let mut ids = Vec::new();
    collect_type_ids(&raw, &mut ids);
    let names = sde.type_name_map(&ids)?;
    Ok(to_chain_node(raw, &names))
}

/// The production-chain tree for a P1–P4 commodity: which planet type(s) can
/// produce it single-planet (no imports), and the full P0→target stage tree.
#[tauri::command]
pub fn pi_production_chain(
    app: AppHandle,
    type_id: i64,
) -> Result<ChainNode, crate::model::AppError> {
    let sde = crate::sde::open_from_app(&app)?;
    production_chain(&sde, type_id).map_err(|e| e.to_string().into())
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

    fn colony(character_id: i64, needs_attention: bool) -> ColonyView {
        ColonyView {
            character_id,
            character_name: format!("Char {character_id}"),
            planet_id: 1,
            system_id: 30000001,
            system_name: "Jita".to_string(),
            planet_type: "Barren".to_string(),
            upgrade_level: 1,
            pin_count: 3,
            extractors: Vec::new(),
            storage: Vec::new(),
            balance: Vec::new(),
            produced: Vec::new(),
            needs_attention,
        }
    }

    #[test]
    fn idle_colonies_keeps_only_needs_attention_and_trims_the_fields() {
        let views = vec![colony(1, true), colony(2, false)];
        let idle = idle_colonies(&views);
        assert_eq!(idle.len(), 1);
        assert_eq!(idle[0].character_id, 1);
        assert_eq!(idle[0].system_name, "Jita");
        assert_eq!(idle[0].planet_type, "Barren");
    }

    /// Real schematic ids/quantities pulled from the SDE (planetSchematics /
    /// planetSchematicsTypeMap) for a slice of the P1→P2 chain, covering
    /// every named single-planet fixture in #882.
    fn single_planet_fixture_sde() -> Sde {
        crate::sde::test_sde(
            "CREATE TABLE planetSchematics(schematicID INT, schematicName TEXT, cycleTime INT);
             CREATE TABLE planetSchematicsTypeMap(schematicID INT, typeID INT, quantity INT, isInput INT);
             CREATE TABLE invTypes(typeID INT, typeName TEXT);
             INSERT INTO planetSchematics VALUES
               (126, 'Reactive Metals', 1800), (127, 'Precious Metals', 1800),
               (128, 'Toxic Metals', 1800), (129, 'Chiral Structures', 1800),
               (130, 'Silicon', 1800), (123, 'Electrolytes', 1800),
               (122, 'Plasmoids', 1800), (121, 'Water', 1800),
               (73, 'Mechanical Parts', 3600), (76, 'Consumer Electronics', 3600),
               (74, 'Construction Blocks', 3600), (77, 'Miniature Electronics', 3600),
               (67, 'Rocket Fuel', 3600), (65, 'Superconductors', 3600),
               (97, 'Robotics', 3600);
             INSERT INTO planetSchematicsTypeMap VALUES
               (126, 2267, 3000, 1), (126, 2398, 20, 0),
               (127, 2270, 3000, 1), (127, 2399, 20, 0),
               (128, 2272, 3000, 1), (128, 2400, 20, 0),
               (129, 2306, 3000, 1), (129, 2401, 20, 0),
               (130, 2307, 3000, 1), (130, 9828, 20, 0),
               (123, 2309, 3000, 1), (123, 2390, 20, 0),
               (122, 2308, 3000, 1), (122, 2389, 20, 0),
               (121, 2268, 3000, 1), (121, 3645, 20, 0),
               (73, 2398, 40, 1), (73, 2399, 40, 1), (73, 3689, 5, 0),
               (76, 2400, 40, 1), (76, 2401, 40, 1), (76, 9836, 5, 0),
               (74, 2398, 40, 1), (74, 2400, 40, 1), (74, 3828, 5, 0),
               (77, 2401, 40, 1), (77, 9828, 40, 1), (77, 9842, 5, 0),
               (67, 2389, 40, 1), (67, 2390, 40, 1), (67, 9830, 5, 0),
               (65, 2389, 40, 1), (65, 3645, 40, 1), (65, 9838, 5, 0),
               (97, 3689, 10, 1), (97, 9836, 10, 1), (97, 9848, 3, 0);
             INSERT INTO invTypes VALUES
               (2267, 'Base Metals'), (2270, 'Noble Metals'), (2272, 'Heavy Metals'),
               (2306, 'Non-CS Crystals'), (2307, 'Felsic Magma'), (2308, 'Suspended Plasma'),
               (2309, 'Ionic Solutions'), (2268, 'Aqueous Liquids'),
               (2398, 'Reactive Metals'), (2399, 'Precious Metals'), (2400, 'Toxic Metals'),
               (2401, 'Chiral Structures'), (9828, 'Silicon'), (2390, 'Electrolytes'),
               (2389, 'Plasmoids'), (3645, 'Water'),
               (3689, 'Mechanical Parts'), (9836, 'Consumer Electronics'),
               (3828, 'Construction Blocks'), (9842, 'Miniature Electronics'),
               (9830, 'Rocket Fuel'), (9838, 'Superconductors'), (9848, 'Robotics');",
        )
    }

    #[test]
    fn production_chain_pins_known_single_planet_fixtures() {
        let sde = single_planet_fixture_sde();

        let cases: &[(i64, &[&str])] = &[
            (3689, &["Barren", "Plasma"]), // Mechanical Parts
            (3828, &["Lava", "Plasma"]),   // Construction Blocks
            (9842, &["Lava"]),             // Miniature Electronics
            (9830, &["Storm"]),            // Rocket Fuel
            (9838, &["Storm"]),            // Superconductors
            (9848, &["Plasma"]),           // Robotics
        ];
        for &(type_id, expected) in cases {
            let node = production_chain(&sde, type_id).unwrap();
            assert_eq!(
                node.planet_types, expected,
                "type {type_id} ({})",
                node.name
            );
        }
    }

    #[test]
    fn production_chain_walks_the_full_tree_with_qty_and_p0_leaf() {
        let sde = single_planet_fixture_sde();
        let robotics = production_chain(&sde, 9848).unwrap();
        assert_eq!(robotics.name, "Robotics");
        assert_eq!(robotics.tier, 3);
        assert_eq!(robotics.qty_per_cycle, 0);
        assert_eq!(robotics.children.len(), 2);

        let mech_parts = robotics
            .children
            .iter()
            .find(|c| c.type_id == 3689)
            .unwrap();
        assert_eq!(mech_parts.tier, 2);
        assert_eq!(mech_parts.qty_per_cycle, 10); // Robotics needs 10/cycle
        assert_eq!(mech_parts.planet_types, vec!["Barren", "Plasma"]);

        let reactive_metals = mech_parts
            .children
            .iter()
            .find(|c| c.type_id == 2398)
            .unwrap();
        assert_eq!(reactive_metals.name, "Reactive Metals");
        assert_eq!(reactive_metals.tier, 1);
        assert_eq!(reactive_metals.qty_per_cycle, 40); // Mechanical Parts needs 40/cycle
        assert_eq!(reactive_metals.children.len(), 1);

        let base_metals = &reactive_metals.children[0];
        assert_eq!(base_metals.type_id, 2267);
        assert_eq!(base_metals.name, "Base Metals");
        assert_eq!(base_metals.tier, 0);
        assert_eq!(base_metals.qty_per_cycle, 0);
        assert!(base_metals.children.is_empty());
        assert_eq!(
            base_metals.planet_types,
            vec!["Barren", "Gas", "Lava", "Plasma", "Storm"]
        );
    }

    #[test]
    fn production_chain_p4_has_no_single_planet_option() {
        // Nano-Factory (P4) = Industrial Explosives(P3) + Reactive Metals(P1)
        // + Ukomi Superconductors(P3) — real SDE chain, cross-checked against
        // EVE University's Planetary Commodities table. Industrial
        // Explosives bottoms out at {Temperate} only, which shares nothing
        // with Reactive Metals' {Barren,Gas,Lava,Plasma,Storm}, so the P4
        // itself has an empty single-planet set (#882).
        let sde = crate::sde::test_sde(
            "CREATE TABLE planetSchematics(schematicID INT, schematicName TEXT, cycleTime INT);
             CREATE TABLE planetSchematicsTypeMap(schematicID INT, typeID INT, quantity INT, isInput INT);
             CREATE TABLE invTypes(typeID INT, typeName TEXT);
             INSERT INTO planetSchematics VALUES
               (114, 'Nano-Factory', 3600), (106, 'Industrial Explosives', 3600),
               (126, 'Reactive Metals', 1800), (89, 'Ukomi Superconductor', 3600),
               (82, 'Fertilizer', 3600), (85, 'Polytextiles', 3600),
               (68, 'Synthetic Oil', 3600), (65, 'Superconductors', 3600),
               (131, 'Bacteria', 1800), (133, 'Proteins', 1800),
               (134, 'Biofuels', 1800), (135, 'Industrial Fibers', 1800),
               (123, 'Electrolytes', 1800), (124, 'Oxygen', 1800),
               (122, 'Plasmoids', 1800), (121, 'Water', 1800);
             INSERT INTO planetSchematicsTypeMap VALUES
               (114, 2360, 6, 1), (114, 2398, 40, 1), (114, 17136, 6, 1), (114, 2869, 1, 0),
               (106, 3693, 10, 1), (106, 3695, 10, 1), (106, 2360, 3, 0),
               (126, 2267, 3000, 1), (126, 2398, 20, 0),
               (89, 3691, 10, 1), (89, 9838, 10, 1), (89, 17136, 3, 0),
               (82, 2393, 40, 1), (82, 2395, 40, 1), (82, 3693, 5, 0),
               (85, 2396, 40, 1), (85, 2397, 40, 1), (85, 3695, 5, 0),
               (68, 2390, 40, 1), (68, 3683, 40, 1), (68, 3691, 5, 0),
               (65, 2389, 40, 1), (65, 3645, 40, 1), (65, 9838, 5, 0),
               (131, 2073, 3000, 1), (131, 2393, 20, 0),
               (133, 2287, 3000, 1), (133, 2395, 20, 0),
               (134, 2288, 3000, 1), (134, 2396, 20, 0),
               (135, 2305, 3000, 1), (135, 2397, 20, 0),
               (123, 2309, 3000, 1), (123, 2390, 20, 0),
               (124, 2310, 3000, 1), (124, 3683, 20, 0),
               (122, 2308, 3000, 1), (122, 2389, 20, 0),
               (121, 2268, 3000, 1), (121, 3645, 20, 0);
             INSERT INTO invTypes VALUES
               (2360, 'Industrial Explosives'), (2398, 'Reactive Metals'),
               (17136, 'Ukomi Superconductors'), (2869, 'Nano-Factory'),
               (3693, 'Fertilizer'), (3695, 'Polytextiles'), (2393, 'Bacteria'),
               (2395, 'Proteins'), (3691, 'Synthetic Oil'), (9838, 'Superconductors'),
               (2396, 'Biofuels'), (2397, 'Industrial Fibers'), (2390, 'Electrolytes'),
               (3683, 'Oxygen'), (2389, 'Plasmoids'), (3645, 'Water'),
               (2073, 'Microorganisms'), (2287, 'Complex Organisms'),
               (2288, 'Carbon Compounds'), (2305, 'Autotrophs'),
               (2309, 'Ionic Solutions'), (2310, 'Noble Gas'),
               (2308, 'Suspended Plasma'), (2267, 'Base Metals'), (2268, 'Aqueous Liquids');",
        );

        let nano_factory = production_chain(&sde, 2869).unwrap();
        assert_eq!(nano_factory.name, "Nano-Factory");
        assert_eq!(nano_factory.tier, 4);
        assert!(
            nano_factory.planet_types.is_empty(),
            "expected no single-planet option, got {:?}",
            nano_factory.planet_types
        );

        let industrial_explosives = nano_factory
            .children
            .iter()
            .find(|c| c.type_id == 2360)
            .unwrap();
        assert_eq!(industrial_explosives.planet_types, vec!["Temperate"]);
        let ukomi = nano_factory
            .children
            .iter()
            .find(|c| c.type_id == 17136)
            .unwrap();
        assert_eq!(ukomi.planet_types, vec!["Storm"]);
    }
}
