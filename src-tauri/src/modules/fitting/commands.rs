//! Tauri command surface for the fitting module.
//!
//! Commands open the SDE read-only per call (cheap) and orchestrate the shared
//! services, like the production module: pricing/validation/storage commands
//! alongside the dogma `simulate` command.

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, State};

use super::context::DogmaContext;
use super::dna::{self, DnaItem, ParsedDna};
use super::eft::{self, ParsedEft, ParsedExtra, ParsedModule, ParsedMutation};
use super::engine::resolve::{resolve, FitInput};
use super::esi_fittings::EsiFitSource;
use super::npc_profiles;
use super::types::{
    AbyssalWeatherSelection, Fit, FitItem, FitPrice, FitPriceLine, FitStats, ItemMutation,
    ModuleState, NpcProfile, SlotKind, TargetProfile, TargetProfileLibrary,
};
use crate::esi::{self, corporation_id, AuthState, SkillLevels};
use crate::market::{resolve_location, MarketService};
use crate::sde::{Sde, ShipLayout};
use crate::storage;

use super::stats::{required_skills_of, simulate_fit};

/// Storage key for the local saved-fits document (a `Vec<Fit>`).
const FITS_KEY: &str = "fitting_fits";

/// A stable-enough local id for a freshly imported fit (no `uuid` dependency).
fn new_fit_id() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}

/// Resolve a parsed EFT mutation block against the SDE: the mutaplasmid
/// name and each attribute name to their ids (#876). `None` if the
/// mutaplasmid name is unknown or applies to nothing — a best-effort import
/// keeps the base module unmutated rather than failing the whole paste,
/// matching the "unknown module — skip" leniency the rest of this parser
/// already uses. Unknown *individual* attribute names are dropped, not
/// fatal, since a future SDE could rename/retire one.
fn resolve_mutation(sde: &Sde, base_type_id: i64, parsed: &ParsedMutation) -> Option<ItemMutation> {
    let (mutaplasmid_type_id, _) = sde.type_by_name(&parsed.mutaplasmid_name).ok()??;
    let attrs: HashMap<i64, f64> = parsed
        .attrs
        .iter()
        .filter_map(|(name, value)| {
            sde.attribute_id_by_name(name)
                .ok()
                .flatten()
                .map(|id| (id, *value))
        })
        .collect();
    if attrs.is_empty() {
        return None;
    }
    Some(ItemMutation {
        base_type_id,
        mutaplasmid_type_id,
        attrs,
    })
}

/// A hull's slot layout + fitting resources, for the empty editor (#160).
/// `None` if the type id isn't a known ship.
#[tauri::command]
pub fn fitting_ship_layout(app: AppHandle, type_id: i64) -> Result<Option<ShipLayout>, String> {
    crate::sde::open_from_app(&app)?
        .ship_layout(type_id)
        .map_err(|e| e.to_string())
}

/// Parse an EFT clipboard string into a [`Fit`], resolving names → type ids and
/// classifying each module into its slot from dogma effects (#162). Unknown
/// module/charge names are skipped rather than failing the whole import; an
/// unknown ship is an error. Pure over an already-open SDE — no `AppHandle`,
/// so the MCP dev-tier `fitting_stats` capability can reuse it directly.
pub(crate) fn import_eft_to_fit(sde: &Sde, text: &str) -> Result<Fit, String> {
    let parsed = eft::parse_eft(text).map_err(|e| e.to_string())?;

    let ship_type_id = sde
        .type_by_name(&parsed.ship_name)
        .map_err(|e| e.to_string())?
        .map(|(id, _)| id)
        .ok_or_else(|| format!("unknown ship: {}", parsed.ship_name))?;

    let mut items = Vec::new();
    // Next free index within each slot kind, in source order.
    let mut next_index: HashMap<SlotKind, i32> = HashMap::new();
    let take_index = |slot: SlotKind, map: &mut HashMap<SlotKind, i32>| {
        let n = map.entry(slot).or_default();
        let idx = *n;
        *n += 1;
        idx
    };

    for m in &parsed.modules {
        // Empty placeholder: advance the slot's index, add no item.
        if let Some(slot) = m.empty_slot {
            take_index(slot, &mut next_index);
            continue;
        }
        let Some((type_id, _)) = sde.type_by_name(&m.name).map_err(|e| e.to_string())? else {
            continue; // unknown module — skip
        };
        let slot = classify_slot(sde, type_id)?;
        let charge_type_id = match &m.charge {
            Some(c) => sde
                .type_by_name(c)
                .map_err(|e| e.to_string())?
                .map(|(id, _)| id),
            None => None,
        };
        items.push(FitItem {
            type_id,
            slot,
            index: take_index(slot, &mut next_index),
            state: ModuleState::Active,
            charge_type_id,
            quantity: 1,
            active_drones: None,
            mutation: m
                .mutation
                .as_ref()
                .and_then(|pm| resolve_mutation(sde, type_id, pm)),
        });
    }

    for e in &parsed.extras {
        let Some((type_id, _)) = sde.type_by_name(&e.name).map_err(|e| e.to_string())? else {
            continue;
        };
        // Category 18 = Drone; everything else trailing is cargo.
        let slot = match sde.type_category(type_id).map_err(|e| e.to_string())? {
            Some(18) => SlotKind::Drone,
            _ => SlotKind::Cargo,
        };
        items.push(FitItem {
            type_id,
            slot,
            index: take_index(slot, &mut next_index),
            state: ModuleState::Active,
            charge_type_id: None,
            quantity: e.quantity,
            active_drones: None,
            mutation: None,
        });
    }

    Ok(Fit {
        id: new_fit_id(),
        name: parsed.fit_name,
        ship_type_id,
        items,
        projected: Vec::new(),
    })
}

/// Tauri wrapper: open the SDE, then auto-detect EFT vs. DNA by shape (#879)
/// and run the matching pure parse — this is the single paste-import entry
/// point the frontend uses for both formats.
#[tauri::command]
pub fn fitting_import_eft(app: AppHandle, text: String) -> Result<Fit, String> {
    let sde = crate::sde::open_from_app(&app)?;
    if dna::looks_like_dna(&text) {
        import_dna_to_fit(&sde, &text)
    } else {
        import_eft_to_fit(&sde, &text)
    }
}

/// Parse a Ship DNA string into a [`Fit`] (#879). DNA is a flat `id[_];qty`
/// token list after the ship id — slot membership isn't encoded in the text
/// (unlike EFT's section layout), so every token is classified from its own
/// dogma effects/category exactly like [`import_eft_to_fit`]'s modules and
/// extras (subsystems included — they carry the same `subSystem` slot effect
/// EFT relies on). Charges (category 8) are always unfitted, landing in
/// cargo aggregated by type; an explicit `_` "unfitted" marker does the same
/// for a module. Unknown type ids are skipped; an unknown ship id is an
/// error.
pub(crate) fn import_dna_to_fit(sde: &Sde, text: &str) -> Result<Fit, String> {
    let parsed = dna::parse_dna(text).map_err(|e| e.to_string())?;
    let ParsedDna {
        ship_type_id,
        items,
    } = parsed;

    if sde
        .type_category(ship_type_id)
        .map_err(|e| e.to_string())?
        .is_none()
    {
        return Err(format!("unknown ship type id: {ship_type_id}"));
    }

    let type_ids: Vec<i64> = items.iter().map(|i| i.type_id).collect();
    let categories = sde.types_categories(&type_ids).map_err(|e| e.to_string())?;
    let slots = classify_slots_batch(sde, &type_ids)?;

    let mut fit_items = Vec::new();
    let mut next_index: HashMap<SlotKind, i32> = HashMap::new();
    let mut take_index = |slot: SlotKind| {
        let n = next_index.entry(slot).or_default();
        let idx = *n;
        *n += 1;
        idx
    };
    for entry in &items {
        let Some(&category) = categories.get(&entry.type_id) else {
            continue; // unknown item — skip
        };
        // Charges (category 8) are always unfitted; an explicit `_` marker
        // forces the same for a module.
        let slot = if entry.unfitted || category == 8 {
            SlotKind::Cargo
        } else {
            slots
                .get(&entry.type_id)
                .copied()
                .unwrap_or(SlotKind::Cargo)
        };
        let expands = matches!(
            slot,
            SlotKind::High
                | SlotKind::Mid
                | SlotKind::Low
                | SlotKind::Rig
                | SlotKind::Subsystem
                | SlotKind::Mode
        );
        if expands {
            // Same defensive cap as the loose-list importer (#761): a real
            // fit never carries more than a slot bank of one module.
            for _ in 0..entry.quantity.clamp(1, 8) {
                fit_items.push(FitItem {
                    type_id: entry.type_id,
                    slot,
                    index: take_index(slot),
                    state: ModuleState::Active,
                    charge_type_id: None,
                    quantity: 1,
                    active_drones: None,
                    mutation: None,
                });
            }
        } else {
            fit_items.push(FitItem {
                type_id: entry.type_id,
                slot,
                index: take_index(slot),
                state: ModuleState::Active,
                charge_type_id: None,
                quantity: entry.quantity.max(1),
                active_drones: None,
                mutation: None,
            });
        }
    }

    Ok(Fit {
        id: new_fit_id(),
        name: format!("{} (DNA imported)", sde.type_name_or_id(ship_type_id)),
        ship_type_id,
        items: fit_items,
        projected: Vec::new(),
    })
}

/// Parse a bare quantity token — digits with optional thousands separators.
/// `None` if it isn't purely a number.
fn parse_qty(s: &str) -> Option<i64> {
    let cleaned: String = s
        .chars()
        .filter(|c| !matches!(c, ',' | '.' | ' ' | '\''))
        .collect();
    if cleaned.is_empty() || !cleaned.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    cleaned.parse().ok()
}

/// Parse one line of a loose item list into `(name, quantity)`. Tolerant of the
/// common paste shapes: plain `Name`; multibuy `Name xN` / `Name N`; and
/// tab-separated rows (contracts, cargo scans, asset/inventory lists — the name
/// is the first column and the quantity the first later integer column). `None`
/// for a blank line.
fn parse_item_line(line: &str) -> Option<(String, i64)> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    // Tab-separated row: name = first column; quantity = first later integer
    // column (contracts/inventory put it in column 2), else 1.
    if line.contains('\t') {
        let mut cols = line.split('\t').map(str::trim);
        let name = cols.next().unwrap_or("").to_string();
        let qty = cols.find_map(parse_qty).unwrap_or(1);
        return (!name.is_empty()).then_some((name, qty));
    }
    // Trailing "Name xN" / "Name x N".
    if let Some((name, tail)) = line.rsplit_once('x') {
        if let Some(q) = parse_qty(tail) {
            let name = name.trim();
            if !name.is_empty() {
                return Some((name.to_string(), q));
            }
        }
    }
    // Trailing "Name N" (multibuy).
    if let Some((name, tail)) = line.rsplit_once(char::is_whitespace) {
        if let Some(q) = parse_qty(tail) {
            let name = name.trim();
            if !name.is_empty() {
                return Some((name.to_string(), q));
            }
        }
    }
    Some((line.to_string(), 1))
}

