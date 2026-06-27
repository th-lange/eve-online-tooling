//! Tauri command surface for the fitting module.
//!
//! Commands open the SDE read-only per call (cheap) and orchestrate the shared
//! services, like the production module. P1 adds pricing/validation/storage
//! commands here; the dogma `simulate` command lands with the engine (P2).

use std::collections::HashMap;
use std::path::Path;

use tauri::{AppHandle, Manager, State};

use super::eft::{self, ParsedEft, ParsedExtra, ParsedModule};
use super::engine::validate::{validate, ValItem};
use super::engine::capacitor::capacitor;
use super::engine::damage::{damage, Weapon};
use super::engine::navigation::{navigation, targeting};
use super::engine::resolve::{resolve, EntityInput, FitInput, ResolvedFit};
use super::engine::tank::{tank, DamageProfile, Layer};
use super::types::{
    CapStats, DpsBreakdown, Fit, FitItem, FitPrice, FitPriceLine, FitProblem, FitStats,
    ModuleState, NavStats, ResourceUsage, Severity, SlotKind, TankStats, TargetStats,
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
            state: ModuleState::Online,
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
    })
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
        targeting: dogma.map(|d| d.targeting),
        price: None,
    })
}

/// Dogma-engine stats derived from one resolution pass.
struct DogmaStats {
    /// CPU/PG/calibration usage + output, from *finalized* attributes.
    resources: ResourceUsage,
    /// Slot/resource validation against the *finalized* attributes.
    validation: Vec<FitProblem>,
    capacitor: CapStats,
    tank: TankStats,
    dps: DpsBreakdown,
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

    let skill_ids = sde.skill_type_ids().map_err(|e| e.to_string())?;
    let mut all_ids = Vec::with_capacity(1 + module_items.len() + skill_ids.len());
    all_ids.push(fit.ship_type_id);
    all_ids.extend(module_items.iter().map(|i| i.type_id));
    all_ids.extend(module_items.iter().filter_map(|i| i.charge_type_id));
    all_ids.extend(drone_items.iter().map(|i| i.type_id));
    all_ids.extend(&skill_ids);

    let attrs = sde.types_attributes_raw(&all_ids).map_err(|e| e.to_string())?;
    let effects_by_type = sde.types_effects(&all_ids).map_err(|e| e.to_string())?;
    let effect_meta = sde.effect_meta().map_err(|e| e.to_string())?;
    let defaults = sde.attribute_defaults().map_err(|e| e.to_string())?;
    let is_stackable = |attr: i64| defaults.get(&attr).map(|m| m.stackable).unwrap_or(true);

    let entity = |type_id: i64, required_skills: Vec<i64>| -> Result<EntityInput, String> {
        let group_id = sde
            .type_info(type_id)
            .map_err(|e| e.to_string())?
            .map(|t| t.group_id)
            .unwrap_or(0);
        Ok(EntityInput {
            attrs: attrs.get(&type_id).cloned().unwrap_or_default(),
            effect_ids: effects_by_type.get(&type_id).cloned().unwrap_or_default(),
            group_id,
            required_skills,
        })
    };

    let ship = entity(fit.ship_type_id, Vec::new())?;

    let mut modules = Vec::with_capacity(module_items.len());
    for it in &module_items {
        // All required skills (182/183/184) drive *RequiredSkillModifier targeting.
        modules.push(entity(it.type_id, required_skills_of(&attrs, it.type_id))?);
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
            attrs: a,
            effect_ids: effects_by_type.get(sid).cloned().unwrap_or_default(),
            group_id: 0,
            required_skills: Vec::new(),
        });
    }

    let resolved = resolve(&FitInput { ship, modules, skills }, &effect_meta, &is_stackable);

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

    // Finalized fitting resources + validation: read CPU/PG/calibration from the
    // *resolved* ship + modules so skills (CPU/PG Management, weapon CPU, …) and
    // rigs/modules are reflected — not base attributes. Slot/hardpoint counts and
    // drone bay come from the resolved hull too (also handles T3 subsystems).
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
            val_items.push(ValItem {
                slot: item.slot,
                cpu: store.get(50),
                powergrid: store.get(30),
                calibration: store.get(1153),
                is_turret,
                is_launcher,
                drone_volume: 0.0,
                quantity: item.quantity.max(1),
            });
        } else if item.slot == SlotKind::Drone {
            let drone_volume = sde
                .type_info(item.type_id)
                .ok()
                .flatten()
                .and_then(|t| t.volume)
                .unwrap_or(0.0);
            val_items.push(ValItem {
                slot: SlotKind::Drone,
                cpu: 0.0,
                powergrid: 0.0,
                calibration: 0.0,
                is_turret: false,
                is_launcher: false,
                drone_volume,
                quantity: item.quantity.max(1),
            });
        }
    }
    let (resources, validation) = validate(&resolved_layout, &val_items);

    Ok(DogmaStats {
        resources,
        validation,
        capacitor: capacitor_of(&resolved),
        tank: tank_of(&resolved),
        dps: dps_of(&resolved, &module_items, &drone_items, &attrs),
        navigation: navigation(s.get(37), mass, s.get(70), s.get(552)),
        targeting: targeting(
            s.get(192),
            s.get(76),
            s.get(564),
            [s.get(208), s.get(209), s.get(210), s.get(211)],
        ),
    })
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

