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
    CapStats, DpsBreakdown, Fit, FitItem, FitPrice, FitPriceLine, FitStats, ModuleState, NavStats,
    SlotKind, TankStats, TargetStats,
};
use crate::esi::{authed_get, AuthState};
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

    let (resources, validation) = validate(&ship, &val_items);

    // Dogma engine (all-V): resolve finalized attributes and derive stats.
    // Best-effort — if the engine can't run, those stats are simply absent.
    let dogma = run_dogma(&sde, &fit, &skill_level_for).ok();

    Ok(FitStats {
        resources,
        validation,
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

    let entity = |type_id: i64, required_skill: Option<i64>| -> Result<EntityInput, String> {
        let group_id = sde
            .type_info(type_id)
            .map_err(|e| e.to_string())?
            .map(|t| t.group_id)
            .unwrap_or(0);
        Ok(EntityInput {
            attrs: attrs.get(&type_id).cloned().unwrap_or_default(),
            effect_ids: effects_by_type.get(&type_id).cloned().unwrap_or_default(),
            group_id,
            required_skill,
        })
    };

    let ship = entity(fit.ship_type_id, None)?;

    let mut modules = Vec::with_capacity(module_items.len());
    for it in &module_items {
        // requiredSkill1 (attr 182) drives *RequiredSkillModifier targeting.
        let required_skill = attrs
            .get(&it.type_id)
            .and_then(|a| a.iter().find(|(k, _)| *k == 182).map(|(_, v)| *v as i64));
        modules.push(entity(it.type_id, required_skill)?);
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
            required_skill: None,
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

    Ok(DogmaStats {
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
