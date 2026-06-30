//! Tauri command surface for the fitting module.
//!
//! Commands open the SDE read-only per call (cheap) and orchestrate the shared
//! services, like the production module. P1 adds pricing/validation/storage
//! commands here; the dogma `simulate` command lands with the engine (P2).

use std::collections::HashMap;
use std::path::Path;

use serde::Serialize;
use tauri::{AppHandle, Manager, State};

use super::eft::{self, ParsedEft, ParsedExtra, ParsedModule};
use super::engine::validate::{validate, ValItem};
use super::engine::capacitor::capacitor;
use super::engine::damage::{damage, Weapon};
use super::engine::navigation::{navigation, prop_velocity, targeting};
use super::engine::projection::{
    apply_projection, apply_subsystem_slots, projected_from_attrs, ProjectedInput,
};
use super::engine::attr::AttrStore;
use super::engine::resolve::{resolve, EntityInput, FitInput, ResolvedFit};
use super::engine::tank::{tank, DamageProfile, Layer};
use super::types::{
    CapStats, DpsBreakdown, EwTag, Fit, FitItem, FitPrice, FitPriceLine, FitProblem, FitStats,
    ModuleState, NavStats, ResourceUsage, Severity, SlotKind, TankStats, TargetStats, WeaponRange,
};
use crate::esi::{authed_get, corporation_id, AuthState};
use crate::market::{resolve_location, MarketService, PriceModel};
use crate::sde::{Sde, SdePaths, ShipLayout};
use crate::storage;

/// Storage key for the local saved-fits document (a `Vec<Fit>`).
const FITS_KEY: &str = "fitting_fits";

/// Open the SDE for the current app data dir (read-only, cheap per call).
fn open_sde(app: &AppHandle) -> Result<Sde, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Sde::open(&SdePaths::new(dir).db).map_err(|e| e.to_string())
}

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
    open_sde(&app)?
        .ship_layout(type_id)
        .map_err(|e| e.to_string())
}

/// Parse an EFT clipboard string into a [`Fit`], resolving names → type ids and
/// classifying each module into its slot from dogma effects (#162). Unknown
/// module/charge names are skipped rather than failing the whole import; an
/// unknown ship is an error.
#[tauri::command]
pub fn fitting_import_eft(app: AppHandle, text: String) -> Result<Fit, String> {
    let sde = open_sde(&app)?;
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
    let sde = open_sde(&app)?;
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
    let sde = open_sde(&app)?;
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
    let levels: Option<HashMap<i64, i64>> = if skill_source.as_deref() == Some("character") {
        character_skill_levels(&app, &auth_state).await.ok()
    } else {
        None
    };
    let skill_level_for = |sid: i64| -> f64 {
        match &levels {
            Some(map) => map.get(&sid).copied().unwrap_or(0) as f64,
            None => 5.0, // all-V
        }
    };

    let sde = open_sde(&app)?;
    let costs = resolve_module_costs(&sde, ship_type_id, &skill_level_for, &type_ids)?;
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
    let skill_ids = sde.skill_type_ids().map_err(|e| e.to_string())?;
    let mut all_ids = Vec::with_capacity(1 + type_ids.len() + skill_ids.len());
    all_ids.push(ship_type_id);
    all_ids.extend_from_slice(type_ids);
    all_ids.extend(&skill_ids);

    let attrs = sde.types_attributes_raw(&all_ids).map_err(|e| e.to_string())?;
    let effects_by_type = sde.types_effects(&all_ids).map_err(|e| e.to_string())?;
    let effect_meta = sde.effect_meta().map_err(|e| e.to_string())?;
    let defaults = sde.attribute_defaults().map_err(|e| e.to_string())?;
    let is_stackable = |attr: i64| defaults.get(&attr).map(|m| m.stackable).unwrap_or(true);
    let default_of = |attr: i64| defaults.get(&attr).map(|m| m.default_value).unwrap_or(0.0);

    let entity = |type_id: i64, required_skills: Vec<i64>| -> Result<EntityInput, String> {
        let group_id = sde
            .type_info(type_id)
            .map_err(|e| e.to_string())?
            .map(|t| t.group_id)
            .unwrap_or(0);
        Ok(EntityInput {
            type_id,
            attrs: attrs.get(&type_id).cloned().unwrap_or_default(),
            effect_ids: effects_by_type.get(&type_id).cloned().unwrap_or_default(),
            group_id,
            required_skills,
        })
    };

    let ship = entity(ship_type_id, Vec::new())?;
    let mut modules = Vec::with_capacity(type_ids.len());
    for id in type_ids {
        modules.push(entity(*id, required_skills_of(&attrs, *id))?);
    }
    let mut skills = Vec::with_capacity(skill_ids.len());
    for sid in &skill_ids {
        let level = skill_level_for(*sid);
        if level <= 0.0 {
            continue;
        }
        let mut a = attrs.get(sid).cloned().unwrap_or_default();
        match a.iter_mut().find(|(k, _)| *k == 280) {
            Some(p) => p.1 = level,
            None => a.push((280, level)),
        }
        skills.push(EntityInput {
            type_id: *sid,
            attrs: a,
            effect_ids: effects_by_type.get(sid).cloned().unwrap_or_default(),
            group_id: 0,
            required_skills: Vec::new(),
        });
    }

    let charges = vec![None; modules.len()];
    let resolved = resolve(
        &FitInput { ship, modules, skills, drones: Vec::new(), charges },
        &effect_meta,
        &is_stackable,
        &default_of,
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
    let sde = open_sde(&app)?;
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
    let sde = open_sde(&app)?;
    let name_of = |id: i64| -> Result<String, String> {
        Ok(sde
            .type_info(id)
            .map_err(|e| e.to_string())?
            .map(|t| t.name)
            .unwrap_or_else(|| format!("Type {id}")))
    };

    let ship_name = name_of(fit.ship_type_id)?;

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
            let charge = match i.charge_type_id {
                Some(c) => Some(name_of(c)?),
                None => None,
            };
            modules.push(ParsedModule {
                name: name_of(i.type_id)?,
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
            name: name_of(i.type_id)?,
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
) -> Result<i64, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let character_id =
        storage::active_character(&dir).ok_or_else(|| "Log in a character first".to_string())?;
    let granted = storage::load_roster(&dir)
        .iter()
        .find(|c| c.character_id == character_id)
        .map(|c| c.scopes.iter().any(|s| s == "esi-fittings.write_fittings.v1"))
        .unwrap_or(false);
    if !granted {
        return Err(
            "This character hasn't granted the fittings write scope. Add \
             esi-fittings.write_fittings.v1 to your EVE application, then remove \
             and re-add the character."
                .to_string(),
        );
    }

    let items = super::esi_fittings::fit_to_esi_items(&fit);
    if items.is_empty() {
        return Err("Nothing to save — the fit has no modules.".to_string());
    }
    let name = if fit.name.trim().is_empty() { "Fit" } else { fit.name.trim() };
    let id = crate::esi::create_character_fitting(
        &auth_state,
        character_id,
        name,
        "Saved from EVE Online Tooling",
        fit.ship_type_id,
        &items,
    )
    .await
    .map_err(|e| e.to_string())?;

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
) -> Result<Vec<Fit>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let character_id =
        storage::active_character(&dir).ok_or_else(|| "Log in a character first".to_string())?;

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
        return Err(
            "This character hasn't granted the fittings scope. Add \
             esi-fittings.read_fittings.v1 to your EVE application, then remove \
             and re-add the character."
                .to_string(),
        );
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
    let mut esi = crate::esi::fetch_character_fittings(&auth_state, character_id)
        .await
        .map_err(|e| e.to_string())?;
    if let Ok(corp_id) = corporation_id(&auth_state, character_id).await {
        if let Ok(mut corp) =
            crate::esi::fetch_corp_fittings(&auth_state, character_id, corp_id).await
        {
            esi.append(&mut corp);
        }
    }

    // Classify charges (SDE category 8 = Charge) and convert each fitting.
    let sde = open_sde(&app)?;
    let mut charge: HashMap<i64, bool> = HashMap::new();
    for f in &esi {
        for it in &f.items {
            charge.entry(it.type_id).or_insert_with(|| {
                sde.type_category(it.type_id).ok().flatten() == Some(8)
            });
        }
    }
    let is_charge = |tid: i64| charge.get(&tid).copied().unwrap_or(false);
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
    let levels: Option<HashMap<i64, i64>> = if skill_source.as_deref() == Some("character") {
        character_skill_levels(&app, &auth_state).await.ok()
    } else {
        None
    };
    let skill_level_for = |sid: i64| -> f64 {
        match &levels {
            Some(map) => map.get(&sid).copied().unwrap_or(0) as f64,
            None => 5.0, // all-V
        }
    };

    let sde = open_sde(&app)?;
    let Some(ship) = sde.ship_layout(fit.ship_type_id).map_err(|e| e.to_string())? else {
        return Err(format!("unknown ship: {}", fit.ship_type_id));
    };

    // Batch every fitted item's base attributes in one query.
    let ids: Vec<i64> = fit.items.iter().map(|i| i.type_id).collect();
    let attrs = sde.types_attributes_raw(&ids).map_err(|e| e.to_string())?;

    let mut val_items = Vec::with_capacity(fit.items.len());
    for item in &fit.items {
        let a: HashMap<i64, f64> = attrs
            .get(&item.type_id)
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .collect();
        let get = |id: i64| a.get(&id).copied().unwrap_or(0.0);
        // Turret/launcher only matter for high-slot modules (effects 42/40).
        let (is_turret, is_launcher) = if item.slot == SlotKind::High {
            let effects = sde.type_effects(item.type_id).map_err(|e| e.to_string())?;
            (
                effects.iter().any(|(e, _)| *e == 42),
                effects.iter().any(|(e, _)| *e == 40),
            )
        } else {
            (false, false)
        };
        let drone_volume = if item.slot == SlotKind::Drone {
            sde.type_info(item.type_id)
                .map_err(|e| e.to_string())?
                .and_then(|t| t.volume)
                .unwrap_or(0.0)
        } else {
            0.0
        };
        val_items.push(ValItem {
            slot: item.slot,
            cpu: get(50),          // cpu usage
            powergrid: get(30),    // power usage
            calibration: get(1153), // rig calibration cost
            is_turret,
            is_launcher,
            drone_volume,
            quantity: item.quantity.max(1),
        });
    }

    // Base-attribute resources/validation — only a fallback for when the dogma
    // engine can't run; otherwise the finalized (skill-adjusted) ones are used.
    let (base_resources, base_validation) = validate(&ship, &val_items);

    // Dogma engine: resolve finalized attributes and derive stats (incl. the
    // skill-adjusted resources/validation). Best-effort.
    let dogma = run_dogma(&sde, &fit, &ship, &skill_level_for).ok();

    // Classify any EW projected onto the fit (#265) — presence only.
    let projected_ew = classify_projected_ew(&sde, &fit);

    Ok(FitStats {
        resources: dogma.as_ref().map(|d| d.resources.clone()).unwrap_or(base_resources),
        validation: dogma
            .as_ref()
            .map(|d| d.validation.clone())
            .unwrap_or(base_validation),
        capacitor: dogma.as_ref().map(|d| d.capacitor.clone()),
        tank: dogma.as_ref().map(|d| d.tank.clone()),
        dps: dogma.as_ref().map(|d| d.dps.clone()),
        navigation: dogma.as_ref().map(|d| d.navigation.clone()),
        layout: dogma.as_ref().map(|d| d.layout.clone()),
        weapon_ranges: dogma.as_ref().map(|d| d.weapon_ranges.clone()).unwrap_or_default(),
        activatable_types: dogma.as_ref().map(|d| d.activatable_types.clone()).unwrap_or_default(),
        targeting: dogma.map(|d| d.targeting),
        price: None,
        projected_ew,
    })
}

/// Classify the modules projected **onto** a fit into EW categories by their
/// inventory group (#265). Presence only — counts, not magnitudes. Web/paint/damp
/// are flagged `modeled` (their numbers are already in the stats); ECM is flagged
/// `jam` so the UI shows it as an opt-in jammed scenario, never a passive effect.
fn classify_projected_ew(sde: &Sde, fit: &Fit) -> Vec<EwTag> {
    if fit.projected.is_empty() {
        return Vec::new();
    }
    let ids: Vec<i64> = fit.projected.iter().map(|i| i.type_id).collect();
    let Ok(groups) = sde.types_groups(&ids) else {
        return Vec::new();
    };
    // Tally projected modules per category, preserving a stable display order.
    let order = ["web", "paint", "damp", "weaponDisruption", "ecm", "neut", "nos"];
    let mut counts: HashMap<&'static str, i64> = HashMap::new();
    for item in &fit.projected {
        if let Some(cat) = groups.get(&item.type_id).and_then(|g| ew_category(*g)) {
            *counts.entry(cat).or_default() += item.quantity.max(1) as i64;
        }
    }
    order
        .iter()
        .filter_map(|&cat| {
            let count = *counts.get(cat)?;
            if count == 0 {
                return None;
            }
            Some(EwTag {
                category: cat.to_string(),
                label: ew_label(cat).to_string(),
                count,
                modeled: matches!(cat, "web" | "paint" | "damp"),
                jam: cat == "ecm",
            })
        })
        .collect()
}

/// Map an inventory group id to an EW category key, or `None` if it isn't EW we
/// surface. Group ids are stable SDE identifiers (verified against the SDE).
fn ew_category(group_id: i64) -> Option<&'static str> {
    match group_id {
        65 | 1672 => Some("web"),         // Stasis Web / Stasis Grappler
        379 => Some("paint"),             // Target Painter
        208 => Some("damp"),              // Sensor Dampener
        291 => Some("weaponDisruption"),  // Weapon Disruptor (tracking/guidance)
        201 | 80 => Some("ecm"),          // ECM / Burst Jammer
        71 => Some("neut"),               // Energy Neutralizer
        68 => Some("nos"),                // Energy Nosferatu
        _ => None,
    }
}

