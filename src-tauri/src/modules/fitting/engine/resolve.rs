//! Fit-tree resolution: apply effects in fixed passes to produce final
//! attributes (#171).
//!
//! The fit is a tree — skills → ship → modules → charges. Resolution runs in
//! ordered passes, each only *adding* modifiers into [`AttrStore`] buckets; the
//! stores collapse on read. Modifier source values are read from the affecting
//! entity at apply time, so a self-modifier (e.g. a skill scaling its own
//! per-level bonus by `skillLevel`) must be applied before the cross-entity pass
//! that reads it — which the pass order guarantees.
//!
//! Inputs are SDE-agnostic ([`EntityInput`]) so the whole engine is unit-
//! testable without a database; the command layer populates them from the SDE.
//!
//! Wired into `fitting_simulate` by the first stat calculator (#172); the
//! module-level allow lets the resolution engine land tested-but-unwired.
#![allow(dead_code)]

use std::collections::HashMap;

use crate::sde::EffectMeta;

use super::attr::AttrStore;
use super::effects::modifiers_for;
use super::modifier::{Domain, ModifierDef};

/// One entity in the fit tree, reduced to what resolution needs.
#[derive(Debug, Clone, Default)]
pub struct EntityInput {
    /// Base attributes `(attributeID, value)` — for skills, includes `skillLevel`
    /// (280) set to the desired level.
    pub attrs: Vec<(i64, f64)>,
    /// The entity's `dgmTypeEffects` ids.
    pub effect_ids: Vec<i64>,
    /// `invGroups.groupID` (for `LocationGroupModifier` targeting).
    pub group_id: i64,
    /// `requiredSkill1` type id (for `*RequiredSkillModifier` targeting).
    pub required_skill: Option<i64>,
}

/// A whole fit reduced to resolution inputs.
#[derive(Debug, Clone, Default)]
pub struct FitInput {
    pub ship: EntityInput,
    /// Fitted modules/rigs/subsystems (drones/cargo don't affect ship stats).
    pub modules: Vec<EntityInput>,
    /// Active skills (at the chosen level, baked into `attrs[280]`).
    pub skills: Vec<EntityInput>,
}

/// Resolved attribute stores for the ship and each module (parallel to input).
#[derive(Debug, Clone)]
pub struct ResolvedFit {
    pub ship: AttrStore,
    pub modules: Vec<AttrStore>,
    /// Effect modifiers we couldn't model (coverage metric).
    pub unresolved: usize,
}

