//! Fitting dogma-derivation layer: resolve a fit once and turn the finalized
//! attributes into the editor's stats (capacitor, tank, DPS, ranges, nav,
//! targeting). Shared by the simulate command and the optimizer. Split out of
//! commands.rs (#331).

use std::collections::HashMap;

use super::context::DogmaContext;
use super::engine::application::{missile_application, turret_application};
use super::engine::attr::{attr, AttrStore};
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
    CapStats, DpsBreakdown, EwTag, Fit, FitItem, FitProblem, FitStats, ModuleState, NavStats,
    ResourceUsage, SlotKind, TankStats, TargetProfile, TargetStats, WeaponRange,
};
use crate::sde::{Sde, ShipLayout};

/// The hard cap on simultaneously active drones — five, at Drones V, which
/// the app assumes (all-V skills by default, same basis as everything else
/// in this module).
const MAX_ACTIVE_DRONES: i32 = 5;

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
    /// Authoritative active (deployed) count per fitted item, parallel to
    /// `fit.items` by index — `None` for non-drone items.
    pub(super) drone_active: Vec<Option<i32>>,
    /// How many of each fitted drone stack *could ever* be active on this
    /// hull (bandwidth cap, independent of what other stacks currently use),
    /// parallel to `fit.items` — `None` for non-drone items. The star-count
    /// display cap (#712 follow-up): some hulls can only fly 2 of a
    /// bandwidth-hungry drone type.
    pub(super) drone_max_active: Vec<Option<i32>>,
    /// Applied DPS against the supplied target profile (#701); `None` when
    /// no target profile was given.
    pub(super) applied_dps: Option<DpsBreakdown>,
    /// DPS-over-range curve (#701); empty when no target profile was given.
    pub(super) dps_range_curve: Vec<(f64, f64)>,
}