/// Human label for an EW category badge.
fn ew_label(cat: &str) -> &'static str {
    match cat {
        "web" => "Web",
        "paint" => "Target Painter",
        "damp" => "Sensor Damp",
        "weaponDisruption" => "Tracking/Guidance Disruption",
        "ecm" => "ECM",
        "neut" => "Energy Neut",
        "nos" => "Nosferatu",
        _ => "EW",
    }
}

/// Dogma-engine stats derived from one resolution pass.
struct DogmaStats {
    /// CPU/PG/calibration usage + output, from *finalized* attributes.
    resources: ResourceUsage,
    /// Slot/resource validation against the *finalized* attributes.
    validation: Vec<FitProblem>,
    /// Resolved slot layout (T3 subsystems grant slots), for the editor.
    layout: ShipLayout,
    /// Type ids of fitted modules that can be activated (have a duration effect).
    activatable_types: Vec<i64>,
    capacitor: CapStats,
    tank: TankStats,
    dps: DpsBreakdown,
    weapon_ranges: Vec<WeaponRange>,
    navigation: NavStats,
    targeting: TargetStats,
}

/// Build the engine inputs (ship + modules + all-V skills) from the SDE, resolve
/// the fit once, and derive the dogma stats from the finalized attributes
/// (capacitor #172, tank #173).
fn run_dogma(
    sde: &Sde,
    fit: &Fit,
    base_layout: &ShipLayout,
    skill_level_for: &dyn Fn(i64) -> f64,
) -> Result<DogmaStats, String> {
    // Only slots that affect ship stats (drones/cargo/implants don't here).
    let module_items: Vec<&FitItem> = fit
        .items
        .iter()
        .filter(|i| {
            matches!(
                i.slot,
                SlotKind::High | SlotKind::Mid | SlotKind::Low | SlotKind::Rig | SlotKind::Subsystem
            )
        })
        .collect();

    // Drones (DPS) and charges (weapon damage) need their base attributes too.
    let drone_items: Vec<&FitItem> =
        fit.items.iter().filter(|i| i.slot == SlotKind::Drone).collect();
    // Implants modify ship attributes via shipID effects, like skills (stacking-
    // exempt), so they resolve as skill-like entities.
    let implant_items: Vec<&FitItem> =
        fit.items.iter().filter(|i| i.slot == SlotKind::Implant).collect();

    let skill_ids = sde.skill_type_ids().map_err(|e| e.to_string())?;
    let mut all_ids = Vec::with_capacity(1 + module_items.len() + skill_ids.len());
    all_ids.push(fit.ship_type_id);
    all_ids.extend(module_items.iter().map(|i| i.type_id));
    all_ids.extend(module_items.iter().filter_map(|i| i.charge_type_id));
    all_ids.extend(drone_items.iter().map(|i| i.type_id));
    all_ids.extend(implant_items.iter().map(|i| i.type_id));
    all_ids.extend(fit.projected.iter().map(|i| i.type_id));
    all_ids.extend(&skill_ids);

    let attrs = sde.types_attributes_raw(&all_ids).map_err(|e| e.to_string())?;
    let effects_by_type = sde.types_effects(&all_ids).map_err(|e| e.to_string())?;
    let effect_meta = sde.effect_meta().map_err(|e| e.to_string())?;
    let defaults = sde.attribute_defaults().map_err(|e| e.to_string())?;
    let is_stackable = |attr: i64| defaults.get(&attr).map(|m| m.stackable).unwrap_or(true);
    let default_of = |attr: i64| defaults.get(&attr).map(|m| m.default_value).unwrap_or(0.0);

    let entity = |type_id: i64, required_skills: Vec<i64>| -> Result<EntityInput, String> {
        let group_id = sde
            .type_info(type_id)
            .map_err(|e| e.to_string())?
            .map(|t| t.group_id)
            .unwrap_or(0);
        Ok(EntityInput {
            type_id,
            attrs: attrs.get(&type_id).cloned().unwrap_or_default(),
            effect_ids: effects_by_type.get(&type_id).cloned().unwrap_or_default(),
            group_id,
            required_skills,
        })
    };

    let mut ship = entity(fit.ship_type_id, Vec::new())?;
    // Seed the hull's base mass (4) if it's only on the type row, not a dogma
    // attribute — otherwise a mass-adding module (armor plate, AB) modAdds onto
    // a zero base and the align-time calc loses the hull mass.
    if !ship.attrs.iter().any(|(k, _)| *k == 4) {
        if let Some(mass) = sde
            .type_detail(fit.ship_type_id)
            .ok()
            .flatten()
            .and_then(|d| d.mass)
        {
            ship.attrs.push((4, mass));
        }
    }

    let mut modules = Vec::with_capacity(module_items.len());
    for it in &module_items {
        // All required skills (182/183/184) drive *RequiredSkillModifier targeting.
        let mut e = entity(it.type_id, required_skills_of(&attrs, it.type_id))?;
        // State gates which effects run. Offline: none (no ship modifiers, no
        // fitting use). Online (not active): only passive effects — drop the
        // activatable ones (those with a duration), so e.g. an *active* hardener
        // stops adding resist while a passive one keeps it. Active: everything.
        // Modules stay in place so `resolved.modules` lines up with the fit; the
        // active-stat passes (DPS/reps/prop) additionally skip non-active modules.
        match it.state {
            ModuleState::Offline => e.effect_ids.clear(),
            ModuleState::Online => e.effect_ids.retain(|eid| {
                effect_meta.get(eid).is_none_or(|m| m.duration_attribute_id.is_none())
            }),
            _ => {}
        }
        modules.push(e);
    }

    // Pass-4 aux entities. Charges are parallel to `modules`; drones to
    // `drone_items`. Their required skills let missile-/drone-damage skills and
    // ship role bonuses reach them (`SkillReqOnShip`).
    let mut charges: Vec<Option<EntityInput>> = Vec::with_capacity(module_items.len());
    for it in &module_items {
        charges.push(match it.charge_type_id {
            Some(cid) => Some(entity(cid, required_skills_of(&attrs, cid))?),
            None => None,
        });
    }
    let mut drones = Vec::with_capacity(drone_items.len());
    for it in &drone_items {
        drones.push(entity(it.type_id, required_skills_of(&attrs, it.type_id))?);
    }

    // Skills at the chosen level (all-V or the character's). skillLevel (280) is
    // forced to that level; untrained (level 0) skills are skipped entirely.
    let mut skills = Vec::with_capacity(skill_ids.len());
    for sid in &skill_ids {
        let level = skill_level_for(*sid);
        if level <= 0.0 {
            continue;
        }
        let mut a = attrs.get(sid).cloned().unwrap_or_default();
        match a.iter_mut().find(|(k, _)| *k == 280) {
            Some(p) => p.1 = level,
            None => a.push((280, level)),
        }
        skills.push(EntityInput {
            type_id: *sid,
            attrs: a,
            effect_ids: effects_by_type.get(sid).cloned().unwrap_or_default(),
            group_id: 0,
            required_skills: Vec::new(),
        });
    }
    // Implants resolve alongside skills — their shipID effects modify the ship,
    // stacking-exempt, which the skills pass already guarantees.
    for it in &implant_items {
        skills.push(entity(it.type_id, Vec::new())?);
    }

    let mut resolved = resolve(
        &FitInput { ship, modules, skills, drones, charges },
        &effect_meta,
        &is_stackable,
        &default_of,
    );

    // Projected effects (#178): webs/paints/… modify this ship's attributes.
    let projected: Vec<ProjectedInput> = fit
        .projected
        .iter()
        .map(|p| {
            let a: HashMap<i64, f64> =
                attrs.get(&p.type_id).cloned().unwrap_or_default().into_iter().collect();
            projected_from_attrs(|id| a.get(&id).copied().unwrap_or(0.0))
        })
        .collect();
    apply_projection(&mut resolved.ship, &projected);

    // T3 subsystems grant slots/hardpoints to the ship procedurally (#178).
    for (it, store) in module_items.iter().zip(&resolved.modules) {
        if it.slot == SlotKind::Subsystem {
            apply_subsystem_slots(&mut resolved.ship, |id| store.get(id));
        }
    }

    // Mass for align time: prefer the finalized dogma value, else invTypes.mass
    // (some hulls carry mass only on the type row, not as a dogma attribute).
    let mass = {
        let m = resolved.ship.get(4);
        if m > 0.0 {
            m
        } else {
            sde.type_detail(fit.ship_type_id)
                .ok()
                .flatten()
                .and_then(|d| d.mass)
                .unwrap_or(0.0)
        }
    };
    let s = &resolved.ship;

    // Finalized fitting resources + validation from the *resolved* ship + modules
    // (skills/rigs/modules reflected, not base attributes) — shared with the
    // optimizer's feasibility gate. Drone-bay volume comes from the SDE.
    let (resources, validation, layout) = resolved_feasibility(
        &resolved,
        base_layout,
        &effects_by_type,
        fit,
        &|tid| {
            sde.type_info(tid)
                .ok()
                .flatten()
                .and_then(|t| t.volume)
                .unwrap_or(0.0)
        },
    );

    // Type ids of fitted modules that can actually be *activated* — i.e. carry an
    // effect with a duration. Passive modules (plates, passive hardeners, DCUs)
    // have none, so the UI shows them no active/inactive state.
    let activatable_types: Vec<i64> = module_items
        .iter()
        .map(|it| it.type_id)
        .filter(|tid| {
            effects_by_type.get(tid).is_some_and(|eids| {
                eids.iter().any(|eid| {
                    effect_meta.get(eid).is_some_and(|m| m.duration_attribute_id.is_some())
                })
            })
        })
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();

    Ok(DogmaStats {
        resources,
        validation,
        layout,
        activatable_types,
        capacitor: capacitor_of(&resolved, &module_items),
        tank: tank_of(&resolved, &module_items),
        dps: dps_of(&resolved, &module_items, &drone_items),
        weapon_ranges: weapon_ranges_of(&resolved, &module_items),
        navigation: {
            // Prop modules (AB/MWD) are identified by speedFactor (20) +
            // speedBoostFactor (567). Their mass penalty (massAddition 796) and
            // velocity boost are both procedural (not in modifierInfo), so add the
            // mass here and feed the bumped mass into align time + the boost. Only
            // an *active* prop boosts speed (its mass penalty also only applies
            // while running) — an online/offline AB does neither.
            let active_props: Vec<_> = resolved
                .modules
                .iter()
                .enumerate()
                .filter(|(i, _)| {
                    module_items.get(*i).is_none_or(|it| it.state == ModuleState::Active)
                })
                .map(|(_, m)| m)
                .collect();
            let props: Vec<(f64, f64)> = active_props
                .iter()
                .map(|m| (m.get(20), m.get(567)))
                .filter(|(sf, sbf)| *sf != 0.0 && *sbf != 0.0)
                .collect();
            let prop_mass: f64 = active_props
                .iter()
                .filter(|m| m.get(20) != 0.0 && m.get(567) != 0.0)
                .map(|m| m.get(796))
                .sum();
            let total_mass = mass + prop_mass;
            navigation(
                prop_velocity(s.get(37), total_mass, &props),
                total_mass,
                s.get(70),
                s.get(552),
            )
        },
        targeting: targeting(
            s.get(192),
            s.get(76),
            s.get(564),
            [s.get(208), s.get(209), s.get(210), s.get(211)],
        ),
    })
}

