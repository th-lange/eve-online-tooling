//! Fitting-module-local dogma preload: the five bulk SDE queries (base
//! attributes, effects, type→group, effect metadata, attribute defaults) that
//! `run_dogma`, `resolve_module_costs` and `optimize_fit` each ran on their own
//! before this, plus the skill/entity construction built off them. One preload
//! path shared by all three entry points (#559). The two static, SDE-swap-wide
//! maps — effect metadata and attribute defaults — are served from the
//! generation-keyed process cache instead of re-scanning `dgmEffects` (with
//! its per-row `modifierInfo` JSON parse) and `dgmAttributeTypes` on every
//! call (#761).

use std::path::Path;
use std::sync::Arc;

use super::engine::resolve::EntityInput;
use super::stats::{AttrMap, EffectMap, GroupMap};
use crate::sde::{AttrDefaultsMap, EffectMetaMap, Sde};

/// Bulk-preloaded dogma-engine inputs for one fitting operation (simulate,
/// resolve candidate costs, optimize): every type id the caller needs —
/// published skills plus whatever `extra_ids` it adds (ship/modules/charges/
/// drones/candidates) — resolved in three bulk per-call SDE queries plus two
/// process-wide cached maps, instead of one query per type.
/// Fields are `pub(super)`: sibling fitting files (notably the optimizer's
/// per-candidate `evaluate` hot loop) borrow the maps directly; nothing outside
/// `fitting` reaches them.
pub(super) struct DogmaContext {
    pub(super) attrs: AttrMap,
    pub(super) effects: EffectMap,
    pub(super) groups: GroupMap,
    pub(super) effect_meta: Arc<EffectMetaMap>,
    pub(super) defaults: Arc<AttrDefaultsMap>,
    /// Published skill type ids, cached alongside the maps above so
    /// [`Self::skill_entities`] doesn't need a second SDE round-trip.
    skill_ids: Vec<i64>,
}

impl DogmaContext {
    /// Preload every dogma-engine input: three bulk SDE queries scoped to
    /// this call's type ids (base attributes, effects, type→group) plus the
    /// two static catalogues (effect metadata, attribute defaults) served
    /// from the process-wide cache, for the game's published skills plus
    /// `extra_ids` (ship, fitted/candidate modules, charges, drones,
    /// implants, projected items — whatever the caller resolves entities for).
    pub(super) fn load(sde: &Sde, dir: &Path, extra_ids: &[i64]) -> Result<Self, String> {
        let skill_ids = sde.skill_type_ids().map_err(|e| e.to_string())?;
        let mut all_ids = Vec::with_capacity(extra_ids.len() + skill_ids.len());
        all_ids.extend_from_slice(extra_ids);
        all_ids.extend(&skill_ids);

        let attrs = sde
            .types_attributes_raw(&all_ids)
            .map_err(|e| e.to_string())?;
        let effects = sde.types_effects(&all_ids).map_err(|e| e.to_string())?;
        let groups = sde.types_groups(&all_ids).map_err(|e| e.to_string())?;
        let effect_meta = crate::sde::cached_effect_meta(dir)?;
        let defaults = crate::sde::cached_attribute_defaults(dir)?;

        Ok(Self {
            attrs,
            effects,
            groups,
            effect_meta,
            defaults,
            skill_ids,
        })
    }

    /// Whether an attribute's bonuses stack multiplicatively at full strength
    /// (`stackable = 0` in the SDE ⇒ subject to the stacking penalty).
    /// Unknown attributes default stackable (matches the SDE's own default).
    pub(super) fn is_stackable(&self, attr_id: i64) -> bool {
        self.defaults
            .get(&attr_id)
            .map(|m| m.stackable)
            .unwrap_or(true)
    }

    /// An attribute's default value when a type doesn't carry it explicitly.
    pub(super) fn default_of(&self, attr_id: i64) -> f64 {
        self.defaults
            .get(&attr_id)
            .map(|m| m.default_value)
            .unwrap_or(0.0)
    }

    /// Build an entity from the preloaded bulk maps — group id comes from
    /// `types_groups`, so this never round-trips the SDE per type.
    pub(super) fn entity(&self, type_id: i64, required_skills: Vec<i64>) -> EntityInput {
        EntityInput {
            type_id,
            attrs: self.attrs.get(&type_id).cloned().unwrap_or_default(),
            effect_ids: self.effects.get(&type_id).cloned().unwrap_or_default(),
            group_id: self.groups.get(&type_id).copied().unwrap_or(0),
            required_skills,
            overheated: false,
        }
    }

    /// Every published skill as an [`EntityInput`] at `level_for(skill_id)`,
    /// with skillLevel (280) forced to that level; a skill at level <= 0
    /// (untrained) is skipped entirely.
    pub(super) fn skill_entities(&self, level_for: impl Fn(i64) -> f64) -> Vec<EntityInput> {
        let mut skills = Vec::with_capacity(self.skill_ids.len());
        for sid in &self.skill_ids {
            let level = level_for(*sid);
            if level <= 0.0 {
                continue;
            }
            let mut a = self.attrs.get(sid).cloned().unwrap_or_default();
            match a.iter_mut().find(|(k, _)| *k == 280) {
                Some(p) => p.1 = level,
                None => a.push((280, level)),
            }
            skills.push(EntityInput {
                type_id: *sid,
                attrs: a,
                effect_ids: self.effects.get(sid).cloned().unwrap_or_default(),
                group_id: 0,
                required_skills: Vec::new(),
                overheated: false,
            });
        }
        skills
    }
}
