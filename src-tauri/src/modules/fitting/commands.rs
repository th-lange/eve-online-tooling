//! Tauri command surface for the fitting module.
//!
//! Commands open the SDE read-only per call (cheap) and orchestrate the shared
//! services, like the production module. P1 adds pricing/validation/storage
//! commands here; the dogma `simulate` command lands with the engine (P2).

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, State};

use super::context::DogmaContext;
use super::eft::{self, ParsedEft, ParsedExtra, ParsedModule};
use super::engine::resolve::{resolve, FitInput};
use super::types::{Fit, FitItem, FitPrice, FitPriceLine, FitStats, ModuleState, SlotKind};
use crate::esi::{self, corporation_id, AuthState, SkillLevels};
use crate::market::{resolve_location, MarketService, PriceModel};
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
/// unknown ship is an error.
#[tauri::command]
pub fn fitting_import_eft(app: AppHandle, text: String) -> Result<Fit, String> {
    let sde = crate::sde::open_from_app(&app)?;
    let parsed = eft::parse_eft(&text).map_err(|e| e.to_string())?;

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
        let effects: Vec<i64> = sde
            .type_effects(type_id)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|(e, _)| e)
            .collect();
        let slot = eft::slot_for_effects(&effects).unwrap_or(SlotKind::Cargo);
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
/// otherwise from its slot-defining dogma effects, falling back to Cargo.
fn classify_slot(sde: &Sde, type_id: i64) -> Result<SlotKind, String> {
    match sde.type_category(type_id).map_err(|e| e.to_string())? {
        Some(18) => return Ok(SlotKind::Drone),
        Some(20) => return Ok(SlotKind::Implant),
        _ => {}
    }
    let effects: Vec<i64> = sde
        .type_effects(type_id)
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|(e, _)| e)
        .collect();
    Ok(eft::slot_for_effects(&effects).unwrap_or(SlotKind::Cargo))
}

/// Classify each type id's slot (for the add-module browser's slot badges, #168).
#[tauri::command]
pub fn fitting_classify_slots(
    app: AppHandle,
    type_ids: Vec<i64>,
) -> Result<Vec<(i64, SlotKind)>, String> {
    let sde = crate::sde::open_from_app(&app)?;
    type_ids
        .into_iter()
        .map(|id| Ok((id, classify_slot(&sde, id)?)))
        .collect()
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

/// Skill-level lookup for the dogma engine: the character's real level
/// (untrained = 0) when `levels` is `Some`, else all-V (5) as though every
/// skill were maxed. Shared by [`fitting_module_info`] and [`fitting_simulate`]
/// (#172–#177, #266).
fn skill_level_for(levels: Option<&SkillLevels>, skill_id: i64) -> f64 {
    match levels {
        Some(levels) => levels.level(skill_id) as f64,
        None => 5.0, // all-V
    }
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
    // Skills first (async) — the SDE connection below isn't Send across awaits.
    let levels: Option<SkillLevels> = if skill_source.as_deref() == Some("character") {
        character_skill_levels(&app, &auth_state).await.ok()
    } else {
        None
    };
    let lookup = |sid: i64| skill_level_for(levels.as_ref(), sid);

    let sde = crate::sde::open_from_app(&app)?;
    let costs = resolve_module_costs(&sde, ship_type_id, &lookup, &type_ids)?;
    type_ids
        .into_iter()
        .map(|id| {
            let (cpu, powergrid, calibration) = costs.get(&id).copied().unwrap_or((0.0, 0.0, 0.0));
            Ok(ModuleInfo {
                id,
                slot: classify_slot(&sde, id)?,
                cpu,
                powergrid,
                calibration,
            })
        })
        .collect()
}

/// Finalized CPU(50)/PG(30)/calibration(1153) for each candidate module, resolved
/// on `ship_type_id` with the active skills via the dogma engine — identical to
/// how fitted modules are computed. Resolving the candidates together is safe:
/// skill/role fitting reductions apply per module, not across them.
fn resolve_module_costs(
    sde: &Sde,
    ship_type_id: i64,
    skill_level_for: &dyn Fn(i64) -> f64,
    type_ids: &[i64],
) -> Result<HashMap<i64, (f64, f64, f64)>, String> {
    let mut extra_ids = Vec::with_capacity(1 + type_ids.len());
    extra_ids.push(ship_type_id);
    extra_ids.extend_from_slice(type_ids);
    let ctx = DogmaContext::load(sde, &extra_ids)?;

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
    });
    Ok(fit)
}