/// Dogma-finalized fitting feasibility: build the resolved hull layout + per-item
/// [`ValItem`]s from a resolved fit and [`validate`] them, so CPU/PG/calibration and
/// slot/hardpoint checks reflect skills, rigs and fitting modules (RCUs, ACRs, …)
/// rather than base attributes. Shared by the simulator (#172) and the optimizer's
/// feasibility gate (#156). `drone_volume_of` supplies packaged drone volume for the
/// bay check (the optimizer passes `|_| 0.0`, as it never reworks drones in-search).
fn resolved_feasibility(
    resolved: &ResolvedFit,
    base_layout: &ShipLayout,
    effects_by_type: &EffectMap,
    fit: &Fit,
    drone_volume_of: &dyn Fn(i64) -> f64,
) -> (ResourceUsage, Vec<FitProblem>, ShipLayout) {
    let s = &resolved.ship;
    let resolved_layout = ShipLayout {
        type_id: base_layout.type_id,
        name: base_layout.name.clone(),
        high_slots: s.get(14) as i64,
        mid_slots: s.get(13) as i64,
        low_slots: s.get(12) as i64,
        rig_slots: s.get(1137) as i64,
        subsystem_slots: s.get(1367) as i64,
        turret_hardpoints: s.get(102) as i64,
        launcher_hardpoints: s.get(101) as i64,
        cpu_output: s.get(48),
        powergrid_output: s.get(11),
        calibration: s.get(1132),
        drone_bay: s.get(283),
        drone_bandwidth: s.get(1271),
    };
    let mut module_stores = resolved.modules.iter();
    let mut val_items: Vec<ValItem> = Vec::with_capacity(fit.items.len());
    for item in &fit.items {
        if is_ship_module(item.slot) {
            let Some(store) = module_stores.next() else {
                continue;
            };
            let eff = effects_by_type.get(&item.type_id);
            let is_turret = item.slot == SlotKind::High && eff.is_some_and(|e| e.contains(&42));
            let is_launcher = item.slot == SlotKind::High && eff.is_some_and(|e| e.contains(&40));
            // Offline modules consume no CPU/PG/calibration but still hold their
            // slot (and hardpoint), so only the fitting use is zeroed.
            let offline = item.state == ModuleState::Offline;
            val_items.push(ValItem {
                slot: item.slot,
                cpu: if offline { 0.0 } else { store.get(50) },
                powergrid: if offline { 0.0 } else { store.get(30) },
                calibration: if offline { 0.0 } else { store.get(1153) },
                is_turret,
                is_launcher,
                drone_volume: 0.0,
                quantity: item.quantity.max(1),
            });
        } else if item.slot == SlotKind::Drone {
            val_items.push(ValItem {
                slot: SlotKind::Drone,
                cpu: 0.0,
                powergrid: 0.0,
                calibration: 0.0,
                is_turret: false,
                is_launcher: false,
                drone_volume: drone_volume_of(item.type_id),
                quantity: item.quantity.max(1),
            });
        }
    }
    let (resources, validation) = validate(&resolved_layout, &val_items);
    (resources, validation, resolved_layout)
}

/// The active character's actual skill levels (`skillTypeId → level`), via ESI
/// `/characters/{id}/skills/` (#177). Reuses the existing `esi-skills` scope.
async fn character_skill_levels(
    app: &AppHandle,
    auth_state: &AuthState,
) -> Result<HashMap<i64, i64>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let character_id =
        storage::active_character(&dir).ok_or_else(|| "Log in a character first".to_string())?;

    #[derive(serde::Deserialize)]
    struct Skills {
        skills: Vec<Skill>,
    }
    #[derive(serde::Deserialize)]
    struct Skill {
        skill_id: i64,
        #[serde(default)]
        active_skill_level: i64,
    }

    let skills: Skills = authed_get(
        auth_state,
        character_id,
        &format!("/latest/characters/{character_id}/skills/"),
    )
    .await
    .map_err(|e| e.to_string())?;
    Ok(skills
        .skills
        .into_iter()
        .map(|s| (s.skill_id, s.active_skill_level))
        .collect())
}