/// Resolve one list line to `(type_id, quantity)` via the SDE, or `None` if it
/// names nothing. Falls back to the raw line when the stripped-quantity name
/// doesn't resolve (for the rare item name that ends in a number).
fn resolve_list_item(sde: &Sde, line: &str) -> Result<Option<(i64, i64)>, String> {
    let Some((name, qty)) = parse_item_line(line) else {
        return Ok(None);
    };
    if let Some((id, _)) = sde.type_by_name(&name).map_err(|e| e.to_string())? {
        return Ok(Some((id, qty)));
    }
    let raw = line.trim();
    if raw != name {
        if let Some((id, _)) = sde.type_by_name(raw).map_err(|e| e.to_string())? {
            return Ok(Some((id, 1)));
        }
    }
    Ok(None)
}

/// Build a [`Fit`] from a loose, one-item-per-line list (contracts, multibuy,
/// cargo/asset pastes) — a more flexible sibling of the EFT importer. The first
/// ship (category 6) is the hull; every other resolved item is classified into
/// its slot (slot modules expand per unit into separate slots; drones/cargo/
/// implants stay stacked). Unknown lines are skipped; charges land in cargo
/// (a loose list can't say which weapon they belong to). Errors only if no
/// items resolve or no ship is present.
pub(crate) fn import_list_to_fit(sde: &Sde, text: &str) -> Result<Fit, String> {
    let mut resolved: Vec<(i64, i64)> = Vec::new();
    for line in text.lines() {
        if let Some(item) = resolve_list_item(sde, line)? {
            resolved.push(item);
        }
    }
    if resolved.is_empty() {
        return Err("no recognizable items in the list".into());
    }
    let ids: Vec<i64> = resolved.iter().map(|(id, _)| *id).collect();
    let categories = sde.types_categories(&ids).map_err(|e| e.to_string())?;
    let slots = classify_slots_batch(sde, &ids)?;
    let ship_type_id = resolved
        .iter()
        .map(|(id, _)| *id)
        .find(|id| categories.get(id).copied() == Some(6))
        .ok_or("no ship hull found in the list — include the ship line")?;

    let mut items = Vec::new();
    let mut next_index: HashMap<SlotKind, i32> = HashMap::new();
    let mut take_index = |slot: SlotKind| {
        let n = next_index.entry(slot).or_default();
        let idx = *n;
        *n += 1;
        idx
    };
    let mut hull_used = false;
    for (id, qty) in resolved {
        if id == ship_type_id && !hull_used {
            hull_used = true; // this entry is the hull itself
            continue;
        }
        let slot = slots.get(&id).copied().unwrap_or(SlotKind::Cargo);
        let qty = qty.max(1);
        let expands = matches!(
            slot,
            SlotKind::High
                | SlotKind::Mid
                | SlotKind::Low
                | SlotKind::Rig
                | SlotKind::Subsystem
                | SlotKind::Mode
        );
        if expands {
            // A real fit never carries more than a slot bank of one module (8
            // highs at most); cap so a bulk multibuy line can't explode.
            for _ in 0..qty.min(8) {
                items.push(FitItem {
                    type_id: id,
                    slot,
                    index: take_index(slot),
                    state: ModuleState::Active,
                    charge_type_id: None,
                    quantity: 1,
                    active_drones: None,
                    mutation: None,
                });
            }
        } else {
            items.push(FitItem {
                type_id: id,
                slot,
                index: take_index(slot),
                state: ModuleState::Active,
                charge_type_id: None,
                quantity: qty.min(i32::MAX as i64) as i32,
                active_drones: None,
                mutation: None,
            });
        }
    }
    Ok(Fit {
        id: new_fit_id(),
        name: format!("{} (imported)", sde.type_name_or_id(ship_type_id)),
        ship_type_id,
        items,
        projected: Vec::new(),
    })
}

/// Tauri wrapper: open the SDE, then build a fit from a pasted item list.
#[tauri::command]
pub fn fitting_import_list(app: AppHandle, text: String) -> Result<Fit, String> {
    let sde = crate::sde::open_from_app(&app)?;
    import_list_to_fit(&sde, &text)
}

/// Next free 0-based index for `slot`, i.e. one past the highest currently used
/// (or 0 when the slot is empty). Pure, so the placement logic is unit-tested
/// without an SDE.
fn next_slot_index(items: &[FitItem], slot: SlotKind) -> i32 {
    items
        .iter()
        .filter(|it| it.slot == slot)
        .map(|it| it.index)
        .max()
        .map_or(0, |m| m + 1)
}

/// Classify a type's slot: drones (category 18) and implants (20) by category,
/// mode items (group 1306 — Ship Modifiers) by group, otherwise from its
/// slot-defining dogma effects, falling back to Cargo.
fn classify_slot(sde: &Sde, type_id: i64) -> Result<SlotKind, String> {
    match sde.type_category(type_id).map_err(|e| e.to_string())? {
        Some(18) => return Ok(SlotKind::Drone),
        Some(20) => return Ok(SlotKind::Implant),
        _ => {}
    }
    if sde.type_group(type_id).map_err(|e| e.to_string())? == Some(1306) {
        return Ok(SlotKind::Mode);
    }
    let effects: Vec<i64> = sde
        .type_effects(type_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|(e, _)| e)
        .collect();
    Ok(eft::slot_for_effects(&effects).unwrap_or(SlotKind::Cargo))
}

/// [`classify_slot`], batched over the whole candidate set: three bulk SDE
/// queries (categories, groups, effects) instead of three per candidate (#761).
fn classify_slots_batch(sde: &Sde, type_ids: &[i64]) -> Result<HashMap<i64, SlotKind>, String> {
    let categories = sde.types_categories(type_ids).map_err(|e| e.to_string())?;
    let groups = sde.types_groups(type_ids).map_err(|e| e.to_string())?;
    let effects = sde.types_effects(type_ids).map_err(|e| e.to_string())?;
    Ok(type_ids
        .iter()
        .map(|&id| {
            let slot = match categories.get(&id) {
                Some(18) => SlotKind::Drone,
                Some(20) => SlotKind::Implant,
                _ => {
                    if groups.get(&id).copied() == Some(1306) {
                        SlotKind::Mode
                    } else {
                        let effs = effects.get(&id).cloned().unwrap_or_default();
                        eft::slot_for_effects(&effs).unwrap_or(SlotKind::Cargo)
                    }
                }
            };
            (id, slot)
        })
        .collect())
}

/// A charge that can be loaded into a weapon/module.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChargeOption {
    pub id: i64,
    pub name: String,
}

/// Charges usable in a weapon/module (right chargeGroup + size + capacity), so
/// the slot grid can offer only loadable ammo. Empty when it takes no charge.
#[tauri::command]
pub fn fitting_compatible_charges(
    app: AppHandle,
    type_id: i64,
) -> Result<Vec<ChargeOption>, String> {
    let sde = crate::sde::open_from_app(&app)?;
    Ok(sde
        .compatible_charges(type_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|(id, name)| ChargeOption { id, name })
        .collect())
}

/// A wormhole-class or Pochven-metaliminal-storm "environment beacon" a fit
/// can be sitting in (see [`fitting_simulate`]'s `environment_effect`). Not
/// Abyssal Deadspace weather — that's a per-filament-pocket mechanic with no
/// dogma-attribute data in the SDE (computed dynamically per instance).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EnvironmentEffectOption {
    pub id: i64,
    pub name: String,
}

/// Wormhole-class ("Class N \<effect\> Effects") and Pochven metaliminal-storm
/// ("Weak/Strong Metaliminal \<weather\> Storm") environment beacons, so the
/// fitting page can offer a fit-independent selector for the space it's
/// sitting in.
#[tauri::command]
pub fn fitting_environment_effects(app: AppHandle) -> Result<Vec<EnvironmentEffectOption>, String> {
    let sde = crate::sde::open_from_app(&app)?;
    Ok(sde
        .environment_effects()
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|(id, name)| EnvironmentEffectOption { id, name })
        .collect())
}

/// Slot + fitting cost of a candidate module, so the add-module browser can show
/// (and rank by) whether it actually fits the current hull's free slots and
/// remaining CPU/PG/calibration.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModuleInfo {
    pub id: i64,
    pub slot: SlotKind,
    pub cpu: f64,
    pub powergrid: f64,
    pub calibration: f64,
}

/// Gate a command on the active character having granted `scope`, giving an
/// actionable "add this scope and re-add the character" error naming `scope`
/// and a human `label` when they haven't. Fitting is the only module today
/// that gates individual commands on ESI scopes (esi-fittings read/write); if
/// a second module needs this, promote it to a shared service instead of
/// duplicating it — premature to do so for a single caller.
fn require_scope(
    dir: &Path,
    character_id: i64,
    scope: &str,
    label: &str,
) -> Result<(), crate::model::AppError> {
    let granted = storage::load_roster(dir)
        .iter()
        .find(|c| c.character_id == character_id)
        .map(|c| c.scopes.iter().any(|s| s == scope))
        .unwrap_or(false);
    if granted {
        Ok(())
    } else {
        Err(crate::model::AppError::from(format!(
            "This character hasn't granted the {label} scope. Add \
             {scope} to your EVE application, then remove and re-add the \
             character."
        )))
    }
}

/// The active character's actual skill levels, via the shared ESI fetch
/// (#177). Resolves the primary character before calling.
async fn character_skill_levels(
    app: &AppHandle,
    auth_state: &AuthState,
) -> Result<SkillLevels, crate::model::AppError> {
    let dir = storage::app_data_dir(app)?;
    let character_id =
        storage::primary_character(&dir).ok_or_else(crate::model::AppError::auth_required)?;
    Ok(esi::character_skill_levels(auth_state, character_id).await?)
}

/// Resolve the dogma engine's skill levels from `skill_source`: the active
/// character's real skills when it's `"character"`, else `None` (treated as
/// all-V by [`skill_fn`]). Shared by [`fitting_module_info`] and
/// [`fitting_simulate`] (#172–#177, #266).
///
/// MUST be awaited (and thus complete) *before* the caller opens the SDE:
/// `rusqlite::Connection` isn't `Send`, so an open SDE handle can never be
/// held across this call's `.await` — every call site fetches skills first,
/// then opens the SDE.
async fn resolve_skill_levels(
    app: &AppHandle,
    auth_state: &AuthState,
    skill_source: Option<&str>,
) -> Option<SkillLevels> {
    if skill_source == Some("character") {
        character_skill_levels(app, auth_state).await.ok()
    } else {
        None
    }
}

/// Skill-level lookup for the dogma engine: the character's real level
/// (untrained = 0) when `levels` is `Some`, else all-V (5) as though every
/// skill were maxed.
fn skill_level_for(levels: Option<&SkillLevels>, skill_id: i64) -> f64 {
    match levels {
        Some(levels) => levels.level(skill_id) as f64,
        None => 5.0, // all-V
    }
}

/// Build the dogma engine's skill-level closure over `levels` resolved by
/// [`resolve_skill_levels`], replacing the former per-call-site lookup.
fn skill_fn(levels: Option<&SkillLevels>) -> impl Fn(i64) -> f64 + '_ {
    move |sid| skill_level_for(levels, sid)
}