/// Resolve a fit to final attributes. `effects` is the SDE effect catalogue
/// (`effect_meta`); `is_stackable(attr)` comes from `dgmAttributeTypes`.
pub fn resolve(
    input: &FitInput,
    effects: &HashMap<i64, EffectMeta>,
    is_stackable: &impl Fn(i64) -> bool,
) -> ResolvedFit {
    let mut ship = seed(&input.ship);
    let mut modules: Vec<AttrStore> = input.modules.iter().map(seed).collect();
    let mut skills: Vec<AttrStore> = input.skills.iter().map(seed).collect();
    let group_ids: Vec<i64> = input.modules.iter().map(|m| m.group_id).collect();
    let req_skills: Vec<Option<i64>> = input.modules.iter().map(|m| m.required_skill).collect();
    let mut unresolved = 0;

    // Precompute each entity's modifiers once.
    let mods = |e: &EntityInput, unresolved: &mut usize| -> Vec<ModifierDef> {
        let mut out = Vec::new();
        for &eid in &e.effect_ids {
            if let Some(meta) = effects.get(&eid) {
                let (m, dropped) = modifiers_for(meta, is_stackable);
                *unresolved += dropped;
                out.extend(m);
            }
        }
        out
    };
    let skill_mods: Vec<Vec<ModifierDef>> =
        input.skills.iter().map(|e| mods(e, &mut unresolved)).collect();
    let ship_mods = mods(&input.ship, &mut unresolved);
    let module_mods: Vec<Vec<ModifierDef>> =
        input.modules.iter().map(|e| mods(e, &mut unresolved)).collect();

    // Pass A — self (Item) modifiers on every entity (e.g. skill per-level scaling).
    for (s, ms) in skills.iter_mut().zip(&skill_mods) {
        apply_self(s, ms);
    }
    apply_self(&mut ship, &ship_mods);
    for (m, ms) in modules.iter_mut().zip(&module_mods) {
        apply_self(m, ms);
    }

    // Pass B — outward modifiers, in tree order: skills → ship → modules.
    for (s, ms) in skills.iter().zip(&skill_mods) {
        apply_outward(s, ms, &mut ship, &mut modules, &group_ids, &req_skills);
    }
    apply_outward_from_ship(&ship_mods, &mut ship, &mut modules, &group_ids, &req_skills);
    for i in 0..modules.len() {
        // Read source from module i, apply to ship / other modules.
        let ms = module_mods[i].clone();
        let src_vals: Vec<(usize, f64)> = ms
            .iter()
            .enumerate()
            .map(|(k, m)| (k, modules[i].get(m.src_attr)))
            .collect();
        for (k, value) in src_vals {
            let m = &ms[k];
            apply_to_targets(m, value, &mut ship, &mut modules, &group_ids, &req_skills, Some(i));
        }
    }

    ResolvedFit {
        ship,
        modules,
        unresolved,
    }
}

fn seed(e: &EntityInput) -> AttrStore {
    let mut s = AttrStore::new();
    s.seed(&e.attrs);
    s
}

/// Apply an entity's `Domain::Item` modifiers to its own store.
fn apply_self(store: &mut AttrStore, mods: &[ModifierDef]) {
    for m in mods {
        if m.domain == Domain::Item {
            let value = store.get(m.src_attr);
            store.apply(m.tgt_attr, m.op, value, m.penalized);
        }
    }
}

/// Apply an affecting store's outward modifiers (source read from `affecting`).
fn apply_outward(
    affecting: &AttrStore,
    mods: &[ModifierDef],
    ship: &mut AttrStore,
    modules: &mut [AttrStore],
    group_ids: &[i64],
    req_skills: &[Option<i64>],
) {
    for m in mods {
        if m.domain == Domain::Item {
            continue;
        }
        let value = affecting.get(m.src_attr);
        apply_to_targets(m, value, ship, modules, group_ids, req_skills, None);
    }
}

/// Ship role bonuses: the ship is both affecting and a potential target, so read
/// its source values first, then apply.
fn apply_outward_from_ship(
    mods: &[ModifierDef],
    ship: &mut AttrStore,
    modules: &mut [AttrStore],
    group_ids: &[i64],
    req_skills: &[Option<i64>],
) {
    let vals: Vec<f64> = mods.iter().map(|m| ship.get(m.src_attr)).collect();
    for (m, value) in mods.iter().zip(vals) {
        if m.domain == Domain::Item {
            continue;
        }
        apply_to_targets(m, value, ship, modules, group_ids, req_skills, None);
    }
}