/// Sum the four base damage types (em 114 / explosive 116 / kinetic 117 /
/// thermal 118) for a type id from the batched attributes.
fn base_damage(attrs: &HashMap<i64, Vec<(i64, f64)>>, type_id: i64) -> f64 {
    let a = match attrs.get(&type_id) {
        Some(a) => a,
        None => return 0.0,
    };
    a.iter()
        .filter(|(k, _)| matches!(k, 114 | 116 | 117 | 118))
        .map(|(_, v)| v)
        .sum()
}

/// Sum the four damage-type attributes (em/explosive/kinetic/thermal) off a
/// *resolved* store — so skill/ship damage bonuses already applied count.
fn resolved_damage(store: &AttrStore) -> f64 {
    store.get(114) + store.get(116) + store.get(117) + store.get(118)
}

/// DPS from a resolved fit (#174, #176). Turrets read finalized `damageMultiplier`
/// (64) + `speed` (51) and the loaded charge's base damage; **missiles** ride on
/// the *resolved* charge, so missile-damage skills and ship role bonuses (applied
/// to the charge in pass 4) count; **drones** read their resolved store, so drone
/// skills + drone-damage bonuses count. `drone_items` is parallel to
/// `resolved.drones`; `resolved.charges` is parallel to `resolved.modules`.
fn dps_of(
    resolved: &ResolvedFit,
    module_items: &[&FitItem],
    drone_items: &[&FitItem],
) -> DpsBreakdown {
    let mut turrets = Vec::new();
    let mut missiles = Vec::new();
    for (i, store) in resolved.modules.iter().enumerate() {
        if module_items.get(i).is_some_and(|it| it.state != ModuleState::Active) {
            continue; // only active weapons fire (offline/online = no DPS)
        }
        let Some(Some(charge)) = resolved.charges.get(i) else {
            continue;
        };
        let damage_per_shot = resolved_damage(charge);
        let rof_seconds = store.get(51) / 1000.0;
        let mult = store.get(64);
        if mult > 0.0 {
            turrets.push(Weapon { damage_mult: mult, damage_per_shot, rof_seconds, count: 1 });
        } else if rof_seconds > 0.0 {
            missiles.push(Weapon { damage_mult: 1.0, damage_per_shot, rof_seconds, count: 1 });
        }
    }

    let drones: Vec<Weapon> = drone_items
        .iter()
        .zip(&resolved.drones)
        .map(|(d, store)| Weapon {
            damage_mult: store.get(64),
            damage_per_shot: resolved_damage(store),
            rof_seconds: store.get(51) / 1000.0,
            count: d.quantity.max(1),
        })
        .collect();

    damage(&turrets, &missiles, &drones)
}

/// Per-weapon engagement ranges from the resolved fit: turret optimal(54)/
/// falloff(158), mining-laser reach (also `maxRange`), and missile flight range
/// (velocity × flight time) from the loaded missile. Deduped by (type, charge),
/// since identical loadouts share a range. `module_items` is parallel to
/// `resolved.modules`/`resolved.charges`.
fn weapon_ranges_of(resolved: &ResolvedFit, module_items: &[&FitItem]) -> Vec<WeaponRange> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for (i, store) in resolved.modules.iter().enumerate() {
        let Some(item) = module_items.get(i) else { continue };
        if item.state == ModuleState::Offline {
            continue; // disabled weapon: no range readout
        }
        let mut optimal = store.get(54); // maxRange: turrets + mining lasers
        let falloff = store.get(158);
        // Missile launchers have no maxRange — use the loaded missile's flight range.
        if optimal == 0.0 {
            if let Some(Some(charge)) = resolved.charges.get(i) {
                let flight = charge.get(37) * charge.get(281) / 1000.0;
                if flight > 0.0 {
                    optimal = flight;
                }
            }
        }
        if optimal > 0.0 && seen.insert((item.type_id, item.charge_type_id)) {
            out.push(WeaponRange {
                type_id: item.type_id,
                charge_type_id: item.charge_type_id,
                optimal,
                falloff,
            });
        }
    }
    out
}

/// Damage-objective score for the optimizer. Like DPS, but a turret with **no
/// charge loaded** still contributes `mult / RoF` (a unit shot), so optimizing
/// for damage works even when the fit's weapons aren't ammoed — it ranks by
/// weapon damage *potential*, which is monotonic with real DPS for fixed ammo.
/// (`dps_of` keeps showing 0 for unarmed weapons in the stats panel.)
fn damage_score(
    resolved: &ResolvedFit,
    module_items: &[&FitItem],
    drone_items: &[&FitItem],
    attrs: &AttrMap,
) -> f64 {
    let mut total = 0.0;
    for (item, store) in module_items.iter().zip(&resolved.modules) {
        let rof = store.get(51) / 1000.0;
        if rof <= 0.0 {
            continue;
        }
        let charge_dmg = item
            .charge_type_id
            .map(|c| base_damage(attrs, c))
            .filter(|d| *d > 0.0);
        let mult = store.get(64);
        if mult > 0.0 {
            // Turret: mult × (ammo damage, or a unit shot when unloaded).
            total += mult * charge_dmg.unwrap_or(1.0) / rof;
        } else {
            // Missile/launcher (no multiplier): count a unit shot even when
            // unloaded, so launcher RoF bonuses (BCS) register and launchers get
            // fitted/optimized without missiles loaded.
            total += charge_dmg.unwrap_or(1.0) / rof;
        }
    }
    for d in drone_items {
        let get = |id: i64| {
            attrs
                .get(&d.type_id)
                .and_then(|a| a.iter().find(|(k, _)| *k == id).map(|(_, v)| *v))
                .unwrap_or(0.0)
        };
        let rof = get(51) / 1000.0;
        if rof > 0.0 {
            total += get(64) * base_damage(attrs, d.type_id) / rof * d.quantity.max(1) as f64;
        }
    }
    total
}

/// Capacitor stability from a resolved fit (#172). Steady drain assumes every
/// cap-using module runs (capacitorNeed 6 / duration 73 ms); per-module on/off
/// toggling is a UI follow-up.
fn capacitor_of(resolved: &ResolvedFit, module_items: &[&FitItem]) -> CapStats {
    let mut drain = 0.0;
    let mut module_drains: Vec<(f64, f64)> = Vec::new();
    for (i, store) in resolved.modules.iter().enumerate() {
        if module_items.get(i).is_some_and(|it| it.state != ModuleState::Active) {
            continue; // only active modules draw capacitor
        }
        let need = store.get(6);
        // Cap-using modules cycle on `duration` (73); weapons (lasers, hybrids)
        // cycle on rate of fire (`speed`, 51) instead, so fall back to it.
        let dur = {
            let d = store.get(73);
            if d > 0.0 { d } else { store.get(51) }
        };
        if need > 0.0 && dur > 0.0 {
            drain += need / (dur / 1000.0);
            module_drains.push((need, dur));
        }
    }
    capacitor(
        resolved.ship.get(482),
        resolved.ship.get(55),
        drain,
        &module_drains,
    )
}