/// Slot + **skill-adjusted** CPU/PG/calibration for each candidate type, on the
/// given hull at the chosen skills — the *same* resolution fitted modules get, so
/// the add-module fit check matches reality (e.g. Weapon Upgrades cutting turret
/// CPU at all-V, or a hull's role bonus to a module's fitting). #266.
#[tauri::command]
pub async fn fitting_module_info(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
    ship_type_id: i64,
    skill_source: Option<String>,
    type_ids: Vec<i64>,
) -> Result<Vec<ModuleInfo>, String> {
    // Skills first (async, before opening the SDE — see resolve_skill_levels).
    let levels = resolve_skill_levels(&app, &auth_state, skill_source.as_deref()).await;
    let lookup = skill_fn(levels.as_ref());

    let (dir, sde) = crate::sde::dir_and_sde(&app)?;
    let costs = resolve_module_costs(&sde, &dir, ship_type_id, &lookup, &type_ids)?;
    let slots = classify_slots_batch(&sde, &type_ids)?;
    type_ids
        .into_iter()
        .map(|id| {
            let (cpu, powergrid, calibration) = costs.get(&id).copied().unwrap_or((0.0, 0.0, 0.0));
            Ok(ModuleInfo {
                id,
                slot: slots.get(&id).copied().unwrap_or(SlotKind::Cargo),
                cpu,
                powergrid,
                calibration,
            })
        })
        .collect()
}

/// One mutated attribute's slider bounds (#876): the module's own
/// (unmutated) value on `base_type_id`, and the absolute `[min, max]` this
/// mutaplasmid can roll it to (`base_value * multiplier` from
/// [`crate::sde::MutaplasmidRoll::attribute_ranges`]).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MutationAttrRange {
    pub attribute_id: i64,
    pub attribute_name: String,
    pub base_value: f64,
    pub min_value: f64,
    pub max_value: f64,
}

