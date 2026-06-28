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

use std::collections::HashMap;

use crate::sde::EffectMeta;

use super::attr::AttrStore;
use super::effects::modifiers_for;
use super::modifier::{Domain, ModifierDef, Op};

/// `damageMultiplierSkillBonus` — drone operation/specialization skills carry
/// only the per-level self-scaling of attr 292 in their `modifierInfo`; the
/// application (+292% to damageMultiplier on items requiring the skill) isn't in
/// the Fuzzwork dump, so the engine synthesizes it (#176).
const DAMAGE_MULT_SKILL_BONUS: &str = "damageMultiplierSkillBonus";

/// One entity in the fit tree, reduced to what resolution needs.
#[derive(Debug, Clone, Default)]
pub struct EntityInput {
    /// The entity's own type id (0 if irrelevant). Lets a skill synthesize a
    /// self-referential `SkillReqOnShip` modifier (see [`DAMAGE_MULT_SKILL_BONUS`]).
    pub type_id: i64,
    /// Base attributes `(attributeID, value)` — for skills, includes `skillLevel`
    /// (280) set to the desired level.
    pub attrs: Vec<(i64, f64)>,
    /// The entity's `dgmTypeEffects` ids.
    pub effect_ids: Vec<i64>,
    /// `invGroups.groupID` (for `LocationGroupModifier` targeting).
    pub group_id: i64,
    /// All required-skill type ids (requiredSkill1/2/3 = attrs 182/183/184), for
    /// `*RequiredSkillModifier` targeting — a skill bonus can key off **any** of
    /// them (e.g. Weapon Upgrades reduces CPU of modules requiring Gunnery, which
    /// is a turret's *second* required skill, not its first).
    pub required_skills: Vec<i64>,
}

/// A whole fit reduced to resolution inputs.
#[derive(Debug, Clone, Default)]
pub struct FitInput {
    pub ship: EntityInput,
    /// Fitted modules/rigs/subsystems (drones/cargo don't affect ship stats).
    pub modules: Vec<EntityInput>,
    /// Active skills (at the chosen level, baked into `attrs[280]`).
    pub skills: Vec<EntityInput>,
    /// Drones in space (pass 4): targets of drone skills + ship/module drone
    /// bonuses, but they never modify the ship.
    pub drones: Vec<EntityInput>,
    /// Loaded charges, parallel to `modules` (pass 4): a charge gets its host
    /// module's group/skill-keyed bonuses plus missile-damage skills/ship role
    /// bonuses, so its finalized damage drives missile DPS. `None` = empty slot.
    pub charges: Vec<Option<EntityInput>>,
}

/// Resolved attribute stores for the ship and each module (parallel to input).
#[derive(Debug, Clone)]
pub struct ResolvedFit {
    pub ship: AttrStore,
    pub modules: Vec<AttrStore>,
    /// Finalized drone stores (parallel to `FitInput::drones`).
    pub drones: Vec<AttrStore>,
    /// Finalized charge stores (parallel to `FitInput::charges`/`modules`).
    pub charges: Vec<Option<AttrStore>>,
    /// Effect modifiers we couldn't model (coverage metric).
    #[allow(dead_code)] // surfaced by the golden-coverage harness (#176)
    pub unresolved: usize,
}

/// An auxiliary resolution target (a drone or a loaded charge): a store plus the
/// group/required-skill keys that decide which outward modifiers reach it.
struct Aux {
    store: AttrStore,
    group_id: i64,
    req_skills: Vec<i64>,
    /// Where this scatters back to in [`ResolvedFit`].
    dest: AuxDest,
}

enum AuxDest {
    Drone(usize),
    Charge(usize),
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
    let req_skills: Vec<&Vec<i64>> = input.modules.iter().map(|m| &m.required_skills).collect();
    let mut unresolved = 0;

