//! Fitting optimizer: rework a fit's objective-relevant slots for the best
//! build via greedy seed + local search, scored through the dogma layer.
//! Split out of commands.rs (#331).

use std::collections::HashMap;

use tauri::{AppHandle, State};

use super::context::DogmaContext;
use super::engine::resolve::{resolve, EntityInput, FitInput, ResolvedFit};
use super::stats::{
    base_damage, capacitor_of, is_ship_module, required_skills_of, resolved_feasibility, tank_of,
    AttrMap, EffectMap, GroupMap,
};
use super::types::{Fit, FitItem, ModuleState, Severity, SlotKind};
use crate::market::{default_region_id, resolve_location, MarketService};
use crate::sde::{Sde, ShipLayout};

/// Damage-objective score for the optimizer. Like DPS, but a turret with **no
/// charge loaded** still contributes `mult / RoF` (a unit shot), so optimizing
/// for damage works even when the fit's weapons aren't ammoed — it ranks by
/// weapon damage *potential*, which is monotonic with real DPS for fixed ammo.
/// (`dps_of` keeps showing 0 for unarmed weapons in the stats panel.)
pub(super) fn damage_score(
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

/// What to maximize when filling empty slots.
#[derive(Clone, Copy, PartialEq)]
pub(super) enum Objective {
    Tank,
    Damage,
    Repair,
    Yield,
}

pub(super) fn parse_objective(s: &str) -> Result<Objective, String> {
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
pub(super) fn opt_config(obj: Objective) -> Vec<(SlotKind, Vec<i64>)> {
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
pub(super) const UNIQUE_GROUPS: &[i64] = &[60]; // Damage Control

pub(super) fn slot_capacity(layout: &ShipLayout, slot: SlotKind) -> i64 {
    match slot {
        SlotKind::High => layout.high_slots,
        SlotKind::Mid => layout.mid_slots,
        SlotKind::Low => layout.low_slots,
        SlotKind::Rig => layout.rig_slots,
        SlotKind::Subsystem => layout.subsystem_slots,
        _ => 0,
    }
}

/// A freshly-added optimizer module (active, no charge).
pub(super) fn new_module(type_id: i64, slot: SlotKind, index: i32) -> FitItem {
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
pub(super) fn add_weapons(fit: &mut Fit, tid: i64, count: i64) {
    let start = fit
        .items
        .iter()
        .filter(|i| i.slot == SlotKind::High)
        .count() as i32;
    for k in 0..count {
        fit.items
            .push(new_module(tid, SlotKind::High, start + k as i32));
    }
}

/// The weapon group ids and weapon skill ids a hull is *bonused* for, read from
/// its own effects' `modifierInfo` (domain `shipID`) that touch a weapon-level
/// attribute — rate of fire (51) or turret damage multiplier (64). A ship that
/// bonuses energy turrets keys off skill 3306 (Medium Energy Turret); one that
/// bonuses rockets keys off groups 771/510/511; etc. Used to steer the damage
/// optimizer toward the weapons the hull is actually built for, instead of
/// whatever has the highest raw paper-DPS (e.g. blasters on a laser boat).
/// Empty sets ⇒ no weapon bonus found ⇒ don't restrict.
pub(super) fn ship_weapon_bonus(
    ship_type_id: i64,
    effects: &EffectMap,
    effect_meta: &HashMap<i64, crate::sde::EffectMeta>,
) -> (Vec<i64>, Vec<i64>) {
    const WEAPON_ATTRS: [i64; 2] = [51, 64]; // rate of fire, damageMultiplier
    let mut groups = Vec::new();
    let mut skills = Vec::new();
    for eid in effects.get(&ship_type_id).into_iter().flatten() {
        let Some(meta) = effect_meta.get(eid) else {
            continue;
        };
        for m in &meta.modifiers {
            // Only the ship bonusing its own fitted weapons (skip drone/owner bonuses).
            if m.domain.as_deref() != Some("shipID") {
                continue;
            }
            if !m
                .modified_attribute_id
                .is_some_and(|a| WEAPON_ATTRS.contains(&a))
            {
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

pub(super) fn entity_from_maps(
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
pub(super) fn mining_yield(resolved: &ResolvedFit) -> f64 {
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
pub(super) struct Constraints {
    /// Require the fit to be capacitor-stable.
    pub(super) cap_stable: bool,
    /// Cap total fit ISK cost (hull + modules + charges + drones).
    pub(super) max_cost: Option<f64>,
}

/// One trial fit's objective metric plus the inputs the constraints test.
pub(super) struct Eval {
    pub(super) objective: f64,
    pub(super) cap_stable: bool,
    pub(super) cost: f64,
}

/// Penalty factor applied to a trial's objective for each violated soft constraint.
/// Multiplicative, so it's scale-invariant across objectives (EHP, DPS, yield differ
/// by orders of magnitude): a violation makes the trial worse without forbidding it,
/// so the search can pass through a temporarily cap-unstable state (e.g. add a prop
/// mod, then a cap battery) instead of being trapped by a hard reject.
pub(super) const CONSTRAINT_PENALTY: f64 = 0.4;

/// Whether an evaluated trial satisfies every active constraint.
pub(super) fn meets(e: &Eval, c: &Constraints) -> bool {
    (!c.cap_stable || e.cap_stable) && c.max_cost.is_none_or(|m| e.cost <= m + 1.0)
}

/// The comparable score the search maximizes: objective, penalized per violation.
pub(super) fn constraint_score(e: &Eval, c: &Constraints) -> f64 {
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
pub(super) fn fit_cost(fit: &Fit, prices: &HashMap<i64, f64>) -> f64 {
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
pub(super) fn evaluate(
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
    let module_items: Vec<&FitItem> = fit
        .items
        .iter()
        .filter(|i| is_ship_module(i.slot))
        .collect();
    let drone_items: Vec<&FitItem> = fit
        .items
        .iter()
        .filter(|i| i.slot == SlotKind::Drone)
        .collect();

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
            let sde = crate::sde::open_from_app(&app)?;
            let mut ids: Vec<i64> = vec![fit.ship_type_id];
            ids.extend(fit.items.iter().map(|i| i.type_id));
            ids.extend(fit.items.iter().filter_map(|i| i.charge_type_id));
            for (_, groups) in opt_config(obj) {
                for (t, _) in sde
                    .modules_in_groups(&groups, &meta)
                    .map_err(|e| e.to_string())?
                {
                    ids.push(t);
                }
            }
            if obj == Objective::Damage {
                for (t, _) in sde
                    .modules_in_groups(&[100], &meta)
                    .map_err(|e| e.to_string())?
                {
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
        let location = resolve_location(region_id.unwrap_or_else(default_region_id), station_id);
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
    let sde = crate::sde::open_from_app(&app)?;
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
pub(super) fn optimize_fit(
    sde: &Sde,
    fit: Fit,
    objective: &str,
    meta_groups: Vec<i64>,
    mode: &str,
    prices: &HashMap<i64, f64>,
    constraints: Constraints,
) -> Result<OptimizeResult, String> {
    let obj = parse_objective(objective)?;
    let Some(layout) = sde
        .ship_layout(fit.ship_type_id)
        .map_err(|e| e.to_string())?
    else {
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
        let ids: Vec<i64> = slot_candidates
            .iter()
            .flat_map(|(_, c)| c.clone())
            .collect();
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
    let mut extra_ids: Vec<i64> = vec![fit.ship_type_id];
    extra_ids.extend(fit.items.iter().map(|i| i.type_id));
    extra_ids.extend(fit.items.iter().filter_map(|i| i.charge_type_id));
    for (_, ts) in &slot_candidates {
        extra_ids.extend(ts);
    }
    let ctx = DogmaContext::load(sde, &extra_ids)?;
    let attrs = &ctx.attrs;
    let effects = &ctx.effects;
    let groups = &ctx.groups;
    let effect_meta = &ctx.effect_meta;
    let is_stackable = |a: i64| ctx.is_stackable(a);
    let default_of = |a: i64| ctx.default_of(a);

    // Steer the damage optimizer to the hull's *bonused* weapons. Without this it
    // maximizes raw paper-DPS and fits, say, hybrid blasters on an Amarr laser
    // hull. Restrict the high-slot weapon candidates to the groups/skills the ship
    // bonuses — but only per slot where that leaves at least one weapon, so a hull
    // with no turret/launcher bonus (e.g. a drone boat) still gets armed.
    if matches!(obj, Objective::Damage) {
        let (bgroups, bskills) = ship_weapon_bonus(fit.ship_type_id, effects, effect_meta);
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
                            || required_skills_of(attrs, *tid)
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

    // The optimizer doesn't have real character skills, so it scores at all-V.
    let skills: Vec<EntityInput> = ctx.skill_entities(|_| 5.0);

    let eval = |f: &Fit| {
        evaluate(
            obj,
            f,
            &layout,
            attrs,
            effects,
            groups,
            &skills,
            effect_meta,
            &is_stackable,
            &default_of,
            prices,
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
    let cands_for: HashMap<SlotKind, Vec<i64>> = slot_candidates
        .iter()
        .map(|(s, c)| (*s, c.clone()))
        .collect();
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
                - fit
                    .items
                    .iter()
                    .filter(|i| i.slot == SlotKind::High)
                    .count() as i64)
                .max(0);
            for &(effect_id, hardpoints) in &[
                (42i64, layout.turret_hardpoints),
                (40, layout.launcher_hardpoints),
            ] {
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
                                && effects
                                    .get(&i.type_id)
                                    .is_some_and(|e| e.contains(&effect_id))
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
                let drone_cands = sde
                    .modules_in_groups(&[100], &meta)
                    .map_err(|e| e.to_string())?;
                let drone_ids: Vec<i64> = drone_cands.iter().map(|(t, _)| *t).collect();
                let drone_attrs = sde
                    .types_attributes_raw(&drone_ids)
                    .map_err(|e| e.to_string())?;
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
            .flat_map(|i| {
                [604, 605, 606, 609, 610]
                    .iter()
                    .filter_map(|g| attr_of(i.type_id, *g))
            })
            .map(|v| v as i64)
            .collect();
        all_charge_groups.sort_unstable();
        all_charge_groups.dedup();
        if !all_charge_groups.is_empty() {
            let charge_cands = sde
                .modules_in_groups(&all_charge_groups, &meta)
                .map_err(|e| e.to_string())?;
            let charge_ids: Vec<i64> = charge_cands.iter().map(|(t, _)| *t).collect();
            let charge_attrs = sde
                .types_attributes_raw(&charge_ids)
                .map_err(|e| e.to_string())?;
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