/// Per-attribute roll bounds for mutating `base_type_id` with
/// `mutaplasmid_type_id` (#876) — backs the module editor's mutate sliders,
/// each clamped to `[minValue, maxValue]`. Errors if the mutaplasmid isn't
/// applicable to this base type.
#[tauri::command]
pub fn fitting_mutation_ranges(
    app: AppHandle,
    base_type_id: i64,
    mutaplasmid_type_id: i64,
) -> Result<Vec<MutationAttrRange>, String> {
    let sde = crate::sde::open_from_app(&app)?;
    let roll = sde
        .mutaplasmid_roll(mutaplasmid_type_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| "unknown mutaplasmid".to_string())?;
    if !roll.applicable_type_ids.contains(&base_type_id) {
        return Err("mutaplasmid does not apply to this module".to_string());
    }
    let base_attrs: HashMap<i64, f64> = sde
        .type_attributes_raw(base_type_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .collect();
    let attr_ids: Vec<i64> = roll.attribute_ranges.keys().copied().collect();
    let names = sde.attribute_names(&attr_ids).map_err(|e| e.to_string())?;
    let mut out: Vec<MutationAttrRange> =
        roll.attribute_ranges
            .iter()
            .map(|(&attribute_id, &(min_mult, max_mult))| {
                let base_value = base_attrs.get(&attribute_id).copied().unwrap_or(0.0);
                let (_, display_name) = names.get(&attribute_id).cloned().unwrap_or_else(|| {
                    (format!("attr{attribute_id}"), format!("attr{attribute_id}"))
                });
                let (lo, hi) = (base_value * min_mult, base_value * max_mult);
                MutationAttrRange {
                    attribute_id,
                    attribute_name: display_name,
                    base_value,
                    min_value: lo.min(hi),
                    max_value: lo.max(hi),
                }
            })
            .collect();
    out.sort_by_key(|a| a.attribute_id);
    Ok(out)
}

/// Finalized CPU(50)/PG(30)/calibration(1153) for each candidate module, resolved
/// on `ship_type_id` with the active skills via the dogma engine — identical to
/// how fitted modules are computed. Resolving the candidates together is safe:
/// skill/role fitting reductions apply per module, not across them.
fn resolve_module_costs(
    sde: &Sde,
    dir: &Path,
    ship_type_id: i64,
    skill_level_for: &dyn Fn(i64) -> f64,
    type_ids: &[i64],
) -> Result<HashMap<i64, (f64, f64, f64)>, String> {
    let mut extra_ids = Vec::with_capacity(1 + type_ids.len());
    extra_ids.push(ship_type_id);
    extra_ids.extend_from_slice(type_ids);
    let ctx = DogmaContext::load(sde, dir, &extra_ids)?;

    let ship = ctx.entity(ship_type_id, Vec::new());
    let mut modules = Vec::with_capacity(type_ids.len());
    for id in type_ids {
        modules.push(ctx.entity(*id, required_skills_of(&ctx.attrs, *id)));
    }
    let skills = ctx.skill_entities(skill_level_for);

    let charges = vec![None; modules.len()];
    let resolved = resolve(
        &FitInput {
            ship,
            modules,
            skills,
            drones: Vec::new(),
            charges,
            gang_modules: Vec::new(),
        },
        &ctx.effect_meta,
        &|a| ctx.is_stackable(a),
        &|a| ctx.default_of(a),
    );
    let mut out = HashMap::new();
    for (id, store) in type_ids.iter().zip(&resolved.modules) {
        out.insert(*id, (store.get(50), store.get(30), store.get(1153)));
    }
    Ok(out)
}

/// Add a module/drone/charge-bearing item to a fit, classifying its slot from
/// its dogma effects (drones by category) and placing it at the next free index
/// in that slot. Slot capacity is guarded in the UI; an over-fit still surfaces
/// as a validation problem on the next simulate. Returns the updated fit (#168).
#[tauri::command]
pub fn fitting_add_item(
    app: AppHandle,
    mut fit: Fit,
    type_id: i64,
    charge_type_id: Option<i64>,
) -> Result<Fit, String> {
    let sde = crate::sde::open_from_app(&app)?;
    let slot = classify_slot(&sde, type_id)?;
    // Modules are added active by default; the user can deactivate (online) or
    // disable (offline) them in the slot grid.
    let state = ModuleState::Active;
    fit.items.push(FitItem {
        type_id,
        slot,
        index: next_slot_index(&fit.items, slot),
        state,
        charge_type_id,
        quantity: 1,
        active_drones: None,
        mutation: None,
    });
    Ok(fit)
}

/// Build the EFT mutation block for an [`ItemMutation`] (#876) — the
/// inverse of [`resolve_mutation`]: attribute ids -> their internal
/// `attributeName`s, alphabet-sorted (matching the community EFT-dialect
/// convention discussed for this format), mutaplasmid id -> its full type
/// name (unambiguous on import, unlike an abbreviated grade word).
fn export_mutation(sde: &Sde, m: &ItemMutation) -> ParsedMutation {
    let attr_ids: Vec<i64> = m.attrs.keys().copied().collect();
    let names = sde.attribute_names(&attr_ids).unwrap_or_default();
    let mut attrs: Vec<(String, f64)> = m
        .attrs
        .iter()
        .map(|(id, value)| {
            let name = names
                .get(id)
                .map(|(internal, _)| internal.clone())
                .unwrap_or_else(|| format!("attr{id}"));
            (name, *value)
        })
        .collect();
    attrs.sort_by(|a, b| a.0.cmp(&b.0));
    ParsedMutation {
        mutaplasmid_name: sde.type_name_or_id(m.mutaplasmid_type_id),
        attrs,
    }
}

/// Serialize a resolved [`Fit`] to EFT text: modules grouped high→mid→low→rig→
/// subsystem in index order, each with its loaded charge (`Module, Charge`);
/// drones and cargo follow as `Name xN`. Shared by [`fitting_export_eft`] and
/// the PVP fit analyzer, so a simulated enemy fit imports with its ammo loaded
/// into the weapons rather than dumped into cargo.
pub(crate) fn fit_to_eft(sde: &Sde, fit: &Fit) -> String {
    let ship_name = sde.type_name_or_id(fit.ship_type_id);
    let mut modules = Vec::new();
    for slot in [
        SlotKind::High,
        SlotKind::Mid,
        SlotKind::Low,
        SlotKind::Rig,
        SlotKind::Subsystem,
    ] {
        let mut in_slot: Vec<&FitItem> = fit.items.iter().filter(|i| i.slot == slot).collect();
        in_slot.sort_by_key(|i| i.index);
        for i in in_slot {
            let charge = i.charge_type_id.map(|c| sde.type_name_or_id(c));
            modules.push(ParsedModule {
                name: sde.type_name_or_id(i.type_id),
                charge,
                empty_slot: None,
                mutation: i.mutation.as_ref().map(|m| export_mutation(sde, m)),
            });
        }
    }
    let mut extras = Vec::new();
    for i in fit
        .items
        .iter()
        .filter(|i| matches!(i.slot, SlotKind::Drone | SlotKind::Cargo))
    {
        extras.push(ParsedExtra {
            name: sde.type_name_or_id(i.type_id),
            quantity: i.quantity,
        });
    }
    eft::format_eft(&ParsedEft {
        ship_name,
        fit_name: fit.name.clone(),
        modules,
        extras,
    })
}

/// Serialize a [`Fit`] to an EFT clipboard string (#162).
#[tauri::command]
pub fn fitting_export_eft(app: AppHandle, fit: Fit) -> Result<String, String> {
    let sde = crate::sde::open_from_app(&app)?;
    Ok(fit_to_eft(&sde, &fit))
}

/// Serialize a resolved [`Fit`] to a Ship DNA string (#879): subsystems
/// first (in their fitted index order — the client always lists them ahead
/// of regular modules), then modules grouped high→mid→low→rig, aggregated
/// by type id with a count (`id;count`) rather than one token per instance
/// — this is what makes "two of the same gun" round-trip as `id;2` rather
/// than two separate `id;1` tokens. Drones follow, then charges: every
/// loaded weapon charge (one unit per weapon carrying it) plus any cargo
/// item that's itself charge-category (#879), merged into one aggregate per
/// charge type — DNA has no way to say "this ammo is loaded in that gun",
/// so, like the real client, charges always land unfitted. Plain (non-charge)
/// cargo has no representation in DNA and is dropped, matching the format's
/// real-world semantics (a cargo module id in the client's own DNA importer
/// gets misinterpreted as fitted and corrupts the save).
pub(crate) fn fit_to_dna(sde: &Sde, fit: &Fit) -> String {
    let mut subsystems: Vec<&FitItem> = fit
        .items
        .iter()
        .filter(|i| i.slot == SlotKind::Subsystem)
        .collect();
    subsystems.sort_by_key(|i| i.index);

    let mut mod_order: Vec<i64> = Vec::new();
    let mut mod_counts: HashMap<i64, i32> = HashMap::new();
    let mut charge_order: Vec<i64> = Vec::new();
    let mut charge_counts: HashMap<i64, i32> = HashMap::new();
    let bump = |id: i64, qty: i32, order: &mut Vec<i64>, counts: &mut HashMap<i64, i32>| {
        if !counts.contains_key(&id) {
            order.push(id);
        }
        *counts.entry(id).or_insert(0) += qty;
    };

    for slot in [SlotKind::High, SlotKind::Mid, SlotKind::Low, SlotKind::Rig] {
        let mut in_slot: Vec<&FitItem> = fit.items.iter().filter(|i| i.slot == slot).collect();
        in_slot.sort_by_key(|i| i.index);
        for i in in_slot {
            bump(i.type_id, 1, &mut mod_order, &mut mod_counts);
            if let Some(c) = i.charge_type_id {
                bump(c, 1, &mut charge_order, &mut charge_counts);
            }
        }
    }

    let mut drones: Vec<&FitItem> = fit
        .items
        .iter()
        .filter(|i| i.slot == SlotKind::Drone)
        .collect();
    drones.sort_by_key(|i| i.index);

    let mut cargo: Vec<&FitItem> = fit
        .items
        .iter()
        .filter(|i| i.slot == SlotKind::Cargo)
        .collect();
    cargo.sort_by_key(|i| i.index);
    let cargo_ids: Vec<i64> = cargo.iter().map(|i| i.type_id).collect();
    let cargo_categories = sde.types_categories(&cargo_ids).unwrap_or_default();
    for i in &cargo {
        if cargo_categories.get(&i.type_id).copied() == Some(8) {
            bump(i.type_id, i.quantity, &mut charge_order, &mut charge_counts);
        }
    }

    let mut items = Vec::new();
    for s in &subsystems {
        items.push(DnaItem {
            type_id: s.type_id,
            quantity: 1,
            unfitted: false,
        });
    }
    for id in &mod_order {
        items.push(DnaItem {
            type_id: *id,
            quantity: mod_counts[id],
            unfitted: false,
        });
    }
    for d in &drones {
        items.push(DnaItem {
            type_id: d.type_id,
            quantity: d.quantity,
            unfitted: false,
        });
    }
    for id in &charge_order {
        items.push(DnaItem {
            type_id: *id,
            quantity: charge_counts[id],
            unfitted: false,
        });
    }

    dna::format_dna(&ParsedDna {
        ship_type_id: fit.ship_type_id,
        items,
    })
}

/// Serialize a [`Fit`] to a Ship DNA clipboard string (#879).
#[tauri::command]
pub fn fitting_export_dna(app: AppHandle, fit: Fit) -> Result<String, String> {
    let sde = crate::sde::open_from_app(&app)?;
    Ok(fit_to_dna(&sde, &fit))
}

/// Serialize a resolved [`Fit`] to an EVE Multibuy-pasteable item list
/// (#879): one `Name xQty` line per distinct type id, aggregated across
/// fitted modules, their loaded charges (one unit per weapon carrying it)
/// and drone/cargo stacks — everything a player would need to buy to
/// restock the fit. The hull itself isn't included (Multibuy restocks
/// consumables/replaceables, not the ship). Lines follow first-appearance
/// order (modules high→mid→low→rig→subsystem→mode, then drones/cargo),
/// matching [`fit_to_eft`]'s slot ordering.
pub(crate) fn fit_to_multibuy(sde: &Sde, fit: &Fit) -> String {
    let mut order: Vec<i64> = Vec::new();
    let mut counts: HashMap<i64, i32> = HashMap::new();
    let bump = |id: i64, qty: i32, order: &mut Vec<i64>, counts: &mut HashMap<i64, i32>| {
        if !counts.contains_key(&id) {
            order.push(id);
        }
        *counts.entry(id).or_insert(0) += qty;
    };

    for slot in [
        SlotKind::High,
        SlotKind::Mid,
        SlotKind::Low,
        SlotKind::Rig,
        SlotKind::Subsystem,
        SlotKind::Mode,
        SlotKind::Implant,
        SlotKind::Booster,
    ] {
        let mut in_slot: Vec<&FitItem> = fit.items.iter().filter(|i| i.slot == slot).collect();
        in_slot.sort_by_key(|i| i.index);
        for i in in_slot {
            bump(i.type_id, i.quantity, &mut order, &mut counts);
            if let Some(c) = i.charge_type_id {
                bump(c, 1, &mut order, &mut counts);
            }
        }
    }

    let mut extras: Vec<&FitItem> = fit
        .items
        .iter()
        .filter(|i| matches!(i.slot, SlotKind::Drone | SlotKind::Cargo))
        .collect();
    extras.sort_by_key(|i| i.index);
    for i in extras {
        bump(i.type_id, i.quantity, &mut order, &mut counts);
    }

    order
        .iter()
        .map(|id| format!("{} x{}", sde.type_name_or_id(*id), counts[id]))
        .collect::<Vec<_>>()
        .join("\n")
}

/// Serialize a [`Fit`] to an EVE Multibuy-pasteable clipboard string (#879).
#[tauri::command]
pub fn fitting_export_multibuy(app: AppHandle, fit: Fit) -> Result<String, String> {
    let sde = crate::sde::open_from_app(&app)?;
    Ok(fit_to_multibuy(&sde, &fit))
}

/// Save a fit to the active character's in-game fittings via ESI (#178). Needs
/// the `esi-fittings.write_fittings.v1` scope; a missing scope surfaces as an
/// actionable error. Implants/boosters are dropped (not part of an ESI fitting).
/// Returns the new `fitting_id`; invalidates the cached list so it reappears.
#[tauri::command]
pub async fn fitting_esi_push(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
    fit: Fit,
) -> Result<i64, crate::model::AppError> {
    let (dir, character_id) = storage::dir_and_primary_character(&app)?;
    require_scope(
        &dir,
        character_id,
        "esi-fittings.write_fittings.v1",
        "fittings write",
    )?;

    let items = super::esi_fittings::fit_to_esi_items(&fit);
    if items.is_empty() {
        return Err(crate::model::AppError::from(
            "Nothing to save — the fit has no modules.",
        ));
    }
    let name = if fit.name.trim().is_empty() {
        "Fit"
    } else {
        fit.name.trim()
    };
    let id = crate::esi::create_character_fitting(
        &auth_state,
        character_id,
        name,
        "Saved from EVE Online Tooling",
        fit.ship_type_id,
        &items,
    )
    .await?;

    // The new fitting should show up next open.
    storage::cache_invalidate(&dir, &format!("fitting_esi_{character_id}"));
    Ok(id)
}

/// Load the active character's (and corp's) in-game saved fittings from ESI as
/// [`Fit`]s the editor can open (#178). Best-effort: needs the `esi-fittings`
/// scope enabled on the app + a re-login; without it ESI returns 403 and this
/// yields an empty list (corp also needs the Fitting Manager role).
#[tauri::command]
pub async fn fitting_esi_list(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
    force: Option<bool>,
) -> Result<Vec<Fit>, crate::model::AppError> {
    let (dir, character_id) = storage::dir_and_primary_character(&app)?;

    // Up-front, actionable error when the active character never granted the
    // fittings scope (the common reason nothing loads).
    require_scope(
        &dir,
        character_id,
        "esi-fittings.read_fittings.v1",
        "fittings",
    )?;

    // Cached per character (30 min) so the picker doesn't re-hit ESI each open;
    // `force` (the refresh button) bypasses it.
    let cache_key = format!("fitting_esi_{character_id}");
    if force != Some(true) {
        if let Some(cached) = storage::cache_get::<Vec<Fit>>(&dir, &cache_key) {
            return Ok(cached);
        }
    }

    // Fetch (async) before opening the SDE — its Connection isn't Send. The two
    // sources stay separate: their fitting ids come from independent id spaces,
    // so each fit's id is namespaced by where it came from.
    let personal = crate::esi::fetch_character_fittings(&auth_state, character_id).await?;
    let mut corp_fits = Vec::new();
    if let Ok(corp_id) = corporation_id(&auth_state, character_id).await {
        if let Ok(corp) = crate::esi::fetch_corp_fittings(&auth_state, character_id, corp_id).await
        {
            corp_fits = corp;
        }
    }

    // Classify charges (SDE category 8 = Charge) and convert each fitting.
    let sde = crate::sde::open_from_app(&app)?;
    let ids: Vec<i64> = personal
        .iter()
        .chain(corp_fits.iter())
        .flat_map(|f| f.items.iter().map(|it| it.type_id))
        .collect();
    let cats = sde.types_categories(&ids).unwrap_or_default();
    let is_charge = |tid: i64| cats.get(&tid).copied() == Some(8);
    let fits: Vec<Fit> = personal
        .iter()
        .map(|f| super::esi_fittings::esi_fitting_to_fit(f, EsiFitSource::Character, &is_charge))
        .chain(corp_fits.iter().map(|f| {
            super::esi_fittings::esi_fitting_to_fit(f, EsiFitSource::Corporation, &is_charge)
        }))
        .collect();
    let _ = storage::cache_put(&dir, &cache_key, &fits, 30 * 60);
    Ok(fits)
}

/// Simulate a fit: slot/resource validation plus the dogma stats (capacitor,
/// tank, DPS, navigation, targeting). `skill_source` is `"character"` for the
/// logged-in pilot's real skills, anything else (default) for all-V (#172–#177).
/// `damage_profile` weighs EHP resonances (#702, default even 25/25/25/25);
/// `neut_gjs` adds projected neut pressure to the cap simulation (#706,
/// default none). `target_profile` supplies a target for applied-DPS and the
/// DPS-vs-range curve (#701, default none). `fleet_boosts` are command-burst/
/// fleet-link modules (+ optional charge) the fit is "receiving" from a fleet
/// member (#705, default none). `environment_effect` is a wormhole-class or
/// Pochven-metaliminal-storm "environment beacon" type id the fit is sitting
/// in (default none) — see [`fitting_environment_effects`]. `abyssal_weather`
/// is the separate, mutually exclusive Abyssal Deadspace weather choice
/// (default none, hardcoded — see `engine::abyssal`, no dogma data exists
/// for it). `spool_pct` (#872) is the requested Triglavian/spoolable-weapon
/// ramp fraction (`0.0` cold .. `1.0` fully spooled; default `1.0`, since
/// players quote Trig DPS fully spooled). `factor_reload` (#871) toggles
/// reload accounting in the cap sim (default `false`) — clip depletion +
/// reload pauses a weapon's cap draw; burst/sustained DPS are always both
/// returned regardless (`FitStats::dps`/`dps_sustained`). `price` stays
/// `None` here (priced separately via [`fitting_price`]).
#[tauri::command]
#[allow(clippy::too_many_arguments)] // Tauri command surface — each arg is a distinct optional input
pub async fn fitting_simulate(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
    fit: Fit,
    skill_source: Option<String>,
    damage_profile: Option<[f64; 4]>,
    neut_gjs: Option<f64>,
    target_profile: Option<TargetProfile>,
    fleet_boosts: Option<Vec<[i64; 2]>>,
    environment_effect: Option<i64>,
    abyssal_weather: Option<AbyssalWeatherSelection>,
    spool_pct: Option<f64>,
    factor_reload: Option<bool>,
) -> Result<FitStats, String> {
    // Skills first (async, before opening the SDE — see resolve_skill_levels).
    let levels = resolve_skill_levels(&app, &auth_state, skill_source.as_deref()).await;
    let lookup = skill_fn(levels.as_ref());

    let (dir, sde) = crate::sde::dir_and_sde(&app)?;
    simulate_fit(
        &sde,
        &dir,
        &fit,
        &lookup,
        damage_profile,
        neut_gjs,
        target_profile,
        fleet_boosts,
        environment_effect,
        abyssal_weather,
        spool_pct,
        factor_reload,
    )
}

/// One row of the ammo comparison: what a cargo ammo does when loaded.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AmmoRow {
    pub type_id: i64,
    pub name: String,
    /// Whole-fit weapon DPS (turret + missile) with this ammo loaded.
    pub dps: f64,
    pub optimal: f64,
    pub falloff: f64,
    /// Turret tracking (rad/s); 0 for missiles.
    pub tracking: f64,
}