/// DPS from a resolved fit (#174). Turrets read finalized `damageMultiplier`
/// (64) + `speed` (51); missiles (a charged weapon with no multiplier) ride on
/// the charge; drones use base attributes (their skill bonuses await drone
/// resolution). `module_items` is parallel to `resolved.modules`.
fn dps_of(
    resolved: &ResolvedFit,
    module_items: &[&FitItem],
    drone_items: &[&FitItem],
    attrs: &HashMap<i64, Vec<(i64, f64)>>,
) -> DpsBreakdown {
    let mut turrets = Vec::new();
    let mut missiles = Vec::new();
    for (item, store) in module_items.iter().zip(&resolved.modules) {
        let Some(charge) = item.charge_type_id else {
            continue;
        };
        let damage_per_shot = base_damage(attrs, charge);
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
        .map(|d| {
            let get = |id: i64| {
                attrs
                    .get(&d.type_id)
                    .and_then(|a| a.iter().find(|(k, _)| *k == id).map(|(_, v)| *v))
                    .unwrap_or(0.0)
            };
            Weapon {
                damage_mult: get(64),
                damage_per_shot: base_damage(attrs, d.type_id),
                rof_seconds: get(51) / 1000.0,
                count: d.quantity.max(1),
            }
        })
        .collect();

    damage(&turrets, &missiles, &drones)
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
fn capacitor_of(resolved: &ResolvedFit) -> CapStats {
    let mut drain = 0.0;
    for store in &resolved.modules {
        let need = store.get(6);
        let dur = store.get(73);
        if need > 0.0 && dur > 0.0 {
            drain += need / (dur / 1000.0);
        }
    }
    capacitor(resolved.ship.get(482), resolved.ship.get(55), drain)
}

/// Tank from a resolved fit (#173): HP + resonances from the ship, local rep/s
/// from shield boosters (shieldBonus 68) and armor repairers (armorDamageAmount
/// 84). Even 25/25/25/25 damage profile.
fn tank_of(resolved: &ResolvedFit) -> TankStats {
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
    for store in &resolved.modules {
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

    tank(
        shield,
        armor,
        hull,
        &DamageProfile::default(),
        shield_rep_s,
        armor_rep_s,
    )
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

type AttrMap = HashMap<i64, Vec<(i64, f64)>>;
type EffectMap = HashMap<i64, Vec<i64>>;
type GroupMap = HashMap<i64, i64>;

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
        attrs: attrs.get(&type_id).cloned().unwrap_or_default(),
        effect_ids: effects.get(&type_id).cloned().unwrap_or_default(),
        group_id: groups.get(&type_id).copied().unwrap_or(0),
        required_skills: required_skills_of(attrs, type_id),
    }
}

/// Slot/resource validation items from preloaded maps (no SDE calls).
fn val_items_cached(fit: &Fit, attrs: &AttrMap, effects: &EffectMap) -> Vec<ValItem> {
    fit.items
        .iter()
        .map(|item| {
            let a: HashMap<i64, f64> = attrs
                .get(&item.type_id)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .collect();
            let get = |id: i64| a.get(&id).copied().unwrap_or(0.0);
            let eff = effects.get(&item.type_id);
            let is_turret = item.slot == SlotKind::High && eff.is_some_and(|e| e.contains(&42));
            let is_launcher = item.slot == SlotKind::High && eff.is_some_and(|e| e.contains(&40));
            ValItem {
                slot: item.slot,
                cpu: get(50),
                powergrid: get(30),
                calibration: get(1153),
                is_turret,
                is_launcher,
                drone_volume: 0.0, // optimizer doesn't change drones
                quantity: item.quantity.max(1),
            }
        })
        .collect()
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

/// The objective value for a fit, or `None` if the fit doesn't fit (over CPU/PG/
/// calibration/slots/hardpoints). Uses preloaded maps + cached skills.
#[allow(clippy::too_many_arguments)]
fn objective_value(
    obj: Objective,
    fit: &Fit,
    layout: &ShipLayout,
    attrs: &AttrMap,
    effects: &EffectMap,
    groups: &GroupMap,
    skills: &[EntityInput],
    effect_meta: &HashMap<i64, crate::sde::EffectMeta>,
    is_stackable: &impl Fn(i64) -> bool,
) -> Option<f64> {
    // Reject fits that don't fit.
    let (_, problems) = validate(layout, &val_items_cached(fit, attrs, effects));
    if problems.iter().any(|p| p.severity == Severity::Error) {
        return None;
    }

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
        },
        effect_meta,
        is_stackable,
    );

    let value = match obj {
        Objective::Tank => tank_of(&resolved).ehp,
        Objective::Repair => {
            let t = tank_of(&resolved);
            t.shield_rep_s + t.armor_rep_s
        }
        Objective::Damage => damage_score(&resolved, &module_items, &drone_items, attrs),
        Objective::Yield => mining_yield(&resolved),
    };
    Some(value)
}

/// Optimize a fit for an objective (`"tank"` | `"damage"` | `"repair"` |
/// `"yield"`) by **reworking all of its objective-relevant slots** (clearing
/// and rebuilding mid/low/rig — or high for mining — while leaving everything
/// else). Candidates are drawn from the allowed meta groups (`meta_groups`;
/// default Tech I + Tech II). A greedy seed + iterated local search finds a
/// strong, near-global combination, scored at all-V via the dogma engine; only
/// valid (fitting) configurations are kept (#156).
#[tauri::command]
pub fn fitting_optimize(
    app: AppHandle,
    fit: Fit,
    objective: String,
    meta_groups: Vec<i64>,
    mode: Option<String>,
) -> Result<Fit, String> {
    optimize_fit(
        &open_sde(&app)?,
        fit,
        &objective,
        meta_groups,
        mode.as_deref().unwrap_or("all"),
    )
}

/// Core of [`fitting_optimize`], taking the SDE directly so it's testable.
/// `mode` is `"all"` (rework every relevant slot) or `"empty"` (fill only the
/// objective's empty slots, leaving existing modules untouched).
fn optimize_fit(
    sde: &Sde,
    fit: Fit,
    objective: &str,
    meta_groups: Vec<i64>,
    mode: &str,
) -> Result<Fit, String> {
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

    let skills: Vec<EntityInput> = skill_ids
        .iter()
        .map(|sid| {
            let mut a = attrs.get(sid).cloned().unwrap_or_default();
            match a.iter_mut().find(|(k, _)| *k == 280) {
                Some(p) => p.1 = 5.0,
                None => a.push((280, 5.0)),
            }
            EntityInput {
                attrs: a,
                effect_ids: effects.get(sid).cloned().unwrap_or_default(),
                group_id: 0,
                required_skills: Vec::new(),
            }
        })
        .collect();

    let score = |f: &Fit| {
        objective_value(
            obj, f, &layout, &attrs, &effects, &groups, &skills, &effect_meta, &is_stackable,
        )
    };

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

    // 1) Seed — greedily fill each cleared slot with the best valid candidate.
    let mut current = score(&fit).unwrap_or(0.0);
    for (slot, cands) in &slot_candidates {
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
                if let Some(v) = score(&trial) {
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
    // penalties make the best choice interdependent), iterating to a local
    // optimum. Seed + local search is a strong, near-global result over the
    // curated candidate pool (a true global optimum is combinatorially
    // intractable for the full module catalogue).
    let n = fit.items.len();
    loop {
        let mut improved = false;
        for idx in added_start..n {
            let slot = fit.items[idx].slot;
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
                if let Some(v) = score(&trial) {
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
        if !improved {
            break;
        }
    }

    Ok(fit)
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