/// Route one modifier (with its already-read `value`) to its target stores.
fn apply_to_targets(
    m: &ModifierDef,
    value: f64,
    ship: &mut AttrStore,
    modules: &mut [AttrStore],
    group_ids: &[i64],
    req_skills: &[Option<i64>],
    self_index: Option<usize>,
) {
    match m.domain {
        Domain::Ship => ship.apply(m.tgt_attr, m.op, value, m.penalized),
        Domain::Location => {
            for s in modules.iter_mut() {
                s.apply(m.tgt_attr, m.op, value, m.penalized);
            }
        }
        Domain::GroupOnShip(g) => {
            for (i, s) in modules.iter_mut().enumerate() {
                if group_ids[i] == g {
                    s.apply(m.tgt_attr, m.op, value, m.penalized);
                }
            }
        }
        Domain::SkillReqOnShip(skill) => {
            for (i, s) in modules.iter_mut().enumerate() {
                if req_skills[i] == Some(skill) {
                    s.apply(m.tgt_attr, m.op, value, m.penalized);
                }
            }
        }
        // Item handled in pass A; Char/Target not modelled here (P3 projection).
        Domain::Item | Domain::Char | Domain::Target => {
            let _ = self_index;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sde::ModifierInfo;

    fn effect(id: i64, modifiers: Vec<ModifierInfo>) -> EffectMeta {
        EffectMeta {
            effect_id: id,
            name: format!("e{id}"),
            category: 0,
            is_offensive: false,
            is_assistance: false,
            duration_attribute_id: None,
            discharge_attribute_id: None,
            range_attribute_id: None,
            falloff_attribute_id: None,
            tracking_speed_attribute_id: None,
            modifiers,
        }
    }
    fn mi(func: &str, dom: &str, op: i64, tgt: i64, src: i64, group: Option<i64>) -> ModifierInfo {
        ModifierInfo {
            domain: Some(dom.into()),
            func: Some(func.into()),
            modified_attribute_id: Some(tgt),
            modifying_attribute_id: Some(src),
            operation: Some(op),
            group_id: group,
            skill_type_id: None,
        }
    }

    /// Surgical Strike at level V: scales its own damageMultiplierBonus (292) by
    /// skillLevel (280) via self preMul, then +15% to turret damageMultiplier
    /// (64) on group 55. A fitted turret of group 55 should end at 1.15× damage.
    #[test]
    fn skill_scales_per_level_then_boosts_turret_group() {
        // Effect 100: self preMul 292 by 280. Effect 101: group-55 postPercent 64 by 292.
        let mut effects = HashMap::new();
        effects.insert(100, effect(100, vec![mi("ItemModifier", "itemID", 0, 292, 280, None)]));
        effects.insert(
            101,
            effect(101, vec![mi("LocationGroupModifier", "shipID", 6, 64, 292, Some(55))]),
        );

        let input = FitInput {
            ship: EntityInput::default(),
            modules: vec![EntityInput {
                attrs: vec![(64, 1.0)], // turret base damageMultiplier
                effect_ids: vec![],
                group_id: 55,
                required_skill: None,
            }],
            skills: vec![EntityInput {
                attrs: vec![(280, 5.0), (292, 3.0)], // level V, 3%/level
                effect_ids: vec![100, 101],
                group_id: 0,
                required_skill: None,
            }],
        };

        // damageMultiplier (64) is non-stackable, but a single bonus isn't reduced.
        let resolved = resolve(&input, &effects, &|attr| attr != 64);
        let dmg = resolved.modules[0].get(64);
        assert!((dmg - 1.15).abs() < 1e-9, "turret damage = {dmg}, want 1.15");
        assert_eq!(resolved.unresolved, 0);
    }

    /// A bonus that targets a different group leaves the turret untouched.
    #[test]
    fn group_filter_excludes_other_groups() {
        let mut effects = HashMap::new();
        effects.insert(
            101,
            effect(101, vec![mi("LocationGroupModifier", "shipID", 6, 64, 292, Some(74))]),
        );
        let input = FitInput {
            ship: EntityInput::default(),
            modules: vec![EntityInput {
                attrs: vec![(64, 1.0)],
                effect_ids: vec![],
                group_id: 55, // projectile, not the hybrid group 74
                required_skill: None,
            }],
            skills: vec![EntityInput {
                attrs: vec![(292, 15.0)],
                effect_ids: vec![101],
                group_id: 0,
                required_skill: None,
            }],
        };
        let resolved = resolve(&input, &effects, &|_| true);
        assert_eq!(resolved.modules[0].get(64), 1.0);
    }
}