/// Build the engine inputs (ship + modules + all-V skills) from the SDE, resolve
/// the fit once, and derive the dogma stats from the finalized attributes
/// (capacitor #172, tank #173). `target_profile`, when given, additionally
/// computes applied DPS and the DPS-vs-range curve (#701). `fleet_boosts`
/// (#705) are command-burst/fleet-link modules the user is "receiving" from a
/// fleet member — `(module_type_id, charge_type_id)` pairs, `-1` meaning no
/// charge loaded — whose `GangModifier` effects project onto this ship.
#[allow(clippy::too_many_arguments)] // one arg per independent sim input; a struct would just rename them
pub(super) fn run_dogma(
    sde: &Sde,
    fit: &Fit,
    base_layout: &ShipLayout,
    skill_level_for: &dyn Fn(i64) -> f64,
    damage_profile: &DamageProfile,
    neut_gjs: f64,
    target_profile: Option<&TargetProfile>,
    fleet_boosts: &[(i64, i64)],
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

    // Preload every dogma-engine input the resolution pass needs in five bulk
    // SDE queries — no per-type round-trips inside the loops below.
    let mut extra_ids = Vec::with_capacity(
        1 + module_items.len() * 2
            + drone_items.len()
            + implant_items.len()
            + fit.projected.len()
            + fleet_boosts.len() * 2,
    );
    extra_ids.push(fit.ship_type_id);
    extra_ids.extend(module_items.iter().map(|i| i.type_id));
    extra_ids.extend(module_items.iter().filter_map(|i| i.charge_type_id));
    extra_ids.extend(drone_items.iter().map(|i| i.type_id));
    extra_ids.extend(implant_items.iter().map(|i| i.type_id));
    extra_ids.extend(fit.projected.iter().map(|i| i.type_id));
    extra_ids.extend(fleet_boosts.iter().map(|&(m, _)| m));
    extra_ids.extend(
        fleet_boosts
            .iter()
            .filter_map(|&(_, c)| (c > 0).then_some(c)),
    );
    let ctx = DogmaContext::load(sde, &extra_ids)?;

    let mut ship = ctx.entity(fit.ship_type_id, Vec::new());
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
        let mut e = ctx.entity(it.type_id, required_skills_of(&ctx.attrs, it.type_id));
        // State gates which effects run. Offline: none (no ship modifiers, no
        // fitting use). Online (not active): only passive effects — drop the
        // activatable ones (those with a duration), so e.g. an *active* hardener
        // stops adding resist while a passive one keeps it. Active: everything.
        // Modules stay in place so `resolved.modules` lines up with the fit; the
        // active-stat passes (DPS/reps/prop) additionally skip non-active modules.
        match it.state {
            ModuleState::Offline => e.effect_ids.clear(),
            ModuleState::Online => e.effect_ids.retain(|eid| {
                ctx.effect_meta
                    .get(eid)
                    .is_none_or(|m| m.duration_attribute_id.is_none())
            }),
            _ => {}
        }
        // Overheated modules include their category-5 (overload) effects on top
        // of the normal ones (#703); resolve.rs gates on this per-entity flag.
        e.overheated = it.state == ModuleState::Overheated;
        modules.push(e);
    }

    // Pass-4 aux entities. Charges are parallel to `modules`; drones to
    // `drone_items`. Their required skills let missile-/drone-damage skills and
    // ship role bonuses reach them (`SkillReqOnShip`).
    let mut charges: Vec<Option<EntityInput>> = Vec::with_capacity(module_items.len());
    for it in &module_items {
        charges.push(
            it.charge_type_id
                .map(|cid| ctx.entity(cid, required_skills_of(&ctx.attrs, cid))),
        );
    }
    let mut drones = Vec::with_capacity(drone_items.len());
    for it in &drone_items {
        drones.push(ctx.entity(it.type_id, required_skills_of(&ctx.attrs, it.type_id)));
    }

    // Skills at the chosen level (all-V or the character's). skillLevel (280) is
    // forced to that level; untrained (level 0) skills are skipped entirely.
    let mut skills = ctx.skill_entities(skill_level_for);
    // Implants resolve alongside skills — their shipID effects modify the ship,
    // stacking-exempt, which the skills pass already guarantees.
    for it in &implant_items {
        skills.push(ctx.entity(it.type_id, Vec::new()));
    }

    // Fleet boosts (#705): command-burst/fleet-link modules the user is
    // "receiving". Built as ordinary entities; a loaded charge's base
    // attributes merge in on top of the module's own (command-burst charges
    // carry the burst's magnitude attribute, which the module's GangModifier
    // effect reads to scale its bonus).
    let mut gang_modules = Vec::with_capacity(fleet_boosts.len());
    for &(mod_id, charge_id) in fleet_boosts {
        let mut e = ctx.entity(mod_id, required_skills_of(&ctx.attrs, mod_id));
        if charge_id > 0 {
            if let Some(charge_attrs) = ctx.attrs.get(&charge_id) {
                e.attrs.extend(charge_attrs.iter().copied());
            }
        }
        gang_modules.push(e);
    }

    let mut resolved = resolve(
        &FitInput {
            ship,
            modules,
            skills,
            drones,
            charges,
            gang_modules,
        },
        &ctx.effect_meta,
        &|a| ctx.is_stackable(a),
        &|a| ctx.default_of(a),
    );

    // Projected effects (#178): webs/paints/… modify this ship's attributes.
    let projected: Vec<ProjectedInput> = fit
        .projected
        .iter()
        .map(|p| {
            let a: HashMap<i64, f64> = ctx
                .attrs
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
        resolved_feasibility(&resolved, base_layout, &ctx.effects, fit, &|tid| {
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
            ctx.effects.get(tid).is_some_and(|eids| {
                eids.iter().any(|eid| {
                    ctx.effect_meta
                        .get(eid)
                        .is_some_and(|m| m.duration_attribute_id.is_some())
                })
            })
        })
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();

    // Active (deployed) drones: bandwidth + the 5-in-space limit are a shared
    // pool across every drone type in the bay, granted greedily in fit order.
    let drone_active_counts = resolve_active_drones(
        &drone_items,
        &resolved.drones,
        resolved.ship.get(attr::DRONE_BANDWIDTH),
    );
    let drone_active_full: Vec<Option<i32>> = {
        let mut counts = drone_active_counts.iter().copied();
        fit.items
            .iter()
            .map(|it| {
                if it.slot == SlotKind::Drone {
                    counts.next()
                } else {
                    None
                }
            })
            .collect()
    };
    let drone_max_active_counts = max_active_drones(
        &drone_items,
        &resolved.drones,
        resolved.ship.get(attr::DRONE_BANDWIDTH),
    );
    let drone_max_active_full: Vec<Option<i32>> = {
        let mut counts = drone_max_active_counts.iter().copied();
        fit.items
            .iter()
            .map(|it| {
                if it.slot == SlotKind::Drone {
                    counts.next()
                } else {
                    None
                }
            })
            .collect()
    };

    let weapon_ranges = weapon_ranges_of(&resolved, &module_items);
    let (applied_dps, dps_range_curve) = if let Some(target) = target_profile {
        let applied = applied_dps_of(
            &resolved,
            &module_items,
            &drone_items,
            &drone_active_counts,
            target,
            &weapon_ranges,
        );
        let curve = dps_range_curve_of(
            &resolved,
            &module_items,
            &drone_items,
            &drone_active_counts,
            target,
            &weapon_ranges,
        );
        (Some(applied), curve)
    } else {
        (None, Vec::new())
    };

    Ok(DogmaStats {
        resources,
        validation,
        layout,
        activatable_types,
        capacitor: capacitor_of(&resolved, &module_items, neut_gjs),
        tank: tank_of(&resolved, &module_items, damage_profile),
        dps: dps_of(&resolved, &module_items, &drone_items, &drone_active_counts),
        weapon_ranges,
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
        drone_active: drone_active_full,
        drone_max_active: drone_max_active_full,
        applied_dps,
        dps_range_curve,
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
        group_name: base_layout.group_name.clone(),
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

/// How many of each fitted drone stack are actually active (deployed), given
/// the ship's resolved drone bandwidth and the 5-in-space limit (assumed at
/// Drones V, consistent with the app's all-V-by-default skill basis). Both
/// are a *shared pool* across every drone type in the bay — granted greedily
/// in fit order from each item's request (`active_drones`, defaulting to its
/// full `quantity` when unset). The rest sit in the bay contributing nothing.
/// Parallel to `drone_items`/`drones` (the drones' resolved attribute stores).
pub(super) fn resolve_active_drones(
    drone_items: &[&FitItem],
    drones: &[AttrStore],
    ship_bandwidth: f64,
) -> Vec<i32> {
    let mut remaining_bandwidth = ship_bandwidth.max(0.0);
    let mut remaining_slots = MAX_ACTIVE_DRONES;
    drone_items
        .iter()
        .zip(drones)
        .map(|(item, store)| {
            let per_unit = store.get(attr::DRONE_BANDWIDTH_USED);
            let requested = item
                .active_drones
                .unwrap_or(item.quantity)
                .clamp(0, item.quantity.max(0));
            let by_bandwidth = if per_unit > 0.0 {
                (remaining_bandwidth / per_unit).floor() as i32
            } else {
                requested
            };
            let granted = requested.min(by_bandwidth).min(remaining_slots).max(0);
            remaining_bandwidth -= granted as f64 * per_unit;
            remaining_slots -= granted;
            granted
        })
        .collect()
}

/// How many of each fitted drone stack *could ever* be active on this hull —
/// the display cap for the stars (#712 follow-up). Computed independently per
/// stack (as if it alone had the ship's full bandwidth budget), not the
/// shared-pool allocation `resolve_active_drones` grants: some hulls can only
/// support 2 of a bandwidth-hungry drone type even though the 5-in-space
/// limit would otherwise allow more. Parallel to `drone_items`/`drones`.
pub(super) fn max_active_drones(
    drone_items: &[&FitItem],
    drones: &[AttrStore],
    ship_bandwidth: f64,
) -> Vec<i32> {
    let ship_bandwidth = ship_bandwidth.max(0.0);
    drone_items
        .iter()
        .zip(drones)
        .map(|(item, store)| {
            let per_unit = store.get(attr::DRONE_BANDWIDTH_USED);
            let by_bandwidth = if per_unit > 0.0 {
                (ship_bandwidth / per_unit).floor() as i32
            } else {
                item.quantity
            };
            by_bandwidth
                .min(MAX_ACTIVE_DRONES)
                .min(item.quantity)
                .max(0)
        })
        .collect()
}

/// DPS from a resolved fit (#174, #176). Turrets read finalized `damageMultiplier`
/// (64) + `speed` (51) and the loaded charge's base damage; **missiles** ride on
/// the *resolved* charge, so missile-damage skills and ship role bonuses (applied
/// to the charge in pass 4) count; **drones** read their resolved store, so drone
/// skills + drone-damage bonuses count, scaled by `drone_active` (#712) rather
/// than raw fitted quantity. `drone_items`/`drone_active` are parallel to
/// `resolved.drones`; `resolved.charges` is parallel to `resolved.modules`.
pub(super) fn dps_of(
    resolved: &ResolvedFit,
    module_items: &[&FitItem],
    drone_items: &[&FitItem],
    drone_active: &[i32],
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
        .zip(drone_active)
        .map(|((_, store), &active)| Weapon {
            damage_mult: store.get(64),
            damage_per_shot: resolved_damage(store),
            rof_seconds: store.get(51) / 1000.0,
            count: active.max(0),
        })
        .collect();

    damage(&turrets, &missiles, &drones)
}

/// Shared applied-DPS math for one distance: turret/missile hit-quality
/// (#701) folded onto the paper per-weapon DPS, mirroring [`dps_of`]'s
/// iteration but scaling each weapon by its `application` factor at
/// `distance`. `weapon_ranges` gates missiles beyond their flight range.
#[allow(clippy::too_many_arguments)] // mirrors run_dogma's inputs at one distance
fn applied_dps_at(
    resolved: &ResolvedFit,
    module_items: &[&FitItem],
    drone_items: &[&FitItem],
    drone_active: &[i32],
    target_sig: f64,
    target_speed: f64,
    distance: f64,
    weapon_ranges: &[WeaponRange],
) -> DpsBreakdown {
    let mut turret_dps = 0.0;
    let mut missile_dps = 0.0;
    for (i, store) in resolved.modules.iter().enumerate() {
        if module_items
            .get(i)
            .is_some_and(|it| it.state != ModuleState::Active)
        {
            continue; // only active weapons fire
        }
        let Some(Some(charge)) = resolved.charges.get(i) else {
            continue;
        };
        let damage_per_shot = resolved_damage(charge);
        let rof_seconds = store.get(51) / 1000.0;
        if rof_seconds <= 0.0 {
            continue;
        }
        let mult = store.get(64);
        if mult > 0.0 {
            let optimal = store.get(54);
            let falloff = store.get(158);
            let tracking_speed = store.get(160);
            let sig_resolution = {
                let sr = store.get(105);
                if sr > 0.0 {
                    sr
                } else {
                    40.0
                }
            };
            let app = turret_application(
                optimal,
                falloff,
                tracking_speed,
                sig_resolution,
                target_speed,
                target_sig,
                distance,
            );
            turret_dps += mult * damage_per_shot / rof_seconds * app;
        } else {
            let explosion_radius = charge.get(103);
            if explosion_radius <= 0.0 {
                continue; // not a missile weapon
            }
            let explosion_velocity = charge.get(104);
            let mut app = missile_application(
                explosion_radius,
                explosion_velocity,
                target_sig,
                target_speed,
            );
            let item = module_items.get(i);
            let in_range = item.is_none_or(|it| {
                weapon_ranges
                    .iter()
                    .find(|wr| wr.type_id == it.type_id && wr.charge_type_id == it.charge_type_id)
                    .is_none_or(|wr| distance <= wr.optimal)
            });
            if !in_range {
                app = 0.0;
            }
            missile_dps += damage_per_shot / rof_seconds * app;
        }
    }

    let mut drone_dps = 0.0;
    for ((_, store), &active) in drone_items.iter().zip(&resolved.drones).zip(drone_active) {
        let count = active.max(0);
        if count == 0 {
            continue;
        }
        let damage_per_shot = resolved_damage(store);
        let rof_seconds = store.get(51) / 1000.0;
        if rof_seconds <= 0.0 {
            continue;
        }
        let mult = store.get(64);
        let tracking_speed = store.get(160);
        let sig_resolution = {
            let sr = store.get(105);
            if sr > 0.0 {
                sr
            } else {
                40.0
            }
        };
        // Drones are always within optimal of their orbited target in normal
        // use, so the falloff term is forced to zero — pass the tracking
        // distance as both `optimal` and `distance` so `turret_application`
        // only picks up the tracking penalty.
        let tracking_distance = store.get(54).max(1000.0);
        let app = turret_application(
            tracking_distance,
            0.0,
            tracking_speed,
            sig_resolution,
            target_speed,
            target_sig,
            tracking_distance,
        );
        drone_dps += mult * damage_per_shot * count as f64 / rof_seconds * app;
    }

    DpsBreakdown {
        turret: turret_dps,
        missile: missile_dps,
        drone: drone_dps,
        total: turret_dps + missile_dps + drone_dps,
    }
}

/// Applied DPS against a target profile (#701): same weapon set as
/// [`dps_of`], each scaled by its hit-quality `application` factor at
/// `target.distance`.
pub(super) fn applied_dps_of(
    resolved: &ResolvedFit,
    module_items: &[&FitItem],
    drone_items: &[&FitItem],
    drone_active: &[i32],
    target: &TargetProfile,
    weapon_ranges: &[WeaponRange],
) -> DpsBreakdown {
    applied_dps_at(
        resolved,
        module_items,
        drone_items,
        drone_active,
        target.sig_radius,
        target.speed,
        target.distance,
        weapon_ranges,
    )
}

/// DPS-over-range curve (#701): 30 linearly spaced `(distance_m,
/// total_applied_dps)` samples from 0 to the fit's maximum effective range
/// (the largest turret optimal+3×falloff or missile flight range, capped at
/// 1000km). Empty when the fit has no ranged weapon.
pub(super) fn dps_range_curve_of(
    resolved: &ResolvedFit,
    module_items: &[&FitItem],
    drone_items: &[&FitItem],
    drone_active: &[i32],
    target: &TargetProfile,
    weapon_ranges: &[WeaponRange],
) -> Vec<(f64, f64)> {
    const SAMPLES: usize = 30;
    const MAX_RANGE_CAP: f64 = 1_000_000.0;

    let max_range = weapon_ranges
        .iter()
        .map(|wr| wr.optimal + 3.0 * wr.falloff)
        .fold(0.0_f64, f64::max)
        .min(MAX_RANGE_CAP);
    if max_range <= 0.0 {
        return Vec::new();
    }

    (0..SAMPLES)
        .map(|i| {
            let distance = max_range * i as f64 / (SAMPLES - 1) as f64;
            let dps = applied_dps_at(
                resolved,
                module_items,
                drone_items,
                drone_active,
                target.sig_radius,
                target.speed,
                distance,
                weapon_ranges,
            )
            .total;
            (distance, dps)
        })
        .collect()
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
/// toggling is a UI follow-up. `neut_gjs` adds projected neut pressure (#706)
/// on top of the module drain.
pub(super) fn capacitor_of(
    resolved: &ResolvedFit,
    module_items: &[&FitItem],
    neut_gjs: f64,
) -> CapStats {
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
        neut_gjs,
    )
}

/// Tank from a resolved fit (#173): HP + resonances from the ship, local rep/s
/// from shield boosters (shieldBonus 68) and armor repairers (armorDamageAmount
/// 84). `profile` weighs the resonances (#702); callers default to even
/// 25/25/25/25 when none is specified.
pub(super) fn tank_of(
    resolved: &ResolvedFit,
    module_items: &[&FitItem],
    profile: &DamageProfile,
) -> TankStats {
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

    let mut t = tank(shield, armor, hull, profile, shield_rep_s, armor_rep_s);
    t.passive_shield_s = passive_shield_s;
    t
}

pub(super) type AttrMap = HashMap<i64, Vec<(i64, f64)>>;

pub(super) type EffectMap = HashMap<i64, Vec<i64>>;

pub(super) type GroupMap = HashMap<i64, i64>;

/// Whether an item draws CPU / powergrid / calibration: only fitted ship
/// modules do. Cargo, implants and boosters are carried rather than fitted,
/// and an offline module holds its slot without drawing anything. Mirrors the
/// dogma path's treatment so the base-attribute fallback agrees with it. Pure.
pub(super) fn draws_fitting_resources(slot: SlotKind, state: ModuleState) -> bool {
    is_ship_module(slot) && state != ModuleState::Offline
}

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

/// Core simulation shared by `fitting_simulate` and the PVP fit analysis: given
/// an open SDE, a fit and a skill-level lookup, resolve the dogma engine and
/// assemble [`FitStats`]. Kept engine-identical so both surfaces agree.
/// `fleet_boosts` (#705) is `[module_type_id, charge_type_id]` pairs (`-1` for
/// no charge) of command-burst/fleet-link modules the fit is "receiving".
pub(crate) fn simulate_fit(
    sde: &Sde,
    fit: &Fit,
    skill_level_for: &dyn Fn(i64) -> f64,
    damage_profile: Option<[f64; 4]>,
    neut_gjs: Option<f64>,
    target_profile: Option<TargetProfile>,
    fleet_boosts: Option<Vec<[i64; 2]>>,
) -> Result<FitStats, String> {
    let Some(ship) = sde
        .ship_layout(fit.ship_type_id)
        .map_err(|e| e.to_string())?
    else {
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
        let fitted = draws_fitting_resources(item.slot, item.state);
        val_items.push(ValItem {
            slot: item.slot,
            cpu: if fitted { get(50) } else { 0.0 }, // cpu usage
            powergrid: if fitted { get(30) } else { 0.0 }, // power usage
            calibration: if fitted { get(1153) } else { 0.0 }, // rig calibration
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
    let profile = damage_profile.map(DamageProfile).unwrap_or_default();
    let neut = neut_gjs.unwrap_or(0.0);
    let boosts: Vec<(i64, i64)> = fleet_boosts
        .unwrap_or_default()
        .into_iter()
        .map(|[m, c]| (m, c))
        .collect();
    let dogma = run_dogma(
        sde,
        fit,
        &ship,
        skill_level_for,
        &profile,
        neut,
        target_profile.as_ref(),
        &boosts,
    )
    .ok();

    // Classify any EW projected onto the fit (#265) — presence only.
    let projected_ew = classify_projected_ew(sde, fit);

    Ok(FitStats {
        resources: dogma
            .as_ref()
            .map(|d| d.resources.clone())
            .unwrap_or(base_resources),
        validation: dogma
            .as_ref()
            .map(|d| d.validation.clone())
            .unwrap_or(base_validation),
        capacitor: dogma.as_ref().map(|d| d.capacitor.clone()),
        tank: dogma.as_ref().map(|d| d.tank.clone()),
        dps: dogma.as_ref().map(|d| d.dps.clone()),
        navigation: dogma.as_ref().map(|d| d.navigation.clone()),
        layout: dogma.as_ref().map(|d| d.layout.clone()),
        weapon_ranges: dogma
            .as_ref()
            .map(|d| d.weapon_ranges.clone())
            .unwrap_or_default(),
        activatable_types: dogma
            .as_ref()
            .map(|d| d.activatable_types.clone())
            .unwrap_or_default(),
        targeting: dogma.as_ref().map(|d| d.targeting.clone()),
        price: None,
        projected_ew,
        drone_active: dogma
            .as_ref()
            .map(|d| d.drone_active.clone())
            .unwrap_or_default(),
        drone_max_active: dogma
            .as_ref()
            .map(|d| d.drone_max_active.clone())
            .unwrap_or_default(),
        applied_dps: dogma.as_ref().and_then(|d| d.applied_dps.clone()),
        dps_range_curve: dogma
            .as_ref()
            .map(|d| d.dps_range_curve.clone())
            .unwrap_or_default(),
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
    let order = [
        "web",
        "paint",
        "damp",
        "weaponDisruption",
        "ecm",
        "neut",
        "nos",
    ];
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
        65 | 1672 => Some("web"),        // Stasis Web / Stasis Grappler
        379 => Some("paint"),            // Target Painter
        208 => Some("damp"),             // Sensor Dampener
        291 => Some("weaponDisruption"), // Weapon Disruptor (tracking/guidance)
        201 | 80 => Some("ecm"),         // ECM / Burst Jammer
        71 => Some("neut"),              // Energy Neutralizer
        68 => Some("nos"),               // Energy Nosferatu
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_fitted_modules_draw_cpu_pg_calibration() {
        // Fitted module slots draw resources …
        for slot in [
            SlotKind::High,
            SlotKind::Mid,
            SlotKind::Low,
            SlotKind::Rig,
            SlotKind::Subsystem,
        ] {
            assert!(
                draws_fitting_resources(slot, ModuleState::Active),
                "{slot:?}"
            );
        }
        // … carried items never do, whatever state they carry …
        for slot in [
            SlotKind::Cargo,
            SlotKind::Implant,
            SlotKind::Booster,
            SlotKind::Drone,
        ] {
            assert!(
                !draws_fitting_resources(slot, ModuleState::Active),
                "{slot:?}"
            );
        }
        // … and an offline module holds its slot without drawing anything.
        assert!(!draws_fitting_resources(
            SlotKind::High,
            ModuleState::Offline
        ));
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

    fn store(attrs: &[(i64, f64)]) -> AttrStore {
        let mut s = AttrStore::new();
        for &(id, v) in attrs {
            s.set_base(id, v);
        }
        s
    }

    fn item(type_id: i64, charge: Option<i64>, state: ModuleState, qty: i32) -> FitItem {
        FitItem {
            type_id,
            slot: SlotKind::High,
            index: 0,
            state,
            charge_type_id: charge,
            quantity: qty,
            active_drones: None,
        }
    }

    fn resolved_fit(
        modules: Vec<AttrStore>,
        charges: Vec<Option<AttrStore>>,
        drones: Vec<AttrStore>,
    ) -> ResolvedFit {
        ResolvedFit {
            ship: AttrStore::new(),
            modules,
            drones,
            charges,
            unresolved: 0,
        }
    }

    /// Offline/online modules never fire; an otherwise-identical active one
    /// does. An active turret with no charge loaded is excluded entirely —
    /// unlike `optimizer::damage_score`, which deliberately counts an unloaded
    /// turret as a unit shot so the optimizer can rank/fit unammoed weapons.
    /// Don't "fix" one to match the other: `dps_of` feeds the stats panel
    /// (real DPS), `damage_score` feeds the search objective (potential DPS).
    #[test]
    fn dps_of_module_state_and_charge_gating() {
        let turret = store(&[(64, 5.0), (51, 2000.0)]); // mult 5, 2s RoF
        let charge = store(&[(114, 25.0), (116, 25.0), (117, 25.0), (118, 25.0)]); // 100 dmg

        let resolved = resolved_fit(
            vec![
                turret.clone(),
                turret.clone(),
                turret.clone(),
                turret.clone(),
            ],
            vec![
                Some(charge.clone()), // offline: contributes 0
                Some(charge.clone()), // online: contributes 0
                Some(charge.clone()), // active: contributes damage
                None,                 // active but unloaded: excluded
            ],
            vec![store(&[
                (64, 2.0),
                (51, 1000.0),
                (114, 10.0),
                (116, 10.0),
                (117, 10.0),
                (118, 10.0),
            ])], // drone: mult 2, 1s RoF, 40 dmg/shot
        );
        let items = [
            item(100, Some(200), ModuleState::Offline, 1),
            item(100, Some(200), ModuleState::Online, 1),
            item(100, Some(200), ModuleState::Active, 1),
            item(100, None, ModuleState::Active, 1),
        ];
        let module_items: Vec<&FitItem> = items.iter().collect();
        // Drone state is irrelevant to dps_of — only the resolved active count
        // (computed upstream by resolve_active_drones) scales it.
        let drone_item = item(300, None, ModuleState::Offline, 3);
        let drone_items = vec![&drone_item];

        let dps = dps_of(&resolved, &module_items, &drone_items, &[3]);
        assert_eq!(dps.turret, 100.0 * 5.0 / 2.0); // only the active module counts
        assert_eq!(dps.missile, 0.0);
        assert_eq!(dps.drone, 2.0 * 40.0 * 3.0 / 1.0); // scaled by quantity, regardless of state
        assert_eq!(dps.total, dps.turret + dps.drone);
    }

    /// A turret-armed fit against a far/small/fast target profile applies
    /// less DPS than the paper (full-application) figure — falloff and
    /// tracking both bite (#701).
    #[test]
    fn applied_dps_of_reduces_paper_dps_against_a_far_target() {
        let turret = store(&[
            (64, 5.0),      // damage multiplier
            (51, 2000.0),   // 2s RoF
            (54, 10_000.0), // optimal
            (158, 5_000.0), // falloff
            (160, 40.0),    // tracking speed
            (105, 40.0),    // sig resolution
        ]);
        let charge = store(&[(114, 25.0), (116, 25.0), (117, 25.0), (118, 25.0)]); // 100 dmg

        let resolved = resolved_fit(vec![turret], vec![Some(charge)], Vec::new());
        let it = item(100, Some(200), ModuleState::Active, 1);
        let module_items: Vec<&FitItem> = vec![&it];

        let target = TargetProfile {
            sig_radius: 40.0, // small, fast frigate — hard to track
            speed: 400.0,
            distance: 40_000.0, // well beyond optimal + falloff
        };

        let paper = dps_of(&resolved, &module_items, &[], &[]);
        let applied = applied_dps_of(&resolved, &module_items, &[], &[], &target, &[]);
        assert!(
            applied.turret < paper.turret,
            "applied {} should be below paper {}",
            applied.turret,
            paper.turret
        );
        assert!(applied.turret > 0.0, "some rounds should still land");
        assert_eq!(applied.total, applied.turret);
    }

    fn drone_item(type_id: i64, qty: i32, active: Option<i32>) -> FitItem {
        FitItem {
            type_id,
            slot: SlotKind::Drone,
            index: 0,
            state: ModuleState::Active,
            charge_type_id: None,
            quantity: qty,
            active_drones: active,
        }
    }
    fn drone_store(bandwidth_used: f64) -> AttrStore {
        store(&[(attr::DRONE_BANDWIDTH_USED, bandwidth_used)])
    }

    #[test]
    fn resolve_active_drones_defaults_to_full_quantity_within_budget() {
        let d = drone_item(300, 3, None);
        let drones = vec![&d];
        let stores = vec![drone_store(10.0)];
        assert_eq!(resolve_active_drones(&drones, &stores, 50.0), vec![3]);
    }

    #[test]
    fn resolve_active_drones_caps_by_bandwidth() {
        let d = drone_item(300, 10, None);
        let drones = vec![&d];
        let stores = vec![drone_store(25.0)];
        // floor(75 / 25) = 3, well under the fitted quantity of 10.
        assert_eq!(resolve_active_drones(&drones, &stores, 75.0), vec![3]);
    }

    #[test]
    fn resolve_active_drones_caps_by_five_in_space_limit() {
        let d = drone_item(300, 10, None);
        let drones = vec![&d];
        let stores = vec![drone_store(1.0)]; // bandwidth is not the binding constraint
        assert_eq!(resolve_active_drones(&drones, &stores, 1000.0), vec![5]);
    }

    #[test]
    fn resolve_active_drones_shares_bandwidth_across_types_in_fit_order() {
        // Two stacks of 3, each at 20 Mbit/drone; ship has 100 Mbit. The first
        // stack (fit order) takes its full request (3x20=60), leaving 40 -> 2
        // for the second — bandwidth is a shared pool, not per-type.
        let a = drone_item(300, 3, None);
        let b = drone_item(400, 3, None);
        let items = vec![&a, &b];
        let stores = vec![drone_store(20.0), drone_store(20.0)];
        assert_eq!(resolve_active_drones(&items, &stores, 100.0), vec![3, 2]);
    }

    #[test]
    fn resolve_active_drones_honors_a_lower_request_and_clamps_an_overshoot() {
        let low_request = drone_item(300, 5, Some(1)); // user deactivated down to 1
        let over_request = drone_item(400, 3, Some(99)); // clamps to its own quantity
        let items = vec![&low_request, &over_request];
        let stores = vec![drone_store(5.0), drone_store(5.0)];
        assert_eq!(resolve_active_drones(&items, &stores, 1000.0), vec![1, 3]);
    }

    #[test]
    fn max_active_drones_caps_by_bandwidth_regardless_of_other_stacks() {
        // A hull with only 10 Mbit of drone bandwidth can fly at most 2 of a
        // 5 Mbit/unit drone, even if 5 are fitted and the 5-in-space limit
        // would otherwise allow more.
        let d = drone_item(300, 5, None);
        let drones = vec![&d];
        let stores = vec![drone_store(5.0)];
        assert_eq!(max_active_drones(&drones, &stores, 10.0), vec![2]);
    }

    #[test]
    fn max_active_drones_caps_at_five_and_at_fitted_quantity() {
        let plenty_bandwidth = drone_item(300, 10, None);
        let scarce_fit = drone_item(400, 1, None);
        let items = vec![&plenty_bandwidth, &scarce_fit];
        let stores = vec![drone_store(1.0), drone_store(1.0)];
        // Ample bandwidth for both: the first caps at the 5-in-space limit
        // (fitted 10 > 5); the second caps at its own fitted quantity (1).
        assert_eq!(max_active_drones(&items, &stores, 1000.0), vec![5, 1]);
    }

    #[test]
    fn max_active_drones_is_independent_per_stack_unlike_the_shared_pool() {
        // Unlike resolve_active_drones, each stack's max is computed as if it
        // alone had the full bandwidth budget — this is a display cap, not a
        // joint allocation, so it does not shrink as other stacks are fitted.
        let a = drone_item(300, 5, None);
        let b = drone_item(400, 5, None);
        let items = vec![&a, &b];
        let stores = vec![drone_store(10.0), drone_store(10.0)];
        assert_eq!(max_active_drones(&items, &stores, 20.0), vec![2, 2]);
    }

    /// Turret range from maxRange(54)/falloff(158); a launcher with no
    /// maxRange falls back to the loaded missile's velocity(37) ×
    /// flightTime(281)/1000; identical (type, charge) pairs dedupe; Offline
    /// is skipped but Online still yields a range entry.
    #[test]
    fn weapon_ranges_of_dedup_fallback_and_state_gating() {
        let turret = store(&[(54, 5000.0), (158, 2000.0)]);
        let launcher = store(&[(54, 0.0), (158, 0.0)]);
        let missile = store(&[(37, 250.0), (281, 8000.0)]); // 250 m/s * 8s = 2000m
        let offline_turret = store(&[(54, 9999.0), (158, 0.0)]);
        let online_turret = store(&[(54, 3000.0), (158, 1000.0)]);

        let resolved = resolved_fit(
            vec![
                turret.clone(), // 0: active turret
                turret,         // 1: identical -> dedupes with 0
                launcher,       // 2: launcher, falls back to missile flight range
                offline_turret, // 3: offline -> skipped
                online_turret,  // 4: online -> still yields a range
            ],
            vec![None, None, Some(missile), None, None],
            Vec::new(),
        );
        let items = [
            item(100, Some(200), ModuleState::Active, 1),
            item(100, Some(200), ModuleState::Active, 1), // same (type, charge) as 0
            item(300, Some(400), ModuleState::Active, 1),
            item(500, None, ModuleState::Offline, 1),
            item(600, None, ModuleState::Online, 1),
        ];
        let module_items: Vec<&FitItem> = items.iter().collect();

        let ranges = weapon_ranges_of(&resolved, &module_items);
        assert_eq!(
            ranges,
            vec![
                WeaponRange {
                    type_id: 100,
                    charge_type_id: Some(200),
                    optimal: 5000.0,
                    falloff: 2000.0,
                },
                WeaponRange {
                    type_id: 300,
                    charge_type_id: Some(400),
                    optimal: 2000.0,
                    falloff: 0.0,
                },
                WeaponRange {
                    type_id: 600,
                    charge_type_id: None,
                    optimal: 3000.0,
                    falloff: 1000.0,
                },
            ]
        );
    }

    /// No capacitorNeed(6), or a zero duration, means no drain. Duration
    /// falls back to speed(51) for weapons lacking an explicit duration(73).
    /// A non-Active module never drains capacitor.
    #[test]
    fn capacitor_of_need_duration_and_state_gating() {
        let no_need = store(&[(73, 5000.0)]); // no attr 6 at all
        let zero_duration = store(&[(6, 10.0), (73, 0.0), (51, 0.0)]);
        let weapon_fallback = store(&[(6, 20.0), (51, 4000.0)]); // no 73 -> falls back to speed
        let online_module = store(&[(6, 100.0), (73, 1000.0)]);

        let resolved = resolved_fit(
            vec![no_need, zero_duration, weapon_fallback, online_module],
            vec![None, None, None, None],
            Vec::new(),
        );
        let items = [
            item(100, None, ModuleState::Active, 1),
            item(200, None, ModuleState::Active, 1),
            item(300, None, ModuleState::Active, 1),
            item(400, None, ModuleState::Online, 1),
        ];
        let module_items: Vec<&FitItem> = items.iter().collect();

        let cap = capacitor_of(&resolved, &module_items, 0.0);
        assert_eq!(cap.drain, 20.0 / (4000.0 / 1000.0));
    }

    /// A different damage profile weighs the same resonances differently
    /// (#702): a shield-tanked ship with an em hole (poor em resist, strong
    /// resist elsewhere) shows lower EHP against an em-heavy profile than an
    /// even 25/25/25/25 split.
    #[test]
    fn tank_of_ehp_varies_with_damage_profile() {
        let mut ship = AttrStore::new();
        ship.set_base(263, 1000.0); // shield HP
                                    // [em, thermal, kinetic, explosive] resonances: weak to em (0.75 = 25%
                                    // resist), hardened everywhere else (0.25 = 75% resist).
        ship.set_base(271, 0.75); // em
        ship.set_base(274, 0.25); // thermal
        ship.set_base(273, 0.25); // kinetic
        ship.set_base(272, 0.25); // explosive
        let resolved = ResolvedFit {
            ship,
            modules: Vec::new(),
            drones: Vec::new(),
            charges: Vec::new(),
            unresolved: 0,
        };

        let em_heavy = tank_of(&resolved, &[], &DamageProfile([1.0, 0.0, 0.0, 0.0]));
        let even = tank_of(&resolved, &[], &DamageProfile::default());
        assert!(
            em_heavy.ehp < even.ehp,
            "em-heavy EHP {} should be lower than even-profile EHP {} against an em hole",
            em_heavy.ehp,
            even.ehp
        );
    }

    /// Projected neut pressure (#706) shortens the discrete depletion sim vs
    /// no neut, mirroring the engine-level capacitor tests but through the
    /// stats-layer entry point.
    #[test]
    fn capacitor_of_neut_pressure_shortens_depletion() {
        let mut ship = AttrStore::new();
        ship.set_base(482, 250.0); // capacitorCapacity
        ship.set_base(55, 125_000.0); // rechargeRate (ms)
        let module = store(&[(6, 8.0), (73, 1000.0)]); // 8 GJ/s, well above the 5 GJ/s peak
        let resolved = ResolvedFit {
            ship,
            modules: vec![module],
            drones: Vec::new(),
            charges: vec![None],
            unresolved: 0,
        };
        let items = [item(100, None, ModuleState::Active, 1)];
        let module_items: Vec<&FitItem> = items.iter().collect();

        let no_neut = capacitor_of(&resolved, &module_items, 0.0);
        let with_neut = capacitor_of(&resolved, &module_items, 3.0);
        let t_no_neut = no_neut.depletion_seconds.expect("unstable without neut");
        let t_with_neut = with_neut.depletion_seconds.expect("unstable with neut");
        assert!(
            t_with_neut < t_no_neut,
            "with-neut depletion {t_with_neut} should be < no-neut {t_no_neut}"
        );
    }
}