/// Serialize a [`Fit`] to an EFT clipboard string (#162). Modules are grouped by
/// slot (high → mid → low → rig → subsystem) in index order; drones and cargo
/// follow as `Name xN` lines.
#[tauri::command]
pub fn fitting_export_eft(app: AppHandle, fit: Fit) -> Result<String, String> {
    let sde = crate::sde::open_from_app(&app)?;

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

    Ok(eft::format_eft(&ParsedEft {
        ship_name,
        fit_name: fit.name.clone(),
        modules,
        extras,
    }))
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
    let granted = storage::load_roster(&dir)
        .iter()
        .find(|c| c.character_id == character_id)
        .map(|c| {
            c.scopes
                .iter()
                .any(|s| s == "esi-fittings.write_fittings.v1")
        })
        .unwrap_or(false);
    if !granted {
        return Err(crate::model::AppError::from(
            "This character hasn't granted the fittings write scope. Add \
             esi-fittings.write_fittings.v1 to your EVE application, then remove \
             and re-add the character.",
        ));
    }

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
    let granted = storage::load_roster(&dir)
        .iter()
        .find(|c| c.character_id == character_id)
        .map(|c| {
            c.scopes
                .iter()
                .any(|s| s == "esi-fittings.read_fittings.v1")
        })
        .unwrap_or(false);
    if !granted {
        return Err(crate::model::AppError::from(
            "This character hasn't granted the fittings scope. Add \
             esi-fittings.read_fittings.v1 to your EVE application, then remove \
             and re-add the character.",
        ));
    }

    // Cached per character (30 min) so the picker doesn't re-hit ESI each open;
    // `force` (the refresh button) bypasses it.
    let cache_key = format!("fitting_esi_{character_id}");
    if force != Some(true) {
        if let Some(cached) = storage::cache_get::<Vec<Fit>>(&dir, &cache_key) {
            return Ok(cached);
        }
    }

    // Fetch (async) before opening the SDE — its Connection isn't Send.
    let mut esi = crate::esi::fetch_character_fittings(&auth_state, character_id).await?;
    if let Ok(corp_id) = corporation_id(&auth_state, character_id).await {
        if let Ok(mut corp) =
            crate::esi::fetch_corp_fittings(&auth_state, character_id, corp_id).await
        {
            esi.append(&mut corp);
        }
    }

    // Classify charges (SDE category 8 = Charge) and convert each fitting.
    let sde = crate::sde::open_from_app(&app)?;
    let ids: Vec<i64> = esi
        .iter()
        .flat_map(|f| f.items.iter().map(|it| it.type_id))
        .collect();
    let cats = sde.types_categories(&ids).unwrap_or_default();
    let is_charge = |tid: i64| cats.get(&tid).copied() == Some(8);
    let fits: Vec<Fit> = esi
        .iter()
        .map(|f| super::esi_fittings::esi_fitting_to_fit(f, &is_charge))
        .collect();
    let _ = storage::cache_put(&dir, &cache_key, &fits, 30 * 60);
    Ok(fits)
}