/// Tank from a resolved fit (#173): HP + resonances from the ship, local rep/s
/// from shield boosters (shieldBonus 68) and armor repairers (armorDamageAmount
/// 84). Even 25/25/25/25 damage profile.
fn tank_of(resolved: &ResolvedFit, module_items: &[&FitItem]) -> TankStats {
    let s = &resolved.ship;
    // Resonance attribute ids verified vs the SDE: [em, thermal, kinetic, explosive].
    let shield = Layer {
        hp: s.get(263),
        resonance: [s.get(271), s.get(274), s.get(273), s.get(272)],
    };
    let armor = Layer {
        hp: s.get(265),
        resonance: [s.get(267), s.get(270), s.get(269), s.get(268)],
    };
    let hull = Layer {
        hp: s.get(9),
        resonance: [s.get(113), s.get(110), s.get(109), s.get(111)],
    };

    let (mut shield_rep_s, mut armor_rep_s) = (0.0, 0.0);
    for (i, store) in resolved.modules.iter().enumerate() {
        if module_items.get(i).is_some_and(|it| it.state != ModuleState::Active) {
            continue; // only active reps cycle (offline/online = no local reps)
        }
        let dur = store.get(73);
        if dur <= 0.0 {
            continue;
        }
        let sb = store.get(68);
        if sb > 0.0 {
            shield_rep_s += sb / (dur / 1000.0);
        }
        let ar = store.get(84);
        if ar > 0.0 {
            armor_rep_s += ar / (dur / 1000.0);
        }
    }

    // Peak passive shield regen: 2.5 × max shield ÷ recharge time (479, ms) — the
    // same peak-recharge form as the capacitor (a stationary shield-tank's tank).
    let recharge_ms = s.get(479);
    let passive_shield_s = if recharge_ms > 0.0 {
        2.5 * s.get(263) / (recharge_ms / 1000.0)
    } else {
        0.0
    };

    let mut t = tank(
        shield,
        armor,
        hull,
        &DamageProfile::default(),
        shield_rep_s,
        armor_rep_s,
    );
    t.passive_shield_s = passive_shield_s;
    t
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
    let sde = open_sde(&app)?;

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
        let name = sde
            .type_info(type_id)
            .map_err(|e| e.to_string())?
            .map(|t| t.name)
            .unwrap_or_else(|| format!("Type {type_id}"));
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

// --- Optimizer (#156) ---

/// What to maximize when filling empty slots.
#[derive(Clone, Copy, PartialEq)]
enum Objective {
    Tank,
    Damage,
    Repair,
    Yield,
}

fn parse_objective(s: &str) -> Result<Objective, String> {
    match s {
        "tank" => Ok(Objective::Tank),
        "damage" => Ok(Objective::Damage),
        "repair" => Ok(Objective::Repair),
        "yield" => Ok(Objective::Yield),
        other => Err(format!("unknown objective: {other}")),
    }
}

/// Candidate module groups per slot kind for an objective (group ids verified
/// against the SDE). The optimizer fills empty slots of these kinds.
fn opt_config(obj: Objective) -> Vec<(SlotKind, Vec<i64>)> {
    match obj {
        // Shield/armor buffer + resistance modules, plus HP/resist rigs.
        Objective::Tank => vec![
            (SlotKind::Mid, vec![38, 77, 295]),
            (SlotKind::Low, vec![329, 328, 98, 1150, 60, 78]),
            (SlotKind::Rig, vec![773, 774]),
        ],
        // Weapons in the highs (turrets + missile launchers) so even an empty
        // hull gets armed — the hull's turret/launcher hardpoints (validated) and
        // CPU/PG fitting steer the weapon type and size — plus low-slot damage
        // amplifiers and weapon-damage rigs.
        Objective::Damage => vec![
            (
                SlotKind::High,
                vec![
                    53, 74, 55, 1986, // turrets: energy / hybrid / projectile / precursor
                    507, 509, 511, 510, 771, 1245, 506, 508, // missile launchers
                ],
            ),
            (SlotKind::Low, vec![59, 302, 205, 367, 645, 1988]),
            (SlotKind::Rig, vec![775, 776, 777, 779, 778]),
        ],
        // Shield boosters / armor repairers + HP rigs.
        Objective::Repair => vec![
            (SlotKind::Mid, vec![40]),
            (SlotKind::Low, vec![62]),
            (SlotKind::Rig, vec![773, 774]),
        ],
        // Mining lasers/strip miners + mining upgrades + mining rigs.
        Objective::Yield => vec![
            (SlotKind::High, vec![54, 464, 483]),
            (SlotKind::Low, vec![546]),
            (SlotKind::Rig, vec![904]),
        ],
    }
}

/// Groups limited to one per fit (the optimizer won't add a second).
const UNIQUE_GROUPS: &[i64] = &[60]; // Damage Control

fn slot_capacity(layout: &ShipLayout, slot: SlotKind) -> i64 {
    match slot {
        SlotKind::High => layout.high_slots,
        SlotKind::Mid => layout.mid_slots,
        SlotKind::Low => layout.low_slots,
        SlotKind::Rig => layout.rig_slots,
        SlotKind::Subsystem => layout.subsystem_slots,
        _ => 0,
    }
}

fn is_ship_module(slot: SlotKind) -> bool {
    matches!(
        slot,
        SlotKind::High | SlotKind::Mid | SlotKind::Low | SlotKind::Rig | SlotKind::Subsystem
    )
}

/// A freshly-added optimizer module (active, no charge).
fn new_module(type_id: i64, slot: SlotKind, index: i32) -> FitItem {
    FitItem {
        type_id,
        slot,
        index,
        state: ModuleState::Active,
        charge_type_id: None,
        quantity: 1,
    }
}

/// Append `count` copies of weapon type `tid` to the fit's high slots (active, no
/// charge), indexed after any existing high-slot modules — a uniform rack.
fn add_weapons(fit: &mut Fit, tid: i64, count: i64) {
    let start = fit.items.iter().filter(|i| i.slot == SlotKind::High).count() as i32;
    for k in 0..count {
        fit.items.push(new_module(tid, SlotKind::High, start + k as i32));
    }
}

type AttrMap = HashMap<i64, Vec<(i64, f64)>>;
type EffectMap = HashMap<i64, Vec<i64>>;
type GroupMap = HashMap<i64, i64>;

/// The weapon group ids and weapon skill ids a hull is *bonused* for, read from
/// its own effects' `modifierInfo` (domain `shipID`) that touch a weapon-level
/// attribute — rate of fire (51) or turret damage multiplier (64). A ship that
/// bonuses energy turrets keys off skill 3306 (Medium Energy Turret); one that
/// bonuses rockets keys off groups 771/510/511; etc. Used to steer the damage
/// optimizer toward the weapons the hull is actually built for, instead of
/// whatever has the highest raw paper-DPS (e.g. blasters on a laser boat).
/// Empty sets ⇒ no weapon bonus found ⇒ don't restrict.
fn ship_weapon_bonus(
    ship_type_id: i64,
    effects: &EffectMap,
    effect_meta: &HashMap<i64, crate::sde::EffectMeta>,
) -> (Vec<i64>, Vec<i64>) {
    const WEAPON_ATTRS: [i64; 2] = [51, 64]; // rate of fire, damageMultiplier
    let mut groups = Vec::new();
    let mut skills = Vec::new();
    for eid in effects.get(&ship_type_id).into_iter().flatten() {
        let Some(meta) = effect_meta.get(eid) else { continue };
        for m in &meta.modifiers {
            // Only the ship bonusing its own fitted weapons (skip drone/owner bonuses).
            if m.domain.as_deref() != Some("shipID") {
                continue;
            }
            if !m.modified_attribute_id.is_some_and(|a| WEAPON_ATTRS.contains(&a)) {
                continue;
            }
            if let Some(g) = m.group_id {
                groups.push(g);
            }
            if let Some(s) = m.skill_type_id {
                skills.push(s);
            }
        }
    }
    (groups, skills)
}

/// A type's required-skill ids (requiredSkill1/2/3 = attrs 182/183/184), for
/// `*RequiredSkillModifier` targeting.
fn required_skills_of(attrs: &AttrMap, type_id: i64) -> Vec<i64> {
    attrs
        .get(&type_id)
        .map(|a| {
            a.iter()
                .filter(|(k, _)| matches!(k, 182 | 183 | 184))
                .map(|(_, v)| *v as i64)
                .filter(|s| *s > 0)
                .collect()
        })
        .unwrap_or_default()
}

fn entity_from_maps(
    type_id: i64,
    attrs: &AttrMap,
    effects: &EffectMap,
    groups: &GroupMap,
) -> EntityInput {
    EntityInput {
        type_id,
        attrs: attrs.get(&type_id).cloned().unwrap_or_default(),
        effect_ids: effects.get(&type_id).cloned().unwrap_or_default(),
        group_id: groups.get(&type_id).copied().unwrap_or(0),
        required_skills: required_skills_of(attrs, type_id),
    }
}

/// Sum mining yield (m³/s) over a resolved fit's modules (miningAmount 77 /
/// duration 73). Reflects all-V mining skills.
fn mining_yield(resolved: &ResolvedFit) -> f64 {
    resolved
        .modules
        .iter()
        .map(|s| {
            let amount = s.get(77);
            let dur = s.get(73);
            if amount > 0.0 && dur > 0.0 {
                amount / (dur / 1000.0)
            } else {
                0.0
            }
        })
        .sum()
}

/// Hard constraints the optimizer keeps the result within (#156).
#[derive(Clone, Copy, Default)]
struct Constraints {
    /// Require the fit to be capacitor-stable.
    cap_stable: bool,
    /// Cap total fit ISK cost (hull + modules + charges + drones).
    max_cost: Option<f64>,
}

/// One trial fit's objective metric plus the inputs the constraints test.
struct Eval {
    objective: f64,
    cap_stable: bool,
    cost: f64,
}

/// Penalty factor applied to a trial's objective for each violated soft constraint.
/// Multiplicative, so it's scale-invariant across objectives (EHP, DPS, yield differ
/// by orders of magnitude): a violation makes the trial worse without forbidding it,
/// so the search can pass through a temporarily cap-unstable state (e.g. add a prop
/// mod, then a cap battery) instead of being trapped by a hard reject.
const CONSTRAINT_PENALTY: f64 = 0.4;

/// Whether an evaluated trial satisfies every active constraint.
fn meets(e: &Eval, c: &Constraints) -> bool {
    (!c.cap_stable || e.cap_stable) && c.max_cost.is_none_or(|m| e.cost <= m + 1.0)
}

/// The comparable score the search maximizes: objective, penalized per violation.
fn constraint_score(e: &Eval, c: &Constraints) -> f64 {
    let mut s = e.objective;
    if c.cap_stable && !e.cap_stable {
        s *= CONSTRAINT_PENALTY;
    }
    if c.max_cost.is_some_and(|m| e.cost > m) {
        s *= CONSTRAINT_PENALTY;
    }
    s
}

/// Total ISK to buy a whole fit (hull + modules + charges + drones) at the prefetched
/// unit prices; a missing price counts as 0 (treated as free rather than blocking).
fn fit_cost(fit: &Fit, prices: &HashMap<i64, f64>) -> f64 {
    let mut total = prices.get(&fit.ship_type_id).copied().unwrap_or(0.0);
    for item in &fit.items {
        total += prices.get(&item.type_id).copied().unwrap_or(0.0) * item.quantity.max(1) as f64;
        if let Some(charge) = item.charge_type_id {
            total += prices.get(&charge).copied().unwrap_or(0.0);
        }
    }
    total
}

/// The optimizer's per-trial evaluation: the objective metric plus the constraint
/// inputs (cap stability, total ISK cost). `None` if the fit is structurally
/// infeasible — over CPU/PG/calibration/slots/hardpoints on the *finalized*
/// attributes, so fitting skills/rigs/RCUs are reflected. Uses preloaded maps +
/// cached skills; `prices` maps type_id → unit buy price (sell-min), empty when no
/// budget constraint is set.
#[allow(clippy::too_many_arguments)]
fn evaluate(
    obj: Objective,
    fit: &Fit,
    layout: &ShipLayout,
    attrs: &AttrMap,
    effects: &EffectMap,
    groups: &GroupMap,
    skills: &[EntityInput],
    effect_meta: &HashMap<i64, crate::sde::EffectMeta>,
    is_stackable: &impl Fn(i64) -> bool,
    default_of: &impl Fn(i64) -> f64,
    prices: &HashMap<i64, f64>,
) -> Option<Eval> {
    let module_items: Vec<&FitItem> = fit.items.iter().filter(|i| is_ship_module(i.slot)).collect();
    let drone_items: Vec<&FitItem> =
        fit.items.iter().filter(|i| i.slot == SlotKind::Drone).collect();

    let ship = entity_from_maps(fit.ship_type_id, attrs, effects, groups);
    let modules: Vec<EntityInput> = module_items
        .iter()
        .map(|it| entity_from_maps(it.type_id, attrs, effects, groups))
        .collect();

    let resolved = resolve(
        &FitInput {
            ship,
            modules,
            skills: skills.to_vec(),
            ..Default::default()
        },
        effect_meta,
        is_stackable,
        default_of,
    );

    // Dogma-aware feasibility gate: reject fits that don't fit. The optimizer never
    // reworks drones in-search, so bay volume is 0 here.
    let (_, problems, _) = resolved_feasibility(&resolved, layout, effects, fit, &|_| 0.0);
    if problems.iter().any(|p| p.severity == Severity::Error) {
        return None;
    }

    let objective = match obj {
        Objective::Tank => tank_of(&resolved, &module_items).ehp,
        Objective::Repair => {
            let t = tank_of(&resolved, &module_items);
            t.shield_rep_s + t.armor_rep_s
        }
        Objective::Damage => damage_score(&resolved, &module_items, &drone_items, attrs),
        Objective::Yield => mining_yield(&resolved),
    };
    Some(Eval {
        objective,
        cap_stable: capacitor_of(&resolved, &module_items).stable,
        cost: fit_cost(fit, prices),
    })
}

/// Result of an optimize pass: the reworked fit plus whether it met the requested
/// hard constraints, so the UI can warn when a target couldn't be reached (#156).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OptimizeResult {
    pub fit: Fit,
    /// Whether the result is capacitor-stable (always reported).
    pub cap_stable: bool,
    /// Whether the result is within the ISK budget (`true` when none was set).
    pub within_budget: bool,
}

