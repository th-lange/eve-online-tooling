//! Fitting dogma-derivation layer: resolve a fit once and turn the finalized
//! attributes into the editor's stats (capacitor, tank, DPS, ranges, nav,
//! targeting). Shared by the simulate command and the optimizer. Split out of
//! commands.rs (#331).

use std::collections::HashMap;

use tauri::{AppHandle, Manager};

use super::engine::attr::AttrStore;
use super::engine::capacitor::capacitor;
use super::engine::damage::{damage, Weapon};
use super::engine::navigation::{navigation, prop_velocity, targeting};
use super::engine::projection::{
    apply_projection, apply_subsystem_slots, projected_from_attrs, ProjectedInput,
};
use super::engine::resolve::{resolve, EntityInput, FitInput, ResolvedFit};
use super::engine::tank::{tank, DamageProfile, Layer};
use super::engine::validate::{validate, ValItem};
use super::types::{
    CapStats, DpsBreakdown, Fit, FitItem, FitProblem, ModuleState, NavStats, ResourceUsage,
    SlotKind, TankStats, TargetStats, WeaponRange,
};
use crate::esi::{authed_get, AuthState};
use crate::sde::{Sde, ShipLayout};
use crate::storage;

/// Dogma-engine stats derived from one resolution pass.
pub(super) struct DogmaStats {
    /// CPU/PG/calibration usage + output, from *finalized* attributes.
    pub(super) resources: ResourceUsage,
    /// Slot/resource validation against the *finalized* attributes.
    pub(super) validation: Vec<FitProblem>,
    /// Resolved slot layout (T3 subsystems grant slots), for the editor.
    pub(super) layout: ShipLayout,
    /// Type ids of fitted modules that can be activated (have a duration effect).
    pub(super) activatable_types: Vec<i64>,
    pub(super) capacitor: CapStats,
    pub(super) tank: TankStats,
    pub(super) dps: DpsBreakdown,
    pub(super) weapon_ranges: Vec<WeaponRange>,
    pub(super) navigation: NavStats,
    pub(super) targeting: TargetStats,
}