    // Pass-4 auxiliary targets: drones and loaded charges. They receive the
    // group/skill-keyed modifiers from skills, ship and modules (drone-damage
    // skills, missile-damage role bonuses, Drone Damage Amplifiers, …) but never
    // modify the ship, so they resolve as targets only.
    let mut aux: Vec<Aux> = Vec::new();
    for (j, d) in input.drones.iter().enumerate() {
        aux.push(Aux {
            store: seed(d),
            group_id: d.group_id,
            req_skills: d.required_skills.clone(),
            dest: AuxDest::Drone(j),
        });
    }
    for (i, c) in input.charges.iter().enumerate() {
        if let Some(c) = c {
            aux.push(Aux {
                store: seed(c),
                group_id: c.group_id,
                req_skills: c.required_skills.clone(),
                dest: AuxDest::Charge(i),
            });
        }
    }

    // Precompute each entity's modifiers once.
    let mods = |e: &EntityInput, unresolved: &mut usize| -> Vec<ModifierDef> {
        let mut out = Vec::new();
        let mut has_dmg_skill_bonus = false;
        for &eid in &e.effect_ids {
            if let Some(meta) = effects.get(&eid) {
                if meta.name == DAMAGE_MULT_SKILL_BONUS {
                    has_dmg_skill_bonus = true;
                }
                let (m, dropped) = modifiers_for(meta, is_stackable);
                *unresolved += dropped;
                out.extend(m);
            }
        }
        // Synthesize the missing application: this skill's scaled damageMultiplier
        // bonus (292) postPercent-boosts damageMultiplier (64) on items requiring
        // the skill itself (e.g. Medium Drone Operation → drones requiring it).
        if has_dmg_skill_bonus && e.type_id != 0 {
            out.push(ModifierDef {
                src_attr: 292,
                op: Op::PostPercent,
                tgt_attr: 64,
                domain: Domain::SkillReqOnShip(e.type_id),
                penalized: false,
            });
        }
        out
    };
    let skill_mods: Vec<Vec<ModifierDef>> =
        input.skills.iter().map(|e| mods(e, &mut unresolved)).collect();
    let ship_mods = mods(&input.ship, &mut unresolved);
    let module_mods: Vec<Vec<ModifierDef>> =
        input.modules.iter().map(|e| mods(e, &mut unresolved)).collect();
    let aux_mods: Vec<Vec<ModifierDef>> = aux
        .iter()
        .map(|a| match &a.dest {
            AuxDest::Drone(j) => mods(&input.drones[*j], &mut unresolved),
            AuxDest::Charge(i) => mods(input.charges[*i].as_ref().unwrap(), &mut unresolved),
        })
        .collect();

    // Pass A — self (Item) modifiers on every entity (e.g. skill per-level scaling).
    for (s, ms) in skills.iter_mut().zip(&skill_mods) {
        apply_self(s, ms);
    }
    apply_self(&mut ship, &ship_mods);
    for (m, ms) in modules.iter_mut().zip(&module_mods) {
        apply_self(m, ms);
    }
    for (a, ms) in aux.iter_mut().zip(&aux_mods) {
        apply_self(&mut a.store, ms);
    }

    // Pass B — outward modifiers, in tree order: skills → ship → modules.
    // Bonuses from skills and ship role bonuses are **exempt** from the stacking
    // penalty (EVE penalizes only module/drone-sourced bonuses), so those passes
    // force `penalized = false`; the module pass keeps each modifier's own flag.
    for (s, ms) in skills.iter().zip(&skill_mods) {
        apply_outward(s, ms, false, &mut ship, &mut modules, &group_ids, &req_skills, &mut aux);
    }
    apply_outward_from_ship(
        &ship_mods, false, &mut ship, &mut modules, &group_ids, &req_skills, &mut aux,
    );
    for i in 0..modules.len() {
        // Read source from module i, apply to ship / other modules / aux.
        let ms = module_mods[i].clone();
        let src_vals: Vec<(usize, f64)> = ms
            .iter()
            .enumerate()
            .map(|(k, m)| (k, modules[i].get(m.src_attr)))
            .collect();
        for (k, value) in src_vals {
            let m = &ms[k];
            apply_to_targets(
                m, value, m.penalized, &mut ship, &mut modules, &group_ids, &req_skills, &mut aux,
            );
        }
    }