/// Optimize a fit for an objective (`"tank"` | `"damage"` | `"repair"` |
/// `"yield"`) by **reworking all of its objective-relevant slots** (clearing
/// and rebuilding mid/low/rig — or high for mining — while leaving everything
/// else). Candidates are drawn from the allowed meta groups (`meta_groups`;
/// default Tech I + Tech II). A greedy seed + iterated local search finds a
/// strong, near-global combination, scored at all-V via the dogma engine; only
/// valid (fitting) configurations are kept. Optional hard constraints keep the
/// result capacitor-stable and/or within an ISK budget (#156).
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn fitting_optimize(
    app: AppHandle,
    market: State<'_, MarketService>,
    fit: Fit,
    objective: String,
    meta_groups: Vec<i64>,
    mode: Option<String>,
    cap_stable: Option<bool>,
    max_cost: Option<f64>,
    region_id: Option<i64>,
    station_id: Option<i64>,
) -> Result<OptimizeResult, String> {
    let obj = parse_objective(&objective)?;
    let meta = if meta_groups.is_empty() {
        vec![1, 2]
    } else {
        meta_groups.clone()
    };

    // Prefetch unit prices only when a budget is set: gather every type the optimizer
    // might place (hull + current items + candidate modules + combat drones + ammo),
    // then price them in one bulk call. The SDE isn't `Send`, so it is opened and
    // dropped *before* the await.
    let prices: HashMap<i64, f64> = if max_cost.is_some() {
        let ids = {
            let sde = open_sde(&app)?;
            let mut ids: Vec<i64> = vec![fit.ship_type_id];
            ids.extend(fit.items.iter().map(|i| i.type_id));
            ids.extend(fit.items.iter().filter_map(|i| i.charge_type_id));
            for (_, groups) in opt_config(obj) {
                for (t, _) in sde.modules_in_groups(&groups, &meta).map_err(|e| e.to_string())? {
                    ids.push(t);
                }
            }
            if obj == Objective::Damage {
                for (t, _) in sde.modules_in_groups(&[100], &meta).map_err(|e| e.to_string())? {
                    ids.push(t); // combat drones
                }
                for (t, _) in sde
                    .modules_in_groups(&[604, 605, 606, 609, 610], &meta)
                    .map_err(|e| e.to_string())?
                {
                    ids.push(t); // ammo/charges
                }
            }
            ids
        };
        let location = resolve_location(region_id.unwrap_or(10000002), station_id);
        market
            .price_models_at(location, &ids)
            .await
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|m| (m.type_id, m.sell_min.unwrap_or(0.0)))
            .collect()
    } else {
        HashMap::new()
    };

    let constraints = Constraints {
        cap_stable: cap_stable.unwrap_or(false),
        max_cost,
    };
    let sde = open_sde(&app)?;
    optimize_fit(
        &sde,
        fit,
        &objective,
        meta_groups,
        mode.as_deref().unwrap_or("all"),
        &prices,
        constraints,
    )
}