/// Build the engine inputs (ship + modules + all-V skills) from the SDE, resolve
/// the fit once, and derive the dogma stats from the finalized attributes
/// (capacitor #172, tank #173).
pub(super) fn run_dogma(
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
                SlotKind::High
                    | SlotKind::Mid
                    | SlotKind::Low
                    | SlotKind::Rig
                    | SlotKind::Subsystem
            )
        })
        .collect();

    // Drones (DPS) and charges (weapon damage) need their base attributes too.
    let drone_items: Vec<&FitItem> = fit
        .items
        .iter()
        .filter(|i| i.slot == SlotKind::Drone)
        .collect();
    // Implants modify ship attributes via shipID effects, like skills (stacking-
    // exempt), so they resolve as skill-like entities.
    let implant_items: Vec<&FitItem> = fit
        .items
        .iter()
        .filter(|i| i.slot == SlotKind::Implant)
        .collect();

    let skill_ids = sde.skill_type_ids().map_err(|e| e.to_string())?;
    let mut all_ids = Vec::with_capacity(1 + module_items.len() + skill_ids.len());
    all_ids.push(fit.ship_type_id);
    all_ids.extend(module_items.iter().map(|i| i.type_id));
    all_ids.extend(module_items.iter().filter_map(|i| i.charge_type_id));
    all_ids.extend(drone_items.iter().map(|i| i.type_id));
    all_ids.extend(implant_items.iter().map(|i| i.type_id));
    all_ids.extend(fit.projected.iter().map(|i| i.type_id));
    all_ids.extend(&skill_ids);

    let attrs = sde
        .types_attributes_raw(&all_ids)
        .map_err(|e| e.to_string())?;
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
                effect_meta
                    .get(eid)
                    .is_none_or(|m| m.duration_attribute_id.is_none())
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
        &FitInput {
            ship,
            modules,
            skills,
            drones,
            charges,
        },
        &effect_meta,
        &is_stackable,
        &default_of,
    );

    // Projected effects (#178): webs/paints/… modify this ship's attributes.
    let projected: Vec<ProjectedInput> = fit
        .projected
        .iter()
        .map(|p| {
            let a: HashMap<i64, f64> = attrs
                .get(&p.type_id)
                .cloned()
                .unwrap_or_default()
                .into_iter()
                .collect();
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
    let (resources, validation, layout) =
        resolved_feasibility(&resolved, base_layout, &effects_by_type, fit, &|tid| {
            sde.type_info(tid)
                .ok()
                .flatten()
                .and_then(|t| t.volume)
                .unwrap_or(0.0)
        });

    // Type ids of fitted modules that can actually be *activated* — i.e. carry an
    // effect with a duration. Passive modules (plates, passive hardeners, DCUs)
    // have none, so the UI shows them no active/inactive state.
    let activatable_types: Vec<i64> = module_items
        .iter()
        .map(|it| it.type_id)
        .filter(|tid| {
            effects_by_type.get(tid).is_some_and(|eids| {
                eids.iter().any(|eid| {
                    effect_meta
                        .get(eid)
                        .is_some_and(|m| m.duration_attribute_id.is_some())
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
                    module_items
                        .get(*i)
                        .is_none_or(|it| it.state == ModuleState::Active)
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
pub(super) fn resolved_feasibility(
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
pub(super) async fn character_skill_levels(
    app: &AppHandle,
    auth_state: &AuthState,
) -> Result<HashMap<i64, i64>, crate::model::AppError> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let character_id =
        storage::primary_character(&dir).ok_or_else(crate::model::AppError::auth_required)?;

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
pub(super) fn base_damage(attrs: &HashMap<i64, Vec<(i64, f64)>>, type_id: i64) -> f64 {
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
pub(super) fn resolved_damage(store: &AttrStore) -> f64 {
    store.get(114) + store.get(116) + store.get(117) + store.get(118)
}

/// DPS from a resolved fit (#174, #176). Turrets read finalized `damageMultiplier`
/// (64) + `speed` (51) and the loaded charge's base damage; **missiles** ride on
/// the *resolved* charge, so missile-damage skills and ship role bonuses (applied
/// to the charge in pass 4) count; **drones** read their resolved store, so drone
/// skills + drone-damage bonuses count. `drone_items` is parallel to
/// `resolved.drones`; `resolved.charges` is parallel to `resolved.modules`.
pub(super) fn dps_of(
    resolved: &ResolvedFit,
    module_items: &[&FitItem],
    drone_items: &[&FitItem],
) -> DpsBreakdown {
    let mut turrets = Vec::new();
    let mut missiles = Vec::new();
    for (i, store) in resolved.modules.iter().enumerate() {
        if module_items
            .get(i)
            .is_some_and(|it| it.state != ModuleState::Active)
        {
            continue; // only active weapons fire (offline/online = no DPS)
        }
        let Some(Some(charge)) = resolved.charges.get(i) else {
            continue;
        };
        let damage_per_shot = resolved_damage(charge);
        let rof_seconds = store.get(51) / 1000.0;
        let mult = store.get(64);
        if mult > 0.0 {
            turrets.push(Weapon {
                damage_mult: mult,
                damage_per_shot,
                rof_seconds,
                count: 1,
            });
        } else if rof_seconds > 0.0 {
            missiles.push(Weapon {
                damage_mult: 1.0,
                damage_per_shot,
                rof_seconds,
                count: 1,
            });
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
pub(super) fn weapon_ranges_of(
    resolved: &ResolvedFit,
    module_items: &[&FitItem],
) -> Vec<WeaponRange> {
    let mut seen = std::collections::HashSet::new();
    let mut out = Vec::new();
    for (i, store) in resolved.modules.iter().enumerate() {
        let Some(item) = module_items.get(i) else {
            continue;
        };
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

/// Capacitor stability from a resolved fit (#172). Steady drain assumes every
/// cap-using module runs (capacitorNeed 6 / duration 73 ms); per-module on/off
/// toggling is a UI follow-up.
pub(super) fn capacitor_of(resolved: &ResolvedFit, module_items: &[&FitItem]) -> CapStats {
    let mut drain = 0.0;
    let mut module_drains: Vec<(f64, f64)> = Vec::new();
    for (i, store) in resolved.modules.iter().enumerate() {
        if module_items
            .get(i)
            .is_some_and(|it| it.state != ModuleState::Active)
        {
            continue; // only active modules draw capacitor
        }
        let need = store.get(6);
        // Cap-using modules cycle on `duration` (73); weapons (lasers, hybrids)
        // cycle on rate of fire (`speed`, 51) instead, so fall back to it.
        let dur = {
            let d = store.get(73);
            if d > 0.0 {
                d
            } else {
                store.get(51)
            }
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
pub(super) fn tank_of(resolved: &ResolvedFit, module_items: &[&FitItem]) -> TankStats {
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
        if module_items
            .get(i)
            .is_some_and(|it| it.state != ModuleState::Active)
        {
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

pub(super) type AttrMap = HashMap<i64, Vec<(i64, f64)>>;

pub(super) type EffectMap = HashMap<i64, Vec<i64>>;

pub(super) type GroupMap = HashMap<i64, i64>;

/// Whether a slot kind is a ship module that affects stats (drones/cargo/
/// implants don't). Shared by the resolution pass and the optimizer.
pub(super) fn is_ship_module(slot: SlotKind) -> bool {
    matches!(
        slot,
        SlotKind::High | SlotKind::Mid | SlotKind::Low | SlotKind::Rig | SlotKind::Subsystem
    )
}

/// A type's required-skill ids (requiredSkill1/2/3 = attrs 182/183/184), for
/// `*RequiredSkillModifier` targeting.
pub(super) fn required_skills_of(attrs: &AttrMap, type_id: i64) -> Vec<i64> {
    attrs
        .get(&type_id)
        .map(|a| {
            a.iter()
                .filter(|(k, _)| matches!(k, 182..=184))
                .map(|(_, v)| *v as i64)
                .filter(|s| *s > 0)
                .collect()
        })
        .unwrap_or_default()
}
