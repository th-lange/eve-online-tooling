//! Translate `dgmEffects.modifierInfo` into engine [`ModifierDef`]s (#171).
//!
//! This is the data-driven heart of the engine: instead of ~1500 hand-coded
//! effects, each effect's `modifierInfo` JSON already describes its modifiers
//! (domain, func, source/target attribute, operation). We map those onto the
//! [`Domain`]/[`Op`] model; only genuinely procedural effects (capacitor
//! recharge curve, resist combination, hit quality) need bespoke handling, and
//! those live in the stat calculators.

use crate::sde::{EffectMeta, ModifierInfo};

use super::modifier::{Domain, ModifierDef, Op};

/// Translate every modifier on an effect, skipping any whose func/operation we
/// don't model. Returns `(modifiers, dropped)` so callers can measure coverage.
pub fn modifiers_for(
    meta: &EffectMeta,
    is_stackable: &impl Fn(i64) -> bool,
) -> (Vec<ModifierDef>, usize) {
    let mut out = Vec::new();
    let mut dropped = 0;
    for mi in &meta.modifiers {
        match modifier_from(mi, is_stackable) {
            Some(m) => out.push(m),
            None => dropped += 1,
        }
    }
    (out, dropped)
}

fn modifier_from(mi: &ModifierInfo, is_stackable: &impl Fn(i64) -> bool) -> Option<ModifierDef> {
    let op = Op::from_code(mi.operation?)?;
    let tgt_attr = mi.modified_attribute_id?;
    let src_attr = mi.modifying_attribute_id?;
    let domain = domain_of(mi)?;
    // Multiplicative bonuses to a non-stackable attribute are stacking-penalized.
    let penalized = op.is_post_mul() && !is_stackable(tgt_attr);
    Some(ModifierDef {
        src_attr,
        op,
        tgt_attr,
        domain,
        penalized,
    })
}

/// Map a modifier's `func` + `domain` to an engine [`Domain`]. Returns `None`
/// for funcs we don't model yet.
fn domain_of(mi: &ModifierInfo) -> Option<Domain> {
    let func = mi.func.as_deref()?;
    let dom = mi.domain.as_deref().unwrap_or("itemID");
    Some(match func {
        "ItemModifier" => match dom {
            "shipID" => Domain::Ship,
            "charID" => Domain::Char,
            "targetID" => Domain::Target,
            "otherID" => Domain::Other,
            // "itemID" / default: the affecting item itself.
            _ => Domain::Item,
        },
        "LocationModifier" => Domain::Location,
        "LocationGroupModifier" => Domain::GroupOnShip(mi.group_id?),
        "LocationRequiredSkillModifier" | "OwnerRequiredSkillModifier" => {
            Domain::SkillReqOnShip(mi.skill_type_id?)
        }
        // Command-burst / fleet-link effects (#705): normally these project
        // onto every gang member's ship. The simulator models them from the
        // *receiving* ship's perspective — the caller builds an `EntityInput`
        // for each fleet-boost module the user says they're receiving and
        // resolves it as an external outward-modifier source, so mapping the
        // effect straight to `Domain::Ship` (the ship that "receives" it) is
        // correct here even though a real gang module never targets its own
        // hull's `Domain::Ship`.
        "GangModifier" => Domain::Ship,
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn meta(modifiers: Vec<ModifierInfo>) -> EffectMeta {
        EffectMeta {
            effect_id: 1,
            name: "t".into(),
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

    #[test]
    fn translates_group_modifier_and_marks_penalized() {
        // Gyrostabilizer: postPercent (6) to damageMultiplier (64) on group 55.
        let e = meta(vec![mi(
            "LocationGroupModifier",
            "shipID",
            6,
            64,
            64,
            Some(55),
        )]);
        let (mods, dropped) = modifiers_for(&e, &|attr| attr != 64); // 64 non-stackable
        assert_eq!(dropped, 0);
        assert_eq!(mods.len(), 1);
        assert_eq!(mods[0].domain, Domain::GroupOnShip(55));
        assert_eq!(mods[0].op, Op::PostPercent);
        assert!(mods[0].penalized);
    }

    #[test]
    fn self_item_modifier_is_domain_item() {
        // Skill self-scaling: preMul (0) of damageMultiplierBonus by skillLevel.
        let e = meta(vec![mi("ItemModifier", "itemID", 0, 292, 280, None)]);
        let (mods, _) = modifiers_for(&e, &|_| true);
        assert_eq!(mods[0].domain, Domain::Item);
        assert_eq!(mods[0].op, Op::PreMul);
        assert!(!mods[0].penalized); // preMul is never penalized
    }

    #[test]
    fn unmodelled_func_is_dropped() {
        let e = meta(vec![mi("SomeUnmodelledFunc", "shipID", 6, 64, 64, None)]);
        let (mods, dropped) = modifiers_for(&e, &|_| false);
        assert!(mods.is_empty());
        assert_eq!(dropped, 1);
    }

    #[test]
    fn gang_modifier_targets_ship() {
        // Command-burst effects (#705): GangModifier projects onto the
        // receiving ship, so it maps to Domain::Ship.
        let e = meta(vec![mi("GangModifier", "shipID", 2, 51, 51, None)]);
        let (mods, dropped) = modifiers_for(&e, &|_| false);
        assert_eq!(dropped, 0);
        assert_eq!(mods[0].domain, Domain::Ship);
    }
}