/// Core of [`fitting_optimize`], taking the SDE directly so it's testable. `mode` is
/// `"all"` (rework every relevant slot) or `"empty"` (fill only empty slots). `prices`
/// supplies unit costs for the budget constraint (empty ⇒ cost unused); `constraints`
/// are kept as hard limits on the returned fit (cap-stable / ISK budget).
fn optimize_fit(
    sde: &Sde,
    fit: Fit,
    objective: &str,
    meta_groups: Vec<i64>,
    mode: &str,
    prices: &HashMap<i64, f64>,
    constraints: Constraints,
) -> Result<OptimizeResult, String> {
    let obj = parse_objective(objective)?;
    let Some(layout) = sde.ship_layout(fit.ship_type_id).map_err(|e| e.to_string())? else {
        return Err(format!("unknown ship: {}", fit.ship_type_id));
    };
    let meta = if meta_groups.is_empty() {
        vec![1, 2] // Tech I (incl. named/meta) + Tech II
    } else {
        meta_groups
    };

    // Candidate type ids per slot kind, filtered to the allowed meta groups.
    let mut slot_candidates: Vec<(SlotKind, Vec<i64>)> = Vec::new();
    for (slot, group_ids) in opt_config(obj) {
        let mods = sde
            .modules_in_groups(&group_ids, &meta)
            .map_err(|e| e.to_string())?;
        slot_candidates.push((slot, mods.into_iter().map(|(t, _)| t).collect()));
    }

    // Drop "Polarized" weapons (Tech II, so they pass the meta filter): their
    // huge damage comes with disabled resistances, a drawback the engine doesn't
    // model — so a damage objective would always pick them. Exclude by name.
    {
        let ids: Vec<i64> = slot_candidates.iter().flat_map(|(_, c)| c.clone()).collect();
        let names: HashMap<i64, String> = sde
            .type_names(&ids)
            .map_err(|e| e.to_string())?
            .into_iter()
            .collect();
        for (_, c) in &mut slot_candidates {
            c.retain(|tid| !names.get(tid).is_some_and(|n| n.starts_with("Polarized")));
        }
    }

    // Preload everything the scorer needs in a few bulk queries.
    let skill_ids = sde.skill_type_ids().map_err(|e| e.to_string())?;
    let mut all_ids: Vec<i64> = vec![fit.ship_type_id];
    all_ids.extend(fit.items.iter().map(|i| i.type_id));
    all_ids.extend(fit.items.iter().filter_map(|i| i.charge_type_id));
    for (_, ts) in &slot_candidates {
        all_ids.extend(ts);
    }
    all_ids.extend(&skill_ids);

    let attrs = sde.types_attributes_raw(&all_ids).map_err(|e| e.to_string())?;
    let effects = sde.types_effects(&all_ids).map_err(|e| e.to_string())?;
    let groups = sde.types_groups(&all_ids).map_err(|e| e.to_string())?;
    let effect_meta = sde.effect_meta().map_err(|e| e.to_string())?;
    let defaults = sde.attribute_defaults().map_err(|e| e.to_string())?;
    let is_stackable = |attr: i64| defaults.get(&attr).map(|m| m.stackable).unwrap_or(true);
    let default_of = |attr: i64| defaults.get(&attr).map(|m| m.default_value).unwrap_or(0.0);

    // Steer the damage optimizer to the hull's *bonused* weapons. Without this it
    // maximizes raw paper-DPS and fits, say, hybrid blasters on an Amarr laser
    // hull. Restrict the high-slot weapon candidates to the groups/skills the ship
    // bonuses — but only per slot where that leaves at least one weapon, so a hull
    // with no turret/launcher bonus (e.g. a drone boat) still gets armed.
    if matches!(obj, Objective::Damage) {
        let (bgroups, bskills) = ship_weapon_bonus(fit.ship_type_id, &effects, &effect_meta);
        if !(bgroups.is_empty() && bskills.is_empty()) {
            for (slot, cands) in &mut slot_candidates {
                if *slot != SlotKind::High {
                    continue;
                }
                let kept: Vec<i64> = cands
                    .iter()
                    .copied()
                    .filter(|tid| {
                        let g = groups.get(tid).copied().unwrap_or(0);
                        bgroups.contains(&g)
                            || required_skills_of(&attrs, *tid)
                                .iter()
                                .any(|s| bskills.contains(s))
                    })
                    .collect();
                if !kept.is_empty() {
                    *cands = kept;
                }
            }
        }
    }

    let skills: Vec<EntityInput> = skill_ids
        .iter()
        .map(|sid| {
            let mut a = attrs.get(sid).cloned().unwrap_or_default();
            match a.iter_mut().find(|(k, _)| *k == 280) {
                Some(p) => p.1 = 5.0,
                None => a.push((280, 5.0)),
            }
            EntityInput {
                type_id: *sid,
                attrs: a,
                effect_ids: effects.get(sid).cloned().unwrap_or_default(),
                group_id: 0,
                required_skills: Vec::new(),
            }
        })
        .collect();

    let eval = |f: &Fit| {
        evaluate(
            obj, f, &layout, &attrs, &effects, &groups, &skills, &effect_meta, &is_stackable,
            &default_of, prices,
        )
    };
    let has_soft = constraints.cap_stable || constraints.max_cost.is_some();
    // Best fully-constraint-satisfying config seen (by true objective). The penalized
    // hill-climb can end on a violating config when none is nearby, so we fall back to
    // this to guarantee the constraints whenever a satisfying fit was reachable.
    let mut best_feasible: Option<(Fit, f64)> = None;

    let mut fit = fit;

    // Optimize ALL relevant slots, not just empty ones: clear the objective's
    // slot kinds (keeping everything else — high slots, drones, cargo) and
    // rebuild them for the best overall result.
    let relevant_kinds: Vec<SlotKind> = slot_candidates.iter().map(|(s, _)| *s).collect();
    let cands_for: HashMap<SlotKind, Vec<i64>> =
        slot_candidates.iter().map(|(s, c)| (*s, c.clone())).collect();
    // "all" reworks every relevant slot (clear + rebuild); "empty" fills only the
    // objective's empty slots, leaving your existing modules untouched.
    if mode != "empty" {
        fit.items.retain(|i| !relevant_kinds.contains(&i.slot));
    }
    // Only modules the optimizer adds from here are eligible for local-search
    // swaps, so "empty" mode never rewrites your existing choices.
    let added_start = fit.items.len();

    // Whether placing `tid` is allowed under the one-per-fit rule, ignoring the
    // item at `skip` (so a swap can replace a unique module with itself's kind).
    let unique_ok = |fit: &Fit, tid: i64, skip: Option<usize>| -> bool {
        let group = groups.get(&tid).copied().unwrap_or(0);
        if !UNIQUE_GROUPS.contains(&group) {
            return true;
        }
        !fit.items
            .iter()
            .enumerate()
            .any(|(j, i)| Some(j) != skip && groups.get(&i.type_id).copied() == Some(group))
    };

    // Record a trial that satisfies every active constraint, keeping the highest-
    // objective one (only worth tracking when there are soft constraints to honor).
    let note_feasible = |trial: &Fit, e: &Eval, best_feasible: &mut Option<(Fit, f64)>| {
        if has_soft
            && meets(e, &constraints)
            && best_feasible.as_ref().is_none_or(|(_, o)| e.objective > *o)
        {
            *best_feasible = Some((trial.clone(), e.objective));
        }
    };

    // 1) Seed.
    let mut current = eval(&fit)
        .map(|e| constraint_score(&e, &constraints))
        .unwrap_or(0.0);

    // 1a) Damage: homogeneous weapon racks — one weapon type per hardpoint class
    // (turret/launcher), filling as many hardpoints as the CPU/PG budget allows. This
    // beats the generic per-slot greedy, which is biggest-first and underfills the
    // rack (a hungry weapon in the first slots starves later hardpoints). Real fits
    // also run a uniform rack per class — never a mix of e.g. blasters and railguns —
    // so we pick a single best (count, type) for the whole class by penalized score.
    if obj == Objective::Damage {
        if let Some(high_cands) = cands_for.get(&SlotKind::High).cloned() {
            let mut remaining = (layout.high_slots
                - fit.items.iter().filter(|i| i.slot == SlotKind::High).count() as i64)
                .max(0);
            for &(effect_id, hardpoints) in
                &[(42i64, layout.turret_hardpoints), (40, layout.launcher_hardpoints)]
            {
                if remaining <= 0 {
                    break;
                }
                let cap = hardpoints.min(remaining);
                if cap <= 0 {
                    continue;
                }
                // In "empty" mode, match any weapon already in this class so the rack
                // stays uniform with the user's existing modules.
                let existing = if mode == "empty" {
                    fit.items
                        .iter()
                        .find(|i| {
                            i.slot == SlotKind::High
                                && effects.get(&i.type_id).is_some_and(|e| e.contains(&effect_id))
                        })
                        .map(|i| i.type_id)
                } else {
                    None
                };
                let class_cands: Vec<i64> = match existing {
                    Some(t) => vec![t],
                    None => high_cands
                        .iter()
                        .copied()
                        .filter(|t| effects.get(t).is_some_and(|e| e.contains(&effect_id)))
                        .collect(),
                };
                if class_cands.is_empty() {
                    continue;
                }
                // Best (count, type) for the class by penalized score. With no soft
                // constraints, more weapons strictly raises the objective so the full
                // rack wins; cap-stable can instead favour a smaller, stable rack.
                let mut best: Option<(i64, i64, f64)> = None;
                for count in 1..=cap {
                    for &tid in &class_cands {
                        let mut trial = fit.clone();
                        add_weapons(&mut trial, tid, count);
                        if let Some(e) = eval(&trial) {
                            let v = constraint_score(&e, &constraints);
                            note_feasible(&trial, &e, &mut best_feasible);
                            if best.is_none_or(|(_, _, bv)| v > bv + 1e-6) {
                                best = Some((count, tid, v));
                            }
                        }
                    }
                }
                if let Some((count, tid, v)) = best {
                    add_weapons(&mut fit, tid, count);
                    remaining -= count;
                    current = v;
                }
            }
        }
    }

    // 1b) Generic greedy for the remaining slot kinds (and every slot for non-damage
    // objectives): fill each with the single best valid candidate, one at a time.
    for (slot, cands) in &slot_candidates {
        if obj == Objective::Damage && *slot == SlotKind::High {
            continue; // weapons handled above
        }
        let cap = slot_capacity(&layout, *slot);
        while (fit.items.iter().filter(|i| i.slot == *slot).count() as i64) < cap {
            let index = fit.items.iter().filter(|i| i.slot == *slot).count() as i32;
            let mut best: Option<(i64, f64)> = None;
            for &tid in cands {
                if !unique_ok(&fit, tid, None) {
                    continue;
                }
                let mut trial = fit.clone();
                trial.items.push(new_module(tid, *slot, index));
                if let Some(e) = eval(&trial) {
                    let v = constraint_score(&e, &constraints);
                    note_feasible(&trial, &e, &mut best_feasible);
                    if v > current + 1e-6 && best.is_none_or(|(_, bv)| v > bv) {
                        best = Some((tid, v));
                    }
                }
            }
            match best {
                Some((tid, v)) => {
                    fit.items.push(new_module(tid, *slot, index));
                    current = v;
                }
                None => break, // nothing further improves this slot kind
            }
        }
    }

    // 2) Local search — re-pick each relevant slot given the final mix (stacking
    // penalties make the best choice interdependent), iterating to a local optimum.
    // Weapon slots are swapped as a whole class (below), never per-slot, so the rack
    // stays uniform. Seed + local search is a strong, near-global result over the
    // curated candidate pool (a true global optimum is combinatorially intractable
    // for the full module catalogue).
    loop {
        let mut improved = false;
        let n = fit.items.len();
        for idx in added_start..n {
            let slot = fit.items[idx].slot;
            if obj == Objective::Damage && slot == SlotKind::High {
                continue; // weapon racks are swapped as a unit, below
            }
            let Some(cands) = cands_for.get(&slot) else {
                continue; // not a relevant (optimized) slot
            };
            let orig = fit.items[idx].type_id;
            let (mut best_tid, mut best_val) = (orig, current);
            for &tid in cands {
                if tid == orig || !unique_ok(&fit, tid, Some(idx)) {
                    continue;
                }
                let mut trial = fit.clone();
                trial.items[idx].type_id = tid;
                if let Some(e) = eval(&trial) {
                    let v = constraint_score(&e, &constraints);
                    note_feasible(&trial, &e, &mut best_feasible);
                    if v > best_val + 1e-6 {
                        best_val = v;
                        best_tid = tid;
                    }
                }
            }
            if best_tid != orig {
                fit.items[idx].type_id = best_tid;
                current = best_val;
                improved = true;
            }
        }

        // Whole-class weapon swaps (damage): re-pick a single type for each hardpoint
        // class together, so an upgrade applies to the entire rack and it never goes
        // heterogeneous.
        if obj == Objective::Damage {
            if let Some(high_cands) = cands_for.get(&SlotKind::High).cloned() {
                for &effect_id in &[42i64, 40] {
                    let idxs: Vec<usize> = (added_start..fit.items.len())
                        .filter(|&i| {
                            fit.items[i].slot == SlotKind::High
                                && effects
                                    .get(&fit.items[i].type_id)
                                    .is_some_and(|e| e.contains(&effect_id))
                        })
                        .collect();
                    if idxs.is_empty() {
                        continue;
                    }
                    let orig = fit.items[idxs[0]].type_id;
                    let (mut best_tid, mut best_val) = (orig, current);
                    for &tid in high_cands
                        .iter()
                        .filter(|t| effects.get(t).is_some_and(|e| e.contains(&effect_id)))
                    {
                        if tid == orig {
                            continue;
                        }
                        let mut trial = fit.clone();
                        for &i in &idxs {
                            trial.items[i].type_id = tid;
                        }
                        if let Some(e) = eval(&trial) {
                            let v = constraint_score(&e, &constraints);
                            note_feasible(&trial, &e, &mut best_feasible);
                            if v > best_val + 1e-6 {
                                best_val = v;
                                best_tid = tid;
                            }
                        }
                    }
                    if best_tid != orig {
                        for &i in &idxs {
                            fit.items[i].type_id = best_tid;
                        }
                        current = best_val;
                        improved = true;
                    }
                }
            }
        }

        if !improved {
            break;
        }
    }

    // Guarantee the requested hard constraints: if the hill-climb ended on a config
    // that violates one, fall back to the best fully-feasible config seen (if any).
    if has_soft && !eval(&fit).is_some_and(|e| meets(&e, &constraints)) {
        if let Some((bf, _)) = best_feasible.take() {
            fit = bf;
        }
    }

    // 3) Drones — for a damage objective, arm the drone bay. Drones aren't slots:
    // the number flying is capped by the ship's bandwidth (1271) divided by each
    // drone's bandwidth use (1272) and the 5-in-space limit (Drones V), not a slot
    // count, so they get their own pass. Pick the combat drone (group 100) whose
    // full flight does the most damage — bigger drones hit harder but fewer fit
    // the bandwidth (e.g. a Vexor's 75 fields 5 medium or 3 heavy). Honors `mode`:
    // "all" refits the bay, "empty" only arms an empty bay.
    if matches!(obj, Objective::Damage) {
        let has_drones = fit.items.iter().any(|i| i.slot == SlotKind::Drone);
        if mode != "empty" || !has_drones {
            let bandwidth = attrs
                .get(&fit.ship_type_id)
                .and_then(|a| a.iter().find(|(k, _)| *k == 1271).map(|(_, v)| *v))
                .unwrap_or(0.0);
            if bandwidth > 0.0 {
                let drone_cands = sde.modules_in_groups(&[100], &meta).map_err(|e| e.to_string())?;
                let drone_ids: Vec<i64> = drone_cands.iter().map(|(t, _)| *t).collect();
                let drone_attrs = sde.types_attributes_raw(&drone_ids).map_err(|e| e.to_string())?;
                // (type id, flight size, total flight damage proxy).
                let mut best: Option<(i64, i64, f64)> = None;
                for tid in &drone_ids {
                    let get = |id: i64| {
                        drone_attrs
                            .get(tid)
                            .and_then(|a| a.iter().find(|(k, _)| *k == id).map(|(_, v)| *v))
                            .unwrap_or(0.0)
                    };
                    let bw = get(1272);
                    let rof = get(51) / 1000.0;
                    if bw <= 0.0 || rof <= 0.0 {
                        continue;
                    }
                    let per = get(64) * base_damage(&drone_attrs, *tid) / rof;
                    let count = (bandwidth / bw).floor().min(5.0) as i64;
                    if per <= 0.0 || count <= 0 {
                        continue;
                    }
                    let total = per * count as f64;
                    if best.is_none_or(|(_, _, bt)| total > bt) {
                        best = Some((*tid, count, total));
                    }
                }
                if let Some((tid, count, _)) = best {
                    fit.items.retain(|i| i.slot != SlotKind::Drone);
                    fit.items.push(FitItem {
                        type_id: tid,
                        slot: SlotKind::Drone,
                        index: 0,
                        state: ModuleState::Active,
                        charge_type_id: None,
                        quantity: count as i32,
                    });
                }
            }
        }

        // 4) Ammo — a turret/launcher with no charge does **zero** damage, so an
        // unarmed "optimize for damage" result reads as 0 DPS (and the UI hides the
        // panel). Load each empty weapon with the highest-damage compatible charge:
        // matching charge size (128) and one of the weapon's allowed charge groups
        // (604/605/606/609/610), in the allowed meta.
        let attr_of = |tid: i64, aid: i64| -> Option<f64> {
            attrs
                .get(&tid)
                .and_then(|a| a.iter().find(|(k, _)| *k == aid).map(|(_, v)| *v))
        };
        // Every charge group any fitted weapon accepts, gathered once.
        let mut all_charge_groups: Vec<i64> = fit
            .items
            .iter()
            .filter(|i| i.slot == SlotKind::High && i.charge_type_id.is_none())
            .flat_map(|i| [604, 605, 606, 609, 610].iter().filter_map(|g| attr_of(i.type_id, *g)))
            .map(|v| v as i64)
            .collect();
        all_charge_groups.sort_unstable();
        all_charge_groups.dedup();
        if !all_charge_groups.is_empty() {
            let charge_cands = sde
                .modules_in_groups(&all_charge_groups, &meta)
                .map_err(|e| e.to_string())?;
            let charge_ids: Vec<i64> = charge_cands.iter().map(|(t, _)| *t).collect();
            let charge_attrs = sde.types_attributes_raw(&charge_ids).map_err(|e| e.to_string())?;
            let charge_size_of = |tid: i64| -> Option<f64> {
                charge_attrs
                    .get(&tid)
                    .and_then(|a| a.iter().find(|(k, _)| *k == 128).map(|(_, v)| *v))
            };
            for item in fit.items.iter_mut() {
                if item.slot != SlotKind::High || item.charge_type_id.is_some() {
                    continue;
                }
                let groups: Vec<i64> = [604, 605, 606, 609, 610]
                    .iter()
                    .filter_map(|g| attr_of(item.type_id, *g))
                    .map(|v| v as i64)
                    .collect();
                if groups.is_empty() {
                    continue; // not a charged weapon (e.g. smartbomb)
                }
                let size = attr_of(item.type_id, 128);
                let best = charge_cands
                    .iter()
                    .filter(|(_, g)| groups.contains(g))
                    // Match charge size when both sides declare one.
                    .filter(|(c, _)| match (size, charge_size_of(*c)) {
                        (Some(w), Some(cs)) => (w - cs).abs() < 0.5,
                        _ => true,
                    })
                    .map(|(c, _)| (*c, base_damage(&charge_attrs, *c)))
                    .filter(|(_, d)| *d > 0.0)
                    .max_by(|a, b| a.1.total_cmp(&b.1));
                if let Some((charge, _)) = best {
                    item.charge_type_id = Some(charge);
                }
            }
        }
    }

    // Report whether the final fit (after the drone/ammo passes) meets the requested
    // constraints, so the UI can warn when a target couldn't be reached.
    let report = eval(&fit);
    let cap_stable = report.as_ref().is_some_and(|e| e.cap_stable);
    let within_budget = report
        .as_ref()
        .is_none_or(|e| constraints.max_cost.is_none_or(|m| e.cost <= m + 1.0));

    Ok(OptimizeResult {
        fit,
        cap_stable,
        within_budget,
    })
}