/// Simulate a fit: slot/resource validation plus the dogma stats (capacitor,
/// tank, DPS, navigation, targeting). `skill_source` is `"character"` for the
/// logged-in pilot's real skills, anything else (default) for all-V (#172–#177).
/// `price` stays `None` here (priced separately via [`fitting_price`]).
#[tauri::command]
pub async fn fitting_simulate(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
    fit: Fit,
    skill_source: Option<String>,
) -> Result<FitStats, String> {
    // Fetch the character's skills (async) *before* opening the SDE — the SDE
    // connection isn't Send, so it must not be held across an await.
    let levels: Option<SkillLevels> = if skill_source.as_deref() == Some("character") {
        character_skill_levels(&app, &auth_state).await.ok()
    } else {
        None
    };
    let lookup = |sid: i64| skill_level_for(levels.as_ref(), sid);

    let sde = crate::sde::open_from_app(&app)?;
    simulate_fit(&sde, &fit, &lookup)
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
    let prices: HashMap<i64, PriceModel> = market
        .price_models_at(location, &ids)
        .await
        .map_err(|e| e.to_string())?
        .into_iter()
        .map(|m| (m.type_id, m))
        .collect();

    let mut lines = Vec::with_capacity(qty.len());
    let (mut buy_total, mut sell_total) = (0.0, 0.0);
    for (type_id, quantity) in qty {
        let model = prices.get(&type_id);
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
    // Most valuable lines first.
    lines.sort_by(|a, b| {
        b.buy_unit
            .unwrap_or(0.0)
            .partial_cmp(&a.buy_unit.unwrap_or(0.0))
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

/// A single locally saved fit by id, or `None` (#164).
#[tauri::command]
pub fn fitting_load_local(app: AppHandle, id: String) -> Result<Option<Fit>, String> {
    let dir = storage::app_data_dir(&app)?;
    Ok(load_fits(&dir).into_iter().find(|f| f.id == id))
}

/// Delete a locally saved fit by id (no-op if absent) (#164).
#[tauri::command]
pub fn fitting_delete_local(app: AppHandle, id: String) -> Result<(), String> {
    let dir = storage::app_data_dir(&app)?;
    let mut fits = load_fits(&dir);
    fits.retain(|f| f.id != id);
    storage::save_data(&dir, FITS_KEY, &fits)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::modules::fitting::optimizer::*;
    use crate::modules::fitting::stats::run_dogma;

    fn item(type_id: i64, slot: SlotKind, charge: Option<i64>, qty: i32) -> FitItem {
        FitItem {
            type_id,
            slot,
            index: 0,
            state: ModuleState::Active,
            charge_type_id: charge,
            quantity: qty,
        }
    }

    /// Golden gate (#176): the live dogma engine vs PYFA-recorded numbers
    /// (`tools/pyfa-oracle/golden.json`, all-V, PYFA v2.67.0). Needs the
    /// installed Fuzzwork SDE — point `EVE_SDE_PATH` at its `sde.sqlite`. Skips
    /// (passes) when the SDE isn't available, e.g. in CI.
    #[test]
    fn golden_pyfa_fits() {
        let Some(path) = std::env::var_os("EVE_SDE_PATH") else {
            eprintln!("golden_pyfa_fits: EVE_SDE_PATH unset — skipping");
            return;
        };
        let path = std::path::PathBuf::from(&path);
        if !path.exists() {
            eprintln!("golden_pyfa_fits: {path:?} missing — skipping");
            return;
        }
        let sde = Sde::open(&path).expect("open sde");
        let tid = |name: &str| {
            sde.type_by_name(name)
                .unwrap()
                .unwrap_or_else(|| panic!("unknown type: {name}"))
                .0
        };
        let module = |name: &str, slot: SlotKind, charge: Option<&str>, idx: i32| FitItem {
            type_id: tid(name),
            slot,
            index: idx,
            state: ModuleState::Active,
            charge_type_id: charge.map(tid),
            quantity: 1,
        };
        let drone = |name: &str, qty: i32| FitItem {
            type_id: tid(name),
            slot: SlotKind::Drone,
            index: 0,
            state: ModuleState::Active,
            charge_type_id: None,
            quantity: qty,
        };
        let fit = |name: &str, items: Vec<FitItem>| Fit {
            id: "t".into(),
            name: name.into(),
            ship_type_id: tid(name),
            items,
            projected: Vec::new(),
        };
        // A fit with a projected module on it (#178).
        let fit_proj = |name: &str, proj: &str| Fit {
            id: "t".into(),
            name: name.into(),
            ship_type_id: tid(name),
            items: Vec::new(),
            projected: vec![module(proj, SlotKind::Mid, None, 0)],
        };

        struct Golden {
            dps: f64,
            ehp: f64,
            cap_stable: bool,
            /// Stable capacitor level (%) when stable.
            cap_pct: f64,
            /// Seconds to depletion when not stable (0 when stable).
            cap_depletion: f64,
            vel: f64,
            align: f64,
            /// Targeting lock range, metres (0 = not checked).
            lock_range: f64,
        }
        let cases: Vec<(&str, Fit, Golden)> = vec![
            (
                "Rifter",
                fit(
                    "Rifter",
                    vec![
                        module("200mm AutoCannon II", SlotKind::High, Some("Barrage S"), 0),
                        module("200mm AutoCannon II", SlotKind::High, Some("Barrage S"), 1),
                        module("200mm AutoCannon II", SlotKind::High, Some("Barrage S"), 2),
                        drone("Warrior II", 2),
                    ],
                ),
                Golden {
                    dps: 139.32,
                    ehp: 2262.2,
                    cap_stable: true,
                    cap_pct: 100.0,
                    cap_depletion: 0.0,
                    vel: 456.25,
                    align: 3.195,
                    lock_range: 0.0,
                },
            ),
            (
                "Caracal",
                fit(
                    "Caracal",
                    (0..5)
                        .map(|i| {
                            module(
                                "Heavy Missile Launcher II",
                                SlotKind::High,
                                Some("Scourge Heavy Missile"),
                                i,
                            )
                        })
                        .collect(),
                ),
                Golden {
                    dps: 165.32,
                    ehp: 7765.2,
                    cap_stable: true,
                    cap_pct: 100.0,
                    cap_depletion: 0.0,
                    vel: 287.5,
                    align: 5.238,
                    lock_range: 0.0,
                },
            ),
            (
                "Vexor",
                fit("Vexor", vec![drone("Hammerhead II", 5)]),
                Golden {
                    dps: 237.6,
                    ehp: 9331.6,
                    cap_stable: true,
                    cap_pct: 100.0,
                    cap_depletion: 0.0,
                    vel: 243.75,
                    align: 5.817,
                    lock_range: 0.0,
                },
            ),
            (
                // Armor plate: exercises module armor HP (EHP) and the plate's
                // mass penalty on align time.
                "Rifter+plate",
                fit(
                    "Rifter",
                    vec![
                        module("200mm AutoCannon II", SlotKind::High, Some("Barrage S"), 0),
                        module("200mm AutoCannon II", SlotKind::High, Some("Barrage S"), 1),
                        module("200mm AutoCannon II", SlotKind::High, Some("Barrage S"), 2),
                        module("200mm Steel Plates II", SlotKind::Low, None, 0),
                        drone("Warrior II", 2),
                    ],
                ),
                Golden {
                    dps: 139.32,
                    ehp: 3373.3,
                    cap_stable: true,
                    cap_pct: 100.0,
                    cap_depletion: 0.0,
                    vel: 456.25,
                    align: 3.498,
                    lock_range: 0.0,
                },
            ),
            (
                // Two omni armor resist amps: exercises the stacking penalty on
                // resonance attributes (the second module is penalized) → EHP.
                "Rifter+2xEANM",
                fit(
                    "Rifter",
                    vec![
                        module(
                            "Multispectrum Energized Membrane II",
                            SlotKind::Low,
                            None,
                            0,
                        ),
                        module(
                            "Multispectrum Energized Membrane II",
                            SlotKind::Low,
                            None,
                            1,
                        ),
                    ],
                ),
                Golden {
                    dps: 0.0,
                    ehp: 2848.4,
                    cap_stable: true,
                    cap_pct: 100.0,
                    cap_depletion: 0.0,
                    vel: 456.25,
                    align: 3.195,
                    lock_range: 0.0,
                },
            ),
            (
                // Active armor repairer: drains more cap than the Rifter recharges,
                // so it's cap-*unstable* — exercises the depletion-time path.
                "Rifter+rep",
                fit(
                    "Rifter",
                    vec![module("Small Armor Repairer II", SlotKind::Low, None, 0)],
                ),
                Golden {
                    dps: 0.0,
                    ehp: 2262.2,
                    cap_stable: false,
                    cap_pct: 0.0,
                    cap_depletion: 175.5,
                    vel: 456.25,
                    align: 3.195,
                    lock_range: 0.0,
                },
            ),
            (
                // Afterburner: prop-mod velocity boost, the AB's cap drain
                // (stable below 100%), and its mass on align.
                "Rifter+AB",
                fit(
                    "Rifter",
                    vec![
                        module("200mm AutoCannon II", SlotKind::High, Some("Barrage S"), 0),
                        module("200mm AutoCannon II", SlotKind::High, Some("Barrage S"), 1),
                        module("200mm AutoCannon II", SlotKind::High, Some("Barrage S"), 2),
                        module("1MN Afterburner II", SlotKind::Mid, None, 0),
                        drone("Warrior II", 2),
                    ],
                ),
                Golden {
                    dps: 139.32,
                    ehp: 2262.2,
                    cap_stable: true,
                    cap_pct: 95.51,
                    cap_depletion: 0.0,
                    vel: 1193.25,
                    align: 4.692,
                    lock_range: 0.0,
                },
            ),
            (
                // Laser turrets + a T1 frequency crystal: basic crystal damage path.
                "Punisher+MF",
                fit(
                    "Punisher",
                    (0..3)
                        .map(|i| {
                            module(
                                "Small Focused Pulse Laser II",
                                SlotKind::High,
                                Some("Multifrequency S"),
                                i,
                            )
                        })
                        .collect(),
                ),
                Golden {
                    dps: 81.32,
                    ehp: 2600.4,
                    cap_stable: true,
                    cap_pct: 90.29,
                    cap_depletion: 0.0,
                    vel: 443.75,
                    align: 3.229,
                    lock_range: 0.0,
                },
            ),
            (
                // Laser turrets + a T2 crystal (Conflagration): the crystal boosts
                // its host turret's damage — the charge→host (bidirectional) case.
                "Punisher+Conflag",
                fit(
                    "Punisher",
                    (0..3)
                        .map(|i| {
                            module(
                                "Small Focused Pulse Laser II",
                                SlotKind::High,
                                Some("Conflagration S"),
                                i,
                            )
                        })
                        .collect(),
                ),
                Golden {
                    dps: 120.63,
                    ehp: 2600.4,
                    cap_stable: true,
                    cap_pct: 87.76,
                    cap_depletion: 0.0,
                    vel: 443.75,
                    align: 3.229,
                    lock_range: 0.0,
                },
            ),
            (
                // Projected stasis web onto the Rifter: -60% velocity (#178).
                "Rifter<web",
                fit_proj("Rifter", "Stasis Webifier II"),
                Golden {
                    dps: 0.0,
                    ehp: 2262.2,
                    cap_stable: true,
                    cap_pct: 100.0,
                    cap_depletion: 0.0,
                    vel: 182.5,
                    align: 3.195,
                    lock_range: 0.0,
                },
            ),
            (
                // Projected sensor dampener: -15.3% lock range (#178).
                "Rifter<damp",
                fit_proj("Rifter", "Remote Sensor Dampener II"),
                Golden {
                    dps: 0.0,
                    ehp: 2262.2,
                    cap_stable: true,
                    cap_pct: 100.0,
                    cap_depletion: 0.0,
                    vel: 456.25,
                    align: 3.195,
                    lock_range: 23821.9,
                },
            ),
            (
                // Navigation implant: +3% velocity via a shipID effect (#178).
                "Rifter+implant",
                fit(
                    "Rifter",
                    vec![module(
                        "Eifyr and Co. 'Rogue' Navigation NN-603",
                        SlotKind::Implant,
                        None,
                        0,
                    )],
                ),
                Golden {
                    dps: 0.0,
                    ehp: 2262.2,
                    cap_stable: true,
                    cap_pct: 100.0,
                    cap_depletion: 0.0,
                    vel: 469.938,
                    align: 3.195,
                    lock_range: 0.0,
                },
            ),
        ];

        let all5 = |_: i64| 5.0;
        let close = |a: f64, b: f64, pct: f64| (a - b).abs() <= b.abs() * pct + 1e-6;
        // Total DPS, EHP, velocity, align time and cap-stability are all at PYFA
        // parity on these fits and hard-asserted (#176).
        let mut failures = Vec::new();
        for (label, f, g) in &cases {
            let layout = sde.ship_layout(f.ship_type_id).unwrap().expect("layout");
            let d = run_dogma(&sde, f, &layout, &all5).expect("dogma");
            let (dps, ehp, vel, align, stable) = (
                d.dps.total,
                d.tank.ehp,
                d.navigation.max_velocity,
                d.navigation.align_time,
                d.capacitor.stable,
            );
            let cap_pct = d.capacitor.stable_pct.unwrap_or(0.0);
            let depletion = d.capacitor.depletion_seconds.unwrap_or(0.0);
            let mut p = Vec::new();
            if !close(dps, g.dps, 0.005) {
                p.push(format!("dps {dps:.2}≠{:.2}", g.dps));
            }
            if !close(ehp, g.ehp, 0.01) {
                p.push(format!("ehp {ehp:.1}≠{:.1}", g.ehp));
            }
            if stable != g.cap_stable {
                p.push(format!("cap {stable}≠{}", g.cap_stable));
            }
            if stable && !close(cap_pct, g.cap_pct, 0.01) {
                p.push(format!("cap% {cap_pct:.2}≠{:.2}", g.cap_pct));
            }
            if !stable && !close(depletion, g.cap_depletion, 0.02) {
                p.push(format!(
                    "cap-depletion {depletion:.1}≠{:.1}",
                    g.cap_depletion
                ));
            }
            if !close(vel, g.vel, 0.005) {
                p.push(format!("vel {vel:.2}≠{:.2}", g.vel));
            }
            if !close(align, g.align, 0.005) {
                p.push(format!("align {align:.3}≠{:.3}", g.align));
            }
            if g.lock_range > 0.0 {
                let lr = d.targeting.lock_range;
                if !close(lr, g.lock_range, 0.005) {
                    p.push(format!("lock {lr:.1}≠{:.1}", g.lock_range));
                }
            }
            if !p.is_empty() {
                failures.push(format!("{label}: {}", p.join(", ")));
            }
        }
        assert!(
            failures.is_empty(),
            "golden mismatches vs PYFA:\n{}",
            failures.join("\n"),
        );
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
            }],
            projected: Vec::new(),
        };
        let layout = sde.ship_layout(fit.ship_type_id).unwrap().unwrap();
        let d = run_dogma(&sde, &fit, &layout, &|_| 5.0).unwrap();
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
            }],
            projected: Vec::new(),
        };
        let layout = sde.ship_layout(scorch.ship_type_id).unwrap().unwrap();
        let d = run_dogma(&sde, &scorch, &layout, &|_| 5.0).unwrap();
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
            }],
            projected: Vec::new(),
        };
        let layout = sde.ship_layout(tid("Rifter")).unwrap().unwrap();
        let active = run_dogma(&sde, &gun(ModuleState::Active), &layout, &|_| 5.0).unwrap();
        let online = run_dogma(&sde, &gun(ModuleState::Online), &layout, &|_| 5.0).unwrap();
        let offline = run_dogma(&sde, &gun(ModuleState::Offline), &layout, &|_| 5.0).unwrap();
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
            }],
            projected: Vec::new(),
        };
        let layout = sde.ship_layout(tid("Rifter")).unwrap().unwrap();
        let active = run_dogma(&sde, &ab(ModuleState::Active), &layout, &|_| 5.0).unwrap();
        let online = run_dogma(&sde, &ab(ModuleState::Online), &layout, &|_| 5.0).unwrap();
        let offline = run_dogma(&sde, &ab(ModuleState::Offline), &layout, &|_| 5.0).unwrap();
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
            }],
            projected: Vec::new(),
        };
        let layout = sde.ship_layout(tid("Caracal")).unwrap().unwrap();
        let active = run_dogma(&sde, &hardener(ModuleState::Active), &layout, &|_| 5.0).unwrap();
        let online = run_dogma(&sde, &hardener(ModuleState::Online), &layout, &|_| 5.0).unwrap();
        assert!(
            active.tank.ehp > online.tank.ehp,
            "active hardener should raise EHP vs deactivated: {} vs {}",
            active.tank.ehp,
            online.tank.ehp
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

    /// `fit_cost` sums hull + modules×qty + charges; a missing price counts as 0.
    #[test]
    fn fit_cost_sums_hull_modules_charges() {
        let fit = Fit {
            id: "x".into(),
            name: "n".into(),
            ship_type_id: 100,
            items: vec![
                item(10, SlotKind::Low, None, 1),
                item(20, SlotKind::High, Some(30), 1),
                item(40, SlotKind::Drone, None, 5),
            ],
            projected: Vec::new(),
        };
        let prices = HashMap::from([
            (100, 1000.0),
            (10, 50.0),
            (20, 200.0),
            (30, 5.0),
            (40, 10.0),
        ]);
        // 1000 hull + 50 + 200 + 5 charge + 10×5 drones = 1305.
        assert_eq!(fit_cost(&fit, &prices), 1305.0);
        // No prices ⇒ everything counts as free, never blocking.
        assert_eq!(fit_cost(&fit, &HashMap::new()), 0.0);
    }

    /// The penalty is multiplicative per violated constraint, and `meets` mirrors it.
    #[test]
    fn constraint_score_and_meets() {
        let e = Eval {
            objective: 100.0,
            cap_stable: false,
            cost: 500.0,
        };

        // No constraints: full score, satisfied.
        let none = Constraints::default();
        assert_eq!(constraint_score(&e, &none), 100.0);
        assert!(meets(&e, &none));

        // Cap-stable required but the fit is unstable ⇒ penalized + not met.
        let cap = Constraints {
            cap_stable: true,
            max_cost: None,
        };
        assert_eq!(constraint_score(&e, &cap), 100.0 * CONSTRAINT_PENALTY);
        assert!(!meets(&e, &cap));
        // A stable fit clears it.
        let stable = Eval {
            objective: 100.0,
            cap_stable: true,
            cost: 500.0,
        };
        assert_eq!(constraint_score(&stable, &cap), 100.0);
        assert!(meets(&stable, &cap));

        // Budget: over ⇒ penalized; within ⇒ full.
        let tight = Constraints {
            cap_stable: false,
            max_cost: Some(400.0),
        };
        assert!(!meets(&e, &tight));
        assert_eq!(constraint_score(&e, &tight), 100.0 * CONSTRAINT_PENALTY);
        let loose = Constraints {
            cap_stable: false,
            max_cost: Some(500.0),
        };
        assert!(meets(&e, &loose));
        assert_eq!(constraint_score(&e, &loose), 100.0);

        // Both violated ⇒ penalty applied twice (scale-invariant, so ordering holds).
        let both = Constraints {
            cap_stable: true,
            max_cost: Some(400.0),
        };
        assert!(
            (constraint_score(&e, &both) - 100.0 * CONSTRAINT_PENALTY * CONSTRAINT_PENALTY).abs()
                < 1e-9
        );
        assert!(!meets(&e, &both));
    }
}