    // Scatter resolved aux stores back to their slots.
    let mut drones = vec![AttrStore::new(); input.drones.len()];
    let mut charges: Vec<Option<AttrStore>> = vec![None; input.charges.len()];
    for a in aux {
        match a.dest {
            AuxDest::Drone(j) => drones[j] = a.store,
            AuxDest::Charge(i) => charges[i] = Some(a.store),
        }
    }

    ResolvedFit {
        ship,
        modules,
        drones,
        charges,
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
    penalized: bool,
    ship: &mut AttrStore,
    modules: &mut [AttrStore],
    group_ids: &[i64],
    req_skills: &[&Vec<i64>],
    aux: &mut [Aux],
) {
    for m in mods {
        if m.domain == Domain::Item {
            continue;
        }
        let value = affecting.get(m.src_attr);
        apply_to_targets(m, value, penalized, ship, modules, group_ids, req_skills, aux);
    }
}

/// Ship role bonuses: the ship is both affecting and a potential target, so read
/// its source values first, then apply.
fn apply_outward_from_ship(
    mods: &[ModifierDef],
    penalized: bool,
    ship: &mut AttrStore,
    modules: &mut [AttrStore],
    group_ids: &[i64],
    req_skills: &[&Vec<i64>],
    aux: &mut [Aux],
) {
    let vals: Vec<f64> = mods.iter().map(|m| ship.get(m.src_attr)).collect();
    for (m, value) in mods.iter().zip(vals) {
        if m.domain == Domain::Item {
            continue;
        }
        apply_to_targets(m, value, penalized, ship, modules, group_ids, req_skills, aux);
    }
}

/// Route one modifier (with its already-read `value`) to its target stores.
/// `penalized` is supplied by the caller (skills/ship pass force it off — those
/// bonuses are stacking-exempt — while the module pass keeps the modifier's own
/// flag). Drones/charges (`aux`) only receive the group/skill-keyed domains —
/// never the blanket `Location`/`Ship` domains, which don't reach them.
fn apply_to_targets(
    m: &ModifierDef,
    value: f64,
    penalized: bool,
    ship: &mut AttrStore,
    modules: &mut [AttrStore],
    group_ids: &[i64],
    req_skills: &[&Vec<i64>],
    aux: &mut [Aux],
) {
    match m.domain {
        Domain::Ship => ship.apply(m.tgt_attr, m.op, value, penalized),
        Domain::Location => {
            for s in modules.iter_mut() {
                s.apply(m.tgt_attr, m.op, value, penalized);
            }
        }
        Domain::GroupOnShip(g) => {
            for (i, s) in modules.iter_mut().enumerate() {
                if group_ids[i] == g {
                    s.apply(m.tgt_attr, m.op, value, penalized);
                }
            }
            for a in aux.iter_mut() {
                if a.group_id == g {
                    a.store.apply(m.tgt_attr, m.op, value, penalized);
                }
            }
        }
        Domain::SkillReqOnShip(skill) => {
            for (i, s) in modules.iter_mut().enumerate() {
                if req_skills[i].contains(&skill) {
                    s.apply(m.tgt_attr, m.op, value, penalized);
                }
            }
            for a in aux.iter_mut() {
                if a.req_skills.contains(&skill) {
                    a.store.apply(m.tgt_attr, m.op, value, penalized);
                }
            }
        }
        // Item handled in pass A; Char/Target not modelled here (P3 projection).
        Domain::Item | Domain::Char | Domain::Target => {}
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

    fn mi_skill(func: &str, dom: &str, op: i64, tgt: i64, src: i64, skill: i64) -> ModifierInfo {
        ModifierInfo {
            domain: Some(dom.into()),
            func: Some(func.into()),
            modified_attribute_id: Some(tgt),
            modifying_attribute_id: Some(src),
            operation: Some(op),
            group_id: None,
            skill_type_id: Some(skill),
        }
    }

    /// Pass-4 ship role bonus reaching a drone (the Vexor mechanism, #176): the
    /// racial-cruiser skill preMul-scales the ship bonus attr (658) by its level,
    /// then the ship's OwnerRequiredSkillModifier applies that % to drones
    /// requiring the Drones skill. 10%/level × V = +50% → a 1.0 drone ends at 1.5.
    #[test]
    fn ship_bonus_scales_by_skill_then_reaches_drone() {
        let mut effects = HashMap::new();
        // Ship effect: postPercent damageMultiplier (64) by bonus attr (658) on
        // items requiring skill 3436 (Drones).
        effects.insert(
            200,
            effect(200, vec![mi_skill("OwnerRequiredSkillModifier", "charID", 6, 64, 658, 3436)]),
        );
        // Gallente Cruiser skill effect: preMul the ship's 658 by skillLevel (280).
        effects.insert(201, effect(201, vec![mi("ItemModifier", "shipID", 0, 658, 280, None)]));

        let input = FitInput {
            ship: EntityInput {
                type_id: 0,
                attrs: vec![(658, 10.0)], // 10%/level base bonus
                effect_ids: vec![200],
                group_id: 0,
                required_skills: Vec::new(),
            },
            skills: vec![EntityInput {
                type_id: 0,
                attrs: vec![(280, 5.0)], // Gallente Cruiser V
                effect_ids: vec![201],
                group_id: 0,
                required_skills: Vec::new(),
            }],
            drones: vec![EntityInput {
                type_id: 0,
                attrs: vec![(64, 1.0)],
                effect_ids: vec![],
                group_id: 0,
                required_skills: vec![3436], // Hammerhead II requires Drones (184)
            }],
            ..Default::default()
        };
        let resolved = resolve(&input, &effects, &|_| true);
        let dmg = resolved.drones[0].get(64);
        assert!((dmg - 1.5).abs() < 1e-9, "drone damageMultiplier = {dmg}, want 1.5");
    }

    /// `damageMultiplierSkillBonus` synthesis (#176): a drone operation/spec
    /// skill carries only the self-scale of attr 292 in its modifierInfo; the
    /// engine synthesizes the application (+292% to attr 64 on items requiring
    /// the skill). 5%/level × V = +25% → a 1.0 drone requiring the skill ends 1.25.
    #[test]
    fn damage_mult_skill_bonus_application_is_synthesized() {
        let mut bonus = effect(300, vec![mi("ItemModifier", "itemID", 0, 292, 280, None)]);
        bonus.name = "damageMultiplierSkillBonus".into();
        let mut effects = HashMap::new();
        effects.insert(300, bonus);

        let skill_id = 33699; // e.g. Medium Drone Operation
        let input = FitInput {
            skills: vec![EntityInput {
                type_id: skill_id,
                attrs: vec![(280, 5.0), (292, 5.0)], // V, 5%/level
                effect_ids: vec![300],
                ..Default::default()
            }],
            drones: vec![EntityInput {
                attrs: vec![(64, 1.0)],
                required_skills: vec![skill_id], // the drone requires the skill
                ..Default::default()
            }],
            ..Default::default()
        };
        let resolved = resolve(&input, &effects, &|_| true);
        let dmg = resolved.drones[0].get(64);
        assert!((dmg - 1.25).abs() < 1e-9, "drone damageMultiplier = {dmg}, want 1.25");
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
                type_id: 0,
                attrs: vec![(64, 1.0)], // turret base damageMultiplier
                effect_ids: vec![],
                group_id: 55,
                required_skills: Vec::new(),
            }],
            skills: vec![EntityInput {
                type_id: 0,
                attrs: vec![(280, 5.0), (292, 3.0)], // level V, 3%/level
                effect_ids: vec![100, 101],
                group_id: 0,
                required_skills: Vec::new(),
            }],
            ..Default::default()
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
                type_id: 0,
                attrs: vec![(64, 1.0)],
                effect_ids: vec![],
                group_id: 55, // projectile, not the hybrid group 74
                required_skills: Vec::new(),
            }],
            skills: vec![EntityInput {
                type_id: 0,
                attrs: vec![(292, 15.0)],
                effect_ids: vec![101],
                group_id: 0,
                required_skills: Vec::new(),
            }],
            ..Default::default()
        };
        let resolved = resolve(&input, &effects, &|_| true);
        assert_eq!(resolved.modules[0].get(64), 1.0);
    }
}