/// Cargo ammo type ids at least one fitted weapon can load, in cargo order and
/// de-duplicated. `weapon_charges[w]` is weapon w's loadable charge ids. Pure.
fn cargo_ammo_candidates(weapon_charges: &[Vec<i64>], cargo: &[i64]) -> Vec<i64> {
    let loadable: std::collections::HashSet<i64> =
        weapon_charges.iter().flatten().copied().collect();
    let mut seen = std::collections::HashSet::new();
    cargo
        .iter()
        .copied()
        .filter(|c| loadable.contains(c) && seen.insert(*c))
        .collect()
}

/// For every ammo type in the cargo hold that a fitted weapon can load, the
/// fit's weapon DPS, engagement range and tracking with that ammo loaded — an
/// ammo comparison for picking the right load for the range. Empty when the fit
/// has no chargeable weapons or no loadable cargo ammo. `skill_source` matches
/// [`fitting_simulate`]'s basis.
#[tauri::command]
pub async fn fitting_ammo_table(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
    fit: Fit,
    skill_source: Option<String>,
) -> Result<Vec<AmmoRow>, String> {
    // Skills first (async), before opening the SDE — see resolve_skill_levels.
    let levels = resolve_skill_levels(&app, &auth_state, skill_source.as_deref()).await;
    let lookup = skill_fn(levels.as_ref());
    let (dir, sde) = crate::sde::dir_and_sde(&app)?;

    // Fitted high-slot weapons that accept a charge (turrets/launchers), each
    // mapped to the charges it can load. Ancillary reps are low slot;
    // smartbombs/neuts take none, so `compatible_charges` is empty for them.
    let mut weapon_charges: HashMap<i64, Vec<i64>> = HashMap::new();
    for it in fit.items.iter().filter(|i| i.slot == SlotKind::High) {
        if weapon_charges.contains_key(&it.type_id) {
            continue;
        }
        let charges = sde
            .compatible_charges(it.type_id)
            .map_err(|e| e.to_string())?;
        if !charges.is_empty() {
            weapon_charges.insert(it.type_id, charges.into_iter().map(|(id, _)| id).collect());
        }
    }
    if weapon_charges.is_empty() {
        return Ok(Vec::new());
    }

    let cargo: Vec<i64> = fit
        .items
        .iter()
        .filter(|i| i.slot == SlotKind::Cargo)
        .map(|i| i.type_id)
        .collect();
    let sets: Vec<Vec<i64>> = weapon_charges.values().cloned().collect();
    let candidates = cargo_ammo_candidates(&sets, &cargo);

    let mut rows = Vec::with_capacity(candidates.len());
    for ammo in candidates {
        // Load this ammo into every high-slot weapon that can take it.
        let mut probe = fit.clone();
        for item in probe.items.iter_mut().filter(|i| i.slot == SlotKind::High) {
            if weapon_charges
                .get(&item.type_id)
                .is_some_and(|cs| cs.contains(&ammo))
            {
                item.charge_type_id = Some(ammo);
            }
        }
        let stats = simulate_fit(
            &sde, &dir, &probe, &lookup, None, None, None, None, None, None, None,
            None, // factor_reload (#871)
        )?;
        let dps = stats
            .dps
            .as_ref()
            .map(|d| d.turret + d.missile)
            .unwrap_or(0.0);
        let wr = stats
            .weapon_ranges
            .iter()
            .find(|w| w.charge_type_id == Some(ammo));
        rows.push(AmmoRow {
            type_id: ammo,
            name: sde.type_name_or_id(ammo),
            dps,
            optimal: wr.map(|w| w.optimal).unwrap_or(0.0),
            falloff: wr.map(|w| w.falloff).unwrap_or(0.0),
            tracking: wr.map(|w| w.tracking).unwrap_or(0.0),
        });
    }
    rows.sort_by(|a, b| {
        b.dps
            .partial_cmp(&a.dps)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    Ok(rows)
}

#[cfg(test)]
mod ammo_table_tests {
    use super::cargo_ammo_candidates;

    #[test]
    fn candidates_keep_only_loadable_cargo_ammo_deduped_in_order() {
        // Weapon 0 loads {10,11}; weapon 1 loads {11,12}. Cargo has a
        // non-loadable (99), loadables, and a duplicate (11).
        let weapons = vec![vec![10, 11], vec![11, 12]];
        let cargo = vec![99, 12, 11, 11, 10, 42];
        assert_eq!(cargo_ammo_candidates(&weapons, &cargo), vec![12, 11, 10]);
    }

    #[test]
    fn no_weapons_yields_no_candidates() {
        assert!(cargo_ammo_candidates(&[], &[10, 11]).is_empty());
    }
}

/// Load `ammo_type_id` into every fitted high-slot weapon that can take it —
/// the "fit this cargo ammo to all my weapons" action. Weapons that can't load
/// it are left untouched. Returns the updated fit.
#[tauri::command]
pub fn fitting_load_ammo(app: AppHandle, fit: Fit, ammo_type_id: i64) -> Result<Fit, String> {
    let sde = crate::sde::open_from_app(&app)?;
    let mut out = fit;
    for item in out.items.iter_mut().filter(|i| i.slot == SlotKind::High) {
        let loadable = sde
            .compatible_charges(item.type_id)
            .map(|cs| cs.iter().any(|(id, _)| *id == ammo_type_id))
            .unwrap_or(false);
        if loadable {
            item.charge_type_id = Some(ammo_type_id);
        }
    }
    Ok(out)
}

/// What a price line is worth in total: unit buy price × quantity (unpriced
/// lines count as zero). Pure (testable).
fn line_value(line: &FitPriceLine) -> f64 {
    line.buy_unit.unwrap_or(0.0) * line.quantity as f64
}

/// Price a whole fit (hull + modules + charges + drones/cargo) at a market
/// (#163), reusing the shared market service's bulk aggregates.
#[tauri::command]
pub async fn fitting_price(
    app: AppHandle,
    market: State<'_, MarketService>,
    fit: Fit,
    region_id: i64,
    station_id: Option<i64>,
) -> Result<FitPrice, String> {
    let sde = crate::sde::open_from_app(&app)?;

    // type_id -> total quantity (hull + items + charges), summing duplicates.
    let mut qty: HashMap<i64, i32> = HashMap::new();
    *qty.entry(fit.ship_type_id).or_default() += 1;
    for item in &fit.items {
        *qty.entry(item.type_id).or_default() += item.quantity.max(1);
        if let Some(charge) = item.charge_type_id {
            *qty.entry(charge).or_default() += 1;
        }
    }

    let ids: Vec<i64> = qty.keys().copied().collect();
    let location = resolve_location(region_id, station_id);
    let prices = market
        .price_map_at(location, &ids)
        .await
        .map_err(|e| e.to_string())?;

    let mut lines = Vec::with_capacity(qty.len());
    let (mut buy_total, mut sell_total) = (0.0, 0.0);
    for (type_id, quantity) in qty {
        let model = prices.get(type_id);
        let buy_unit = model.and_then(|m| m.sell_min);
        let sell_unit = model.and_then(|m| m.buy_max);
        buy_total += buy_unit.unwrap_or(0.0) * quantity as f64;
        sell_total += sell_unit.unwrap_or(0.0) * quantity as f64;
        let name = sde.type_name_or_id(type_id);
        lines.push(FitPriceLine {
            type_id,
            name,
            quantity,
            buy_unit,
            sell_unit,
        });
    }
    // Most valuable lines first — by what the line is worth in total, so a big
    // stack of cheap charges outranks one cheap-per-unit module.
    lines.sort_by(|a, b| {
        line_value(b)
            .partial_cmp(&line_value(a))
            .unwrap_or(std::cmp::Ordering::Equal)
    });

    Ok(FitPrice {
        buy_total,
        sell_total,
        lines,
    })
}

/// The local saved-fits document.
fn load_fits(dir: &Path) -> Vec<Fit> {
    storage::load_data(dir, FITS_KEY).unwrap_or_default()
}

/// Save (insert or update by id) a fit locally; returns its id (#164).
#[tauri::command]
pub fn fitting_save_local(app: AppHandle, mut fit: Fit) -> Result<String, String> {
    let dir = storage::app_data_dir(&app)?;
    if fit.id.is_empty() {
        fit.id = new_fit_id();
    }
    let mut fits = load_fits(&dir);
    match fits.iter_mut().find(|f| f.id == fit.id) {
        Some(existing) => *existing = fit.clone(),
        None => fits.push(fit.clone()),
    }
    storage::save_data(&dir, FITS_KEY, &fits)?;
    Ok(fit.id)
}

/// All locally saved fits (#164).
#[tauri::command]
pub fn fitting_list_local(app: AppHandle) -> Result<Vec<Fit>, String> {
    let dir = storage::app_data_dir(&app)?;
    Ok(load_fits(&dir))
}

/// Delete a locally saved fit by id (no-op if absent) (#164).
#[tauri::command]
pub fn fitting_delete_local(app: AppHandle, id: String) -> Result<(), String> {
    let dir = storage::app_data_dir(&app)?;
    let mut fits = load_fits(&dir);
    fits.retain(|f| f.id != id);
    storage::save_data(&dir, FITS_KEY, &fits)
}

/// Storage key for the user's custom target/damage profile presets (#873).
const CUSTOM_TARGET_PROFILES_KEY: &str = "fitting_custom_target_profiles";
/// Disk-cache key for the SDE-derived built-in library (#873), generation-keyed
/// (see `sde::generation_id`) so an SDE update invalidates it immediately
/// instead of waiting out the TTL.
const NPC_PROFILE_CACHE_KEY: &str = "fitting_npc_profiles";
/// Rebuilding the built-in library is a handful of SDE queries — cheap, but
/// not free, so it's cached for a week (well past any plausible SDE update
/// cadence; `cache_get_versioned` invalidates on SDE swap regardless).
const NPC_PROFILE_CACHE_TTL_SECS: u64 = 7 * 24 * 3600;

/// The user's persisted custom target/damage profile presets (#873).
fn load_custom_profiles(dir: &Path) -> Vec<NpcProfile> {
    storage::load_data(dir, CUSTOM_TARGET_PROFILES_KEY).unwrap_or_default()
}

/// The built-in NPC target/damage profile library plus the user's persisted
/// custom presets (#873): `TargetProfileBox` and the tank panel's damage
/// picker both source their grouped, searchable dropdowns from this. The
/// built-in half is derived from real SDE NPC ship dogma attributes (see
/// `npc_profiles`) and cached per SDE generation.
#[tauri::command]
pub fn fitting_target_profiles(app: AppHandle) -> Result<TargetProfileLibrary, String> {
    let dir = storage::app_data_dir(&app)?;
    let sde = crate::sde::open_from_app(&app)?;
    let generation = crate::sde::generation_id(&dir)?;
    let built_in = if let Some(cached) =
        storage::cache_get_versioned::<Vec<NpcProfile>>(&dir, NPC_PROFILE_CACHE_KEY, generation)
    {
        cached
    } else {
        let built = npc_profiles::built_in_profiles(&sde);
        let _ = storage::cache_put_versioned(
            &dir,
            NPC_PROFILE_CACHE_KEY,
            &built,
            NPC_PROFILE_CACHE_TTL_SECS,
            generation,
        );
        built
    };
    Ok(TargetProfileLibrary {
        built_in,
        custom: load_custom_profiles(&dir),
    })
}

/// Save (insert or update by id) a custom target/damage profile preset
/// (#873); always grouped as "Custom" regardless of what the caller sends.
/// Returns the preset's id.
#[tauri::command]
pub fn fitting_save_target_profile(
    app: AppHandle,
    mut profile: NpcProfile,
) -> Result<String, String> {
    let dir = storage::app_data_dir(&app)?;
    if profile.id.is_empty() {
        profile.id = new_fit_id();
    }
    profile.group = "Custom".to_string();
    let mut profiles = load_custom_profiles(&dir);
    match profiles.iter_mut().find(|p| p.id == profile.id) {
        Some(existing) => *existing = profile.clone(),
        None => profiles.push(profile.clone()),
    }
    storage::save_data(&dir, CUSTOM_TARGET_PROFILES_KEY, &profiles)?;
    Ok(profile.id)
}

/// Delete a custom target/damage profile preset by id (no-op if absent) (#873).
#[tauri::command]
pub fn fitting_delete_target_profile(app: AppHandle, id: String) -> Result<(), String> {
    let dir = storage::app_data_dir(&app)?;
    let mut profiles = load_custom_profiles(&dir);
    profiles.retain(|p| p.id != id);
    storage::save_data(&dir, CUSTOM_TARGET_PROFILES_KEY, &profiles)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::fitting::engine::tank::DamageProfile;
    use crate::modules::fitting::stats::run_dogma;

    #[test]
    fn price_lines_rank_by_total_line_value() {
        let line = |name: &str, qty: i32, unit: Option<f64>| FitPriceLine {
            type_id: 1,
            name: name.into(),
            quantity: qty,
            buy_unit: unit,
            sell_unit: None,
        };
        // 1000 rounds at 50 ISK (50k) beat one module at 20k, even though the
        // module is far dearer per unit.
        let ammo = line("Ammo", 1000, Some(50.0));
        let module = line("Module", 1, Some(20_000.0));
        assert!(line_value(&ammo) > line_value(&module));
        // Unpriced lines sort last rather than blowing up.
        assert_eq!(line_value(&line("Unknown", 5, None)), 0.0);
    }

    fn item(type_id: i64, slot: SlotKind, charge: Option<i64>, qty: i32) -> FitItem {
        FitItem {
            type_id,
            slot,
            index: 0,
            state: ModuleState::Active,
            charge_type_id: charge,
            quantity: qty,
            active_drones: None,
            mutation: None,
        }
    }

    /// A T2 turret should report both optimal *and* falloff (gated on the SDE).
    #[test]
    fn t2_turret_reports_optimal_and_falloff() {
        let Some(path) = std::env::var_os("EVE_SDE_PATH") else {
            eprintln!("t2_turret_reports_optimal_and_falloff: EVE_SDE_PATH unset — skipping");
            return;
        };
        let path = std::path::PathBuf::from(&path);
        if !path.exists() {
            return;
        }
        let sde = Sde::open(&path).unwrap();
        let dir = path.parent().unwrap();
        let tid = |n: &str| sde.type_by_name(n).unwrap().unwrap().0;
        let fit = Fit {
            id: "t".into(),
            name: "t".into(),
            ship_type_id: tid("Rifter"),
            items: vec![FitItem {
                type_id: tid("200mm AutoCannon II"),
                slot: SlotKind::High,
                index: 0,
                state: ModuleState::Active,
                charge_type_id: Some(tid("Republic Fleet EMP S")),
                quantity: 1,
                active_drones: None,
                mutation: None,
            }],
            projected: Vec::new(),
        };
        let layout = sde.ship_layout(fit.ship_type_id).unwrap().unwrap();
        let d = run_dogma(
            &sde,
            dir,
            &fit,
            &layout,
            &|_| 5.0,
            &DamageProfile::default(),
            0.0,
            None,
            &[],
            None,
            None,
            1.0,
            false, // factor_reload (#871)
        )
        .unwrap();
        let r = d.weapon_ranges.first().expect("a weapon range");
        // A turret has both an optimal and a (larger, for autocannons) falloff.
        assert!(r.optimal > 0.0, "optimal should be set: {r:?}");
        assert!(r.falloff > 0.0, "falloff should be set: {r:?}");

        // A laser crystal with a range multiplier (Scorch) must keep its falloff:
        // the crystal lacks `fallofMultiplier` (default 1.0), so the charge→host
        // falloff multiplier must be a no-op, not ×0 (regression).
        let scorch = Fit {
            id: "t".into(),
            name: "t".into(),
            ship_type_id: tid("Punisher"),
            items: vec![FitItem {
                type_id: tid("Dual Light Pulse Laser II"),
                slot: SlotKind::High,
                index: 0,
                state: ModuleState::Active,
                charge_type_id: Some(tid("Scorch S")),
                quantity: 1,
                active_drones: None,
                mutation: None,
            }],
            projected: Vec::new(),
        };
        let layout = sde.ship_layout(scorch.ship_type_id).unwrap().unwrap();
        let d = run_dogma(
            &sde,
            dir,
            &scorch,
            &layout,
            &|_| 5.0,
            &DamageProfile::default(),
            0.0,
            None,
            &[],
            None,
            None,
            1.0,
            false, // factor_reload (#871)
        )
        .unwrap();
        let r = d.weapon_ranges.first().expect("a laser range");
        assert!(r.falloff > 0.0, "Scorch should keep falloff: {r:?}");
    }

    /// An offline module contributes nothing: a disabled gun does 0 DPS, costs no
    /// CPU/PG, and reports no range (gated on the SDE).
    #[test]
    fn offline_module_drops_its_contribution() {
        let Some(path) = std::env::var_os("EVE_SDE_PATH") else {
            return;
        };
        let path = std::path::PathBuf::from(&path);
        if !path.exists() {
            return;
        }
        let sde = Sde::open(&path).unwrap();
        let dir = path.parent().unwrap();
        let tid = |n: &str| sde.type_by_name(n).unwrap().unwrap().0;
        let gun = |state: ModuleState| Fit {
            id: "t".into(),
            name: "t".into(),
            ship_type_id: tid("Rifter"),
            items: vec![FitItem {
                type_id: tid("200mm AutoCannon II"),
                slot: SlotKind::High,
                index: 0,
                state,
                charge_type_id: Some(tid("Republic Fleet EMP S")),
                quantity: 1,
                active_drones: None,
                mutation: None,
            }],
            projected: Vec::new(),
        };
        let layout = sde.ship_layout(tid("Rifter")).unwrap().unwrap();
        let active = run_dogma(
            &sde,
            dir,
            &gun(ModuleState::Active),
            &layout,
            &|_| 5.0,
            &DamageProfile::default(),
            0.0,
            None,
            &[],
            None,
            None,
            1.0,
            false, // factor_reload (#871)
        )
        .unwrap();
        let online = run_dogma(
            &sde,
            dir,
            &gun(ModuleState::Online),
            &layout,
            &|_| 5.0,
            &DamageProfile::default(),
            0.0,
            None,
            &[],
            None,
            None,
            1.0,
            false, // factor_reload (#871)
        )
        .unwrap();
        let offline = run_dogma(
            &sde,
            dir,
            &gun(ModuleState::Offline),
            &layout,
            &|_| 5.0,
            &DamageProfile::default(),
            0.0,
            None,
            &[],
            None,
            None,
            1.0,
            false, // factor_reload (#871)
        )
        .unwrap();
        assert!(active.dps.total > 0.0);
        assert_eq!(offline.dps.total, 0.0, "offline gun should do no DPS");
        assert!(
            offline.weapon_ranges.is_empty(),
            "offline gun shows no range"
        );
        assert!(
            offline.resources.cpu_used < active.resources.cpu_used,
            "offline gun should free CPU"
        );
        // Online (deactivated): no DPS, but still online and using CPU/PG.
        assert_eq!(online.dps.total, 0.0, "deactivated gun should do no DPS");
        assert!(
            (online.resources.cpu_used - active.resources.cpu_used).abs() < 0.01,
            "online gun still consumes CPU"
        );
    }

    /// Deactivated/offline modules draw no capacitor (gated on the SDE).
    #[test]
    fn inactive_and_offline_modules_draw_no_cap() {
        let Some(path) = std::env::var_os("EVE_SDE_PATH") else {
            return;
        };
        let path = std::path::PathBuf::from(&path);
        if !path.exists() {
            return;
        }
        let sde = Sde::open(&path).unwrap();
        let dir = path.parent().unwrap();
        let tid = |n: &str| sde.type_by_name(n).unwrap().unwrap().0;
        // An afterburner is an active, cap-using module on a Rifter.
        let ab = |state: ModuleState| Fit {
            id: "t".into(),
            name: "t".into(),
            ship_type_id: tid("Rifter"),
            items: vec![FitItem {
                type_id: tid("1MN Afterburner II"),
                slot: SlotKind::Mid,
                index: 0,
                state,
                charge_type_id: None,
                quantity: 1,
                active_drones: None,
                mutation: None,
            }],
            projected: Vec::new(),
        };
        let layout = sde.ship_layout(tid("Rifter")).unwrap().unwrap();
        let active = run_dogma(
            &sde,
            dir,
            &ab(ModuleState::Active),
            &layout,
            &|_| 5.0,
            &DamageProfile::default(),
            0.0,
            None,
            &[],
            None,
            None,
            1.0,
            false, // factor_reload (#871)
        )
        .unwrap();
        let online = run_dogma(
            &sde,
            dir,
            &ab(ModuleState::Online),
            &layout,
            &|_| 5.0,
            &DamageProfile::default(),
            0.0,
            None,
            &[],
            None,
            None,
            1.0,
            false, // factor_reload (#871)
        )
        .unwrap();
        let offline = run_dogma(
            &sde,
            dir,
            &ab(ModuleState::Offline),
            &layout,
            &|_| 5.0,
            &DamageProfile::default(),
            0.0,
            None,
            &[],
            None,
            None,
            1.0,
            false, // factor_reload (#871)
        )
        .unwrap();
        assert!(active.capacitor.drain > 0.0, "active AB draws cap");
        assert_eq!(online.capacitor.drain, 0.0, "deactivated AB draws no cap");
        assert_eq!(offline.capacitor.drain, 0.0, "offline AB draws no cap");
        // The AB itself is activatable; a plate would not be.
        assert!(active
            .activatable_types
            .contains(&tid("1MN Afterburner II")));
    }

    /// Deactivating (online) an *active* shield hardener drops its resist, so EHP
    /// falls — but a passive module would be unchanged (gated on the SDE).
    #[test]
    fn deactivated_active_hardener_loses_resist() {
        let Some(path) = std::env::var_os("EVE_SDE_PATH") else {
            return;
        };
        let path = std::path::PathBuf::from(&path);
        if !path.exists() {
            return;
        }
        let sde = Sde::open(&path).unwrap();
        let dir = path.parent().unwrap();
        let tid = |n: &str| sde.type_by_name(n).unwrap().unwrap().0;
        let hardener = |state: ModuleState| Fit {
            id: "t".into(),
            name: "t".into(),
            ship_type_id: tid("Caracal"),
            items: vec![FitItem {
                type_id: tid("Multispectrum Shield Hardener II"),
                slot: SlotKind::Mid,
                index: 0,
                state,
                charge_type_id: None,
                quantity: 1,
                active_drones: None,
                mutation: None,
            }],
            projected: Vec::new(),
        };
        let layout = sde.ship_layout(tid("Caracal")).unwrap().unwrap();
        let active = run_dogma(
            &sde,
            dir,
            &hardener(ModuleState::Active),
            &layout,
            &|_| 5.0,
            &DamageProfile::default(),
            0.0,
            None,
            &[],
            None,
            None,
            1.0,
            false, // factor_reload (#871)
        )
        .unwrap();
        let online = run_dogma(
            &sde,
            dir,
            &hardener(ModuleState::Online),
            &layout,
            &|_| 5.0,
            &DamageProfile::default(),
            0.0,
            None,
            &[],
            None,
            None,
            1.0,
            false, // factor_reload (#871)
        )
        .unwrap();
        assert!(
            active.tank.ehp > online.tank.ehp,
            "active hardener should raise EHP vs deactivated: {} vs {}",
            active.tank.ehp,
            online.tank.ehp
        );
    }

    /// End-to-end (#701): a Rifter with an autocannon, against a Frigate
    /// target profile, applies less DPS than the paper figure — and the
    /// DPS-vs-range curve is populated (gated on the SDE).
    #[test]
    fn applied_dps_and_range_curve_populate_against_a_target() {
        let Some(path) = std::env::var_os("EVE_SDE_PATH") else {
            return;
        };
        let path = std::path::PathBuf::from(&path);
        if !path.exists() {
            return;
        }
        let sde = Sde::open(&path).unwrap();
        let dir = path.parent().unwrap();
        let tid = |n: &str| sde.type_by_name(n).unwrap().unwrap().0;
        let fit = Fit {
            id: "t".into(),
            name: "t".into(),
            ship_type_id: tid("Rifter"),
            items: vec![FitItem {
                type_id: tid("200mm AutoCannon II"),
                slot: SlotKind::High,
                index: 0,
                state: ModuleState::Active,
                charge_type_id: Some(tid("Republic Fleet EMP S")),
                quantity: 1,
                active_drones: None,
                mutation: None,
            }],
            projected: Vec::new(),
        };
        let layout = sde.ship_layout(fit.ship_type_id).unwrap().unwrap();
        let target = crate::modules::fitting::types::TargetProfile {
            sig_radius: 40.0,
            speed: 400.0,
            angular_velocity: 0.02, // 400 m/s ÷ 20km, the old derivation
            drones_keep_pace: false,
            missiles_need_overtake: false,
        };
        let d = run_dogma(
            &sde,
            dir,
            &fit,
            &layout,
            &|_| 5.0,
            &DamageProfile::default(),
            0.0,
            Some(&target),
            &[],
            None,
            None,
            1.0,
            false, // factor_reload (#871)
        )
        .unwrap();
        let applied = d.applied_dps.expect("applied dps when a target is given");
        assert!(
            applied.total < d.dps.total,
            "applied {} should be below paper {}",
            applied.total,
            d.dps.total
        );
        assert_eq!(d.dps_range_curve.len(), 30, "30 sampled points");
        assert!(
            d.dps_range_curve.iter().all(|&(dist, _)| dist >= 0.0),
            "every sampled distance is non-negative"
        );
    }

    /// A T2 skirmish command burst raises the receiving ship's max velocity
    /// (#705). **Currently fails against the real SDE** — not a test bug:
    /// modern command-burst modules (e.g. Skirmish Command Burst II) carry no
    /// computable dogma modifier for their actual bonus (`moduleBonusWarfare
    /// LinkSkirmish`'s `modifierInfo` is empty in the SDE), and the charge's
    /// effect (`chargeBonusWarfareCharge`) targets `otherID`-domain
    /// attributes that are an indirection into CCP's separate "Warfare
    /// Buffs" FSD data (`warfareBuffs.yaml`), which Fuzzwork's dogma-only
    /// SQLite export doesn't carry. The #705 fleet-boosts feature as built
    /// (assuming a `GangModifier`-shaped effect) can't model this class of
    /// module from this data source — it needs a warfare-buffs data pipeline
    /// that doesn't exist yet. Ignored rather than silently weakened so this
    /// stays a visible, honest TODO instead of green-but-wrong.
    #[test]
    #[ignore = "needs a warfare-buffs data source; see doc comment"]
    fn fleet_boost_raises_ship_speed() {
        let Some(path) = std::env::var_os("EVE_SDE_PATH") else {
            eprintln!("fleet_boost_raises_ship_speed: EVE_SDE_PATH unset — skipping");
            return;
        };
        let path = std::path::PathBuf::from(&path);
        if !path.exists() {
            return;
        }
        let sde = Sde::open(&path).unwrap();
        let dir = path.parent().unwrap();
        let tid = |n: &str| sde.type_by_name(n).unwrap().unwrap().0;
        let fit = Fit {
            id: "t".into(),
            name: "t".into(),
            ship_type_id: tid("Rifter"),
            items: Vec::new(),
            projected: Vec::new(),
        };
        let layout = sde.ship_layout(fit.ship_type_id).unwrap().unwrap();
        let baseline = run_dogma(
            &sde,
            dir,
            &fit,
            &layout,
            &|_| 5.0,
            &DamageProfile::default(),
            0.0,
            None,
            &[],
            None,
            None,
            1.0,
            false, // factor_reload (#871)
        )
        .unwrap();
        let boosted = run_dogma(
            &sde,
            dir,
            &fit,
            &layout,
            &|_| 5.0,
            &DamageProfile::default(),
            0.0,
            None,
            &[(
                tid("Skirmish Command Burst II"),
                tid("Evasive Maneuvers Charge"),
            )],
            None,
            None,
            1.0,
            false, // factor_reload (#871)
        )
        .unwrap();
        assert!(
            boosted.navigation.max_velocity > baseline.navigation.max_velocity,
            "boosted {} should exceed baseline {}",
            boosted.navigation.max_velocity,
            baseline.navigation.max_velocity
        );
    }

    /// A Class 1 Pulsar wormhole environment raises the ship's shield HP
    /// (gated on the SDE) — the beacon's `ItemModifier` effect (sourced from
    /// its own `shieldBonus`-style attribute) projects onto the ship through
    /// the same external-modifier pass as a fleet boost.
    #[test]
    fn environment_effect_raises_shield_hp() {
        let Some(path) = std::env::var_os("EVE_SDE_PATH") else {
            eprintln!("environment_effect_raises_shield_hp: EVE_SDE_PATH unset — skipping");
            return;
        };
        let path = std::path::PathBuf::from(&path);
        if !path.exists() {
            return;
        }
        let sde = Sde::open(&path).unwrap();
        let dir = path.parent().unwrap();
        let tid = |n: &str| sde.type_by_name(n).unwrap().unwrap().0;
        let fit = Fit {
            id: "t".into(),
            name: "t".into(),
            ship_type_id: tid("Rifter"),
            items: Vec::new(),
            projected: Vec::new(),
        };
        let layout = sde.ship_layout(fit.ship_type_id).unwrap().unwrap();
        let baseline = run_dogma(
            &sde,
            dir,
            &fit,
            &layout,
            &|_| 5.0,
            &DamageProfile::default(),
            0.0,
            None,
            &[],
            None,
            None,
            1.0,
            false, // factor_reload (#871)
        )
        .unwrap();
        let in_pulsar = run_dogma(
            &sde,
            dir,
            &fit,
            &layout,
            &|_| 5.0,
            &DamageProfile::default(),
            0.0,
            None,
            &[],
            Some(tid("Class 1 Pulsar Effects")),
            None,
            1.0,
            false, // factor_reload (#871)
        )
        .unwrap();
        assert!(
            in_pulsar.tank.shield_hp > baseline.tank.shield_hp,
            "in-pulsar shield HP {} should exceed baseline {}",
            in_pulsar.tank.shield_hp,
            baseline.tank.shield_hp
        );
    }

    /// Abyssal Gamma weather raises shield HP by a flat 50% regardless of
    /// tier (gated on the SDE) — proves the whole pipeline end to end
    /// (command param -> `simulate_fit` -> `run_dogma` -> `engine::abyssal`),
    /// not just the pure unit tests in `engine/abyssal.rs`.
    #[test]
    fn abyssal_gamma_weather_raises_shield_hp() {
        let Some(path) = std::env::var_os("EVE_SDE_PATH") else {
            eprintln!("abyssal_gamma_weather_raises_shield_hp: EVE_SDE_PATH unset — skipping");
            return;
        };
        let path = std::path::PathBuf::from(&path);
        if !path.exists() {
            return;
        }
        let sde = Sde::open(&path).unwrap();
        let dir = path.parent().unwrap();
        let tid = |n: &str| sde.type_by_name(n).unwrap().unwrap().0;
        let fit = Fit {
            id: "t".into(),
            name: "t".into(),
            ship_type_id: tid("Retribution"),
            items: Vec::new(),
            projected: Vec::new(),
        };
        let layout = sde.ship_layout(fit.ship_type_id).unwrap().unwrap();
        let baseline = run_dogma(
            &sde,
            dir,
            &fit,
            &layout,
            &|_| 5.0,
            &DamageProfile::default(),
            0.0,
            None,
            &[],
            None,
            None,
            1.0,
            false, // factor_reload (#871)
        )
        .unwrap();
        let in_gamma = run_dogma(
            &sde,
            dir,
            &fit,
            &layout,
            &|_| 5.0,
            &DamageProfile::default(),
            0.0,
            None,
            &[],
            None,
            Some(AbyssalWeatherSelection {
                weather: crate::modules::fitting::types::AbyssalWeather::Gamma,
                tier_pct: 70.0,
            }),
            1.0,
            false, // factor_reload (#871)
        )
        .unwrap();
        assert!(
            (in_gamma.tank.shield_hp - baseline.tank.shield_hp * 1.5).abs() < 1e-6,
            "gamma shield HP {} should be exactly baseline {} × 1.5",
            in_gamma.tank.shield_hp,
            baseline.tank.shield_hp
        );
    }

    /// `next_slot_index` fills from 0 and appends one past the highest in-slot.
    #[test]
    fn next_slot_index_appends_per_slot() {
        let mut items = vec![
            item(10, SlotKind::Low, None, 1),
            item(20, SlotKind::High, None, 1),
        ];
        items[0].index = 0;
        items[1].index = 0;
        // Empty slot starts at 0; occupied slots continue past their max.
        assert_eq!(next_slot_index(&items, SlotKind::Mid), 0);
        assert_eq!(next_slot_index(&items, SlotKind::Low), 1);
        items.push(FitItem {
            index: 1,
            ..item(11, SlotKind::Low, None, 1)
        });
        assert_eq!(next_slot_index(&items, SlotKind::Low), 2);
    }

    #[test]
    fn parse_qty_accepts_only_numbers() {
        assert_eq!(parse_qty("5"), Some(5));
        assert_eq!(parse_qty("1,000"), Some(1000));
        assert_eq!(parse_qty(" 42 "), Some(42));
        assert_eq!(parse_qty("II"), None);
        assert_eq!(parse_qty("Warrior"), None);
        assert_eq!(parse_qty(""), None);
    }

    #[test]
    fn parse_item_line_handles_common_paste_shapes() {
        // Plain name.
        assert_eq!(
            parse_item_line("Warrior II"),
            Some(("Warrior II".into(), 1)),
        );
        // Multibuy: trailing "xN" and " N".
        assert_eq!(
            parse_item_line("Warrior II x5"),
            Some(("Warrior II".into(), 5)),
        );
        assert_eq!(
            parse_item_line("Scourge Rage Rocket 5000"),
            Some(("Scourge Rage Rocket".into(), 5000)),
        );
        // Tab-separated (contract/inventory): name col + first integer col.
        assert_eq!(
            parse_item_line("Rifter\t1\tFrigate\tShip"),
            Some(("Rifter".into(), 1)),
        );
        // A trailing non-number stays part of the name.
        assert_eq!(
            parse_item_line("125mm Gatling AutoCannon II"),
            Some(("125mm Gatling AutoCannon II".into(), 1)),
        );
        // Blank line.
        assert_eq!(parse_item_line("   "), None);
    }

    /// End-to-end paste-list import against the real SDE (gated on
    /// `EVE_SDE_PATH`, like the golden suite): resolves names, picks the hull,
    /// classifies slots, stacks drones/ammo. Skips when the SDE isn't present.
    #[test]
    fn import_list_builds_a_fit_from_a_pasted_list() {
        let Ok(path) = std::env::var("EVE_SDE_PATH") else {
            eprintln!("import_list…: EVE_SDE_PATH unset — skipping");
            return;
        };
        if !std::path::Path::new(&path).exists() {
            eprintln!("import_list…: {path} missing — skipping");
            return;
        }
        let sde = crate::sde::Sde::open(std::path::Path::new(&path)).expect("open sde");
        let list = "\
Rifter
200mm AutoCannon II
Warp Scrambler II
Small Armor Repairer II
Hobgoblin II x5
Barrage S 1000
Nanite Repair Paste\t50\tCommodity";
        let fit = import_list_to_fit(&sde, list).expect("import");
        let rifter = sde.type_by_name("Rifter").unwrap().unwrap().0;
        assert_eq!(fit.ship_type_id, rifter, "hull is the Rifter");
        assert!(fit.name.ends_with("(imported)"));
        assert!(fit.items.iter().all(|i| i.type_id != rifter));
        assert!(fit.items.iter().any(|i| i.slot == SlotKind::High));
        let drones = sde.type_by_name("Hobgoblin II").unwrap().unwrap().0;
        let drone = fit.items.iter().find(|i| i.type_id == drones).unwrap();
        assert_eq!(drone.slot, SlotKind::Drone);
        assert_eq!(drone.quantity, 5);
        let barrage = sde.type_by_name("Barrage S").unwrap().unwrap().0;
        let ammo = fit.items.iter().find(|i| i.type_id == barrage).unwrap();
        assert_eq!(ammo.slot, SlotKind::Cargo);
        assert_eq!(ammo.quantity, 1000);
    }

    /// Real killboard-style DNA string (EVE Developer Documentation's
    /// "Heron Navy Issue" example) importing end-to-end against the real SDE:
    /// hull resolves, modules classify into their slots, and the trailing
    /// scanner-probe stack (a charge-category item) lands unfitted in cargo.
    #[test]
    fn import_dna_builds_a_fit_from_a_real_killboard_string() {
        let Ok(path) = std::env::var("EVE_SDE_PATH") else {
            eprintln!("import_dna…: EVE_SDE_PATH unset — skipping");
            return;
        };
        if !std::path::Path::new(&path).exists() {
            eprintln!("import_dna…: {path} missing — skipping");
            return;
        }
        let sde = crate::sde::Sde::open(std::path::Path::new(&path)).expect("open sde");
        let dna_text = "72904:4250;2:4258;1:11577;1:33199;1:33201;1:33197;1:9580;1:9568;1:1405;2:31220;1:31788;1:30488;8::";
        let fit = import_dna_to_fit(&sde, dna_text).expect("import");
        assert_eq!(fit.ship_type_id, 72904, "hull is the Heron Navy Issue");
        assert!(fit.name.ends_with("(DNA imported)"));
        // Two Small Tractor Beam II (4250) expand into two separate high-slot items.
        assert_eq!(fit.items.iter().filter(|i| i.type_id == 4250).count(), 2);
        assert!(fit
            .items
            .iter()
            .filter(|i| i.type_id == 4250)
            .all(|i| i.slot == SlotKind::High));
        // The scanner-probe stack (charge category) lands unfitted in cargo, not fitted.
        let probes = fit.items.iter().find(|i| i.type_id == 30488).unwrap();
        assert_eq!(probes.slot, SlotKind::Cargo);
        assert_eq!(probes.quantity, 8);
    }

    /// A T3 cruiser DNA string built from real Legion + subsystem type ids
    /// (#879 acceptance): all 4 subsystems classify into the Subsystem slot
    /// from their own dogma effects, same as every other module.
    #[test]
    fn import_dna_handles_t3_cruiser_subsystems() {
        let Ok(path) = std::env::var("EVE_SDE_PATH") else {
            eprintln!("import_dna t3c…: EVE_SDE_PATH unset — skipping");
            return;
        };
        if !std::path::Path::new(&path).exists() {
            eprintln!("import_dna t3c…: {path} missing — skipping");
            return;
        }
        let sde = crate::sde::Sde::open(std::path::Path::new(&path)).expect("open sde");
        let id = |name: &str| sde.type_by_name(name).unwrap().unwrap().0;
        let legion = id("Legion");
        let core = id("Legion Core - Augmented Antimatter Reactor");
        let defensive = id("Legion Defensive - Augmented Plating");
        let offensive = id("Legion Offensive - Assault Optimization");
        let propulsion = id("Legion Propulsion - Intercalated Nanofibers");
        let gyro = id("Gyrostabilizer II");
        let drone = id("Hobgoblin II");
        let dna_text = format!(
            "{legion}:{core};1:{defensive};1:{offensive};1:{propulsion};1:{gyro};1:{drone};5::"
        );
        let fit = import_dna_to_fit(&sde, &dna_text).expect("import");
        assert_eq!(fit.ship_type_id, legion);
        for sub in [core, defensive, offensive, propulsion] {
            let item = fit.items.iter().find(|i| i.type_id == sub).unwrap();
            assert_eq!(item.slot, SlotKind::Subsystem, "subsystem {sub}");
        }
        let drone_item = fit.items.iter().find(|i| i.type_id == drone).unwrap();
        assert_eq!(drone_item.slot, SlotKind::Drone);
        assert_eq!(drone_item.quantity, 5);
    }

    /// DNA -> Fit -> DNA is stable (#879 acceptance) for a DNA string already
    /// in the canonical high→mid→low slot order our own exporter produces
    /// (as a real client/killboard export always is) — cross-slot ordering
    /// isn't itself preserved by the `Fit` model (only within-slot position
    /// is), so a hand-scrambled cross-slot order wouldn't round-trip byte
    /// for byte, same as pyfa's own canonical-order exporter.
    #[test]
    fn dna_round_trips_through_a_resolved_fit() {
        let Ok(path) = std::env::var("EVE_SDE_PATH") else {
            eprintln!("dna round-trip…: EVE_SDE_PATH unset — skipping");
            return;
        };
        if !std::path::Path::new(&path).exists() {
            eprintln!("dna round-trip…: {path} missing — skipping");
            return;
        }
        let sde = crate::sde::Sde::open(std::path::Path::new(&path)).expect("open sde");
        let id = |name: &str| sde.type_by_name(name).unwrap().unwrap().0;
        let rifter = id("Rifter");
        let gyro = id("Gyrostabilizer II");
        let ab = id("1MN Afterburner II");
        let scram = id("Warp Scrambler II");
        let gun = id("200mm AutoCannon II");
        let drone = id("Hobgoblin II");
        let dna_text = format!("{rifter}:{gun};2:{ab};1:{scram};1:{gyro};1:{drone};5::");
        let fit = import_dna_to_fit(&sde, &dna_text).expect("import");
        let round_tripped = fit_to_dna(&sde, &fit);
        assert_eq!(round_tripped, dna_text);
    }

    /// The paste-import entry point auto-detects DNA vs. EFT by shape (#879).
    #[test]
    fn looks_like_dna_distinguishes_from_eft_paste() {
        assert!(dna::looks_like_dna("587:519;1::"));
        assert!(!dna::looks_like_dna(
            "[Rifter, My Rifter]\n\nGyrostabilizer II"
        ));
    }

    /// MultiBuy output matches the fitted contents exactly (#879 acceptance):
    /// one `Name xQty` line per distinct type, modules + loaded charge +
    /// drones aggregated, hull excluded.
    #[test]
    fn multibuy_export_matches_fitted_contents() {
        let Ok(path) = std::env::var("EVE_SDE_PATH") else {
            eprintln!("multibuy…: EVE_SDE_PATH unset — skipping");
            return;
        };
        if !std::path::Path::new(&path).exists() {
            eprintln!("multibuy…: {path} missing — skipping");
            return;
        }
        let sde = crate::sde::Sde::open(std::path::Path::new(&path)).expect("open sde");
        let id = |name: &str| sde.type_by_name(name).unwrap().unwrap().0;
        let rifter = id("Rifter");
        let gun = id("200mm AutoCannon II");
        let barrage = id("Barrage S");
        let drone = id("Hobgoblin II");
        let fit = Fit {
            id: String::new(),
            name: "Test".into(),
            ship_type_id: rifter,
            items: vec![
                FitItem {
                    type_id: gun,
                    slot: SlotKind::High,
                    index: 0,
                    state: ModuleState::Active,
                    charge_type_id: Some(barrage),
                    quantity: 1,
                    active_drones: None,
                    mutation: None,
                },
                FitItem {
                    type_id: gun,
                    slot: SlotKind::High,
                    index: 1,
                    state: ModuleState::Active,
                    charge_type_id: Some(barrage),
                    quantity: 1,
                    active_drones: None,
                    mutation: None,
                },
                FitItem {
                    type_id: drone,
                    slot: SlotKind::Drone,
                    index: 0,
                    state: ModuleState::Active,
                    charge_type_id: None,
                    quantity: 5,
                    active_drones: None,
                    mutation: None,
                },
            ],
            projected: Vec::new(),
        };
        let text = fit_to_multibuy(&sde, &fit);
        assert_eq!(
            text,
            "200mm AutoCannon II x2\nBarrage S x2\nHobgoblin II x5"
        );
        // The hull itself isn't in the list.
        assert!(!text.contains("Rifter"));
    }
}