/// The local saved-fits document.
fn load_fits(dir: &Path) -> Vec<Fit> {
    storage::load_data(dir, FITS_KEY).unwrap_or_default()
}

/// Save (insert or update by id) a fit locally; returns its id (#164).
#[tauri::command]
pub fn fitting_save_local(app: AppHandle, mut fit: Fit) -> Result<String, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
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
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(load_fits(&dir))
}

/// A single locally saved fit by id, or `None` (#164).
#[tauri::command]
pub fn fitting_load_local(app: AppHandle, id: String) -> Result<Option<Fit>, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    Ok(load_fits(&dir).into_iter().find(|f| f.id == id))
}

/// Delete a locally saved fit by id (no-op if absent) (#164).
#[tauri::command]
pub fn fitting_delete_local(app: AppHandle, id: String) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let mut fits = load_fits(&dir);
    fits.retain(|f| f.id != id);
    storage::save_data(&dir, FITS_KEY, &fits)
}

#[cfg(test)]
mod tests {
    use super::*;

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
                        module("Multispectrum Energized Membrane II", SlotKind::Low, None, 0),
                        module("Multispectrum Energized Membrane II", SlotKind::Low, None, 1),
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
            if !close(dps, g.dps, 0.005) { p.push(format!("dps {dps:.2}≠{:.2}", g.dps)); }
            if !close(ehp, g.ehp, 0.01) { p.push(format!("ehp {ehp:.1}≠{:.1}", g.ehp)); }
            if stable != g.cap_stable { p.push(format!("cap {stable}≠{}", g.cap_stable)); }
            if stable && !close(cap_pct, g.cap_pct, 0.01) {
                p.push(format!("cap% {cap_pct:.2}≠{:.2}", g.cap_pct));
            }
            if !stable && !close(depletion, g.cap_depletion, 0.02) {
                p.push(format!("cap-depletion {depletion:.1}≠{:.1}", g.cap_depletion));
            }
            if !close(vel, g.vel, 0.005) { p.push(format!("vel {vel:.2}≠{:.2}", g.vel)); }
            if !close(align, g.align, 0.005) { p.push(format!("align {align:.3}≠{:.3}", g.align)); }
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
        assert!(offline.weapon_ranges.is_empty(), "offline gun shows no range");
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
        assert!(active.activatable_types.contains(&tid("1MN Afterburner II")));
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
        let mut items = vec![item(10, SlotKind::Low, None, 1), item(20, SlotKind::High, None, 1)];
        items[0].index = 0;
        items[1].index = 0;
        // Empty slot starts at 0; occupied slots continue past their max.
        assert_eq!(next_slot_index(&items, SlotKind::Mid), 0);
        assert_eq!(next_slot_index(&items, SlotKind::Low), 1);
        items.push(FitItem { index: 1, ..item(11, SlotKind::Low, None, 1) });
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
        let prices = HashMap::from([(100, 1000.0), (10, 50.0), (20, 200.0), (30, 5.0), (40, 10.0)]);
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
        assert!((constraint_score(&e, &both) - 100.0 * CONSTRAINT_PENALTY * CONSTRAINT_PENALTY).abs() < 1e-9);
        assert!(!meets(&e, &both));
    }

    #[test]
    fn classifies_ew_groups_and_flags() {
        // Modeled vs unmodeled vs jam.
        assert_eq!(ew_category(65), Some("web")); // Stasis Web
        assert_eq!(ew_category(1672), Some("web")); // Stasis Grappler
        assert_eq!(ew_category(208), Some("damp")); // Sensor Dampener
        assert_eq!(ew_category(291), Some("weaponDisruption"));
        assert_eq!(ew_category(201), Some("ecm"));
        assert_eq!(ew_category(80), Some("ecm")); // Burst Jammer
        assert_eq!(ew_category(68), Some("nos"));
        assert_eq!(ew_category(587), None); // a Rifter hull, not EW
        // ECM is the jam category; web/paint/damp are the modeled ones.
        assert_eq!(ew_label("ecm"), "ECM");
        assert_eq!(ew_label("weaponDisruption"), "Tracking/Guidance Disruption");
    }
}
















