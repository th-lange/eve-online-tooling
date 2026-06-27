//! Parametric modifier model (#170) — the data the dogma engine applies.
//!
//! Populated by parsing `dgmEffects.modifierInfo` (#171). The EVE `operation`
//! integer maps to [`Op`] via [`Op::from_code`]; the codes were verified against
//! the SDE (`shieldCapacityBonusOnline` is op 2 = a flat HP add; effect names
//! ending `…PostDiv`/`…PostPercent` are ops 5/6; op 1 has zero rows):
//!
//! | code | op | code | op |
//! |---|---|---|---|
//! | -1 | preAssign | 4 | postMul |
//! | 0 | preMul | 5 | postDiv |
//! | 1 | preDiv | 6 | postPercent |
//! | 2 | modAdd | 7 | postAssign |
//! | 3 | modSub | | |
//!
//! These types are constructed by the effect registry (#171); the module-level
//! allow lets the model land ahead of that consumer.
#![allow(dead_code)]

/// An EVE dogma operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Op {
    PreAssign,
    PreMul,
    PreDiv,
    ModAdd,
    ModSub,
    PostMul,
    PostDiv,
    PostPercent,
    PostAssign,
}

impl Op {
    /// Map a `modifierInfo.operation` integer to an [`Op`] (`None` if unknown).
    pub fn from_code(code: i64) -> Option<Op> {
        Some(match code {
            -1 => Op::PreAssign,
            0 => Op::PreMul,
            1 => Op::PreDiv,
            2 => Op::ModAdd,
            3 => Op::ModSub,
            4 => Op::PostMul,
            5 => Op::PostDiv,
            6 => Op::PostPercent,
            7 => Op::PostAssign,
            _ => return None,
        })
    }

    /// Whether this is a post-multiplicative op — the ops eligible for the
    /// stacking penalty when the target attribute is non-stackable.
    pub fn is_post_mul(self) -> bool {
        matches!(self, Op::PostMul | Op::PostDiv | Op::PostPercent)
    }
}

/// Which items a modifier targets, relative to the affecting item. Consumed by
/// the resolution passes (#171); defined here with the rest of the model.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Domain {
    /// The affecting item itself.
    Item,
    /// The ship hull.
    Ship,
    /// The pilot (skills/implants).
    Char,
    /// A projected target ship.
    Target,
    /// Every module on the ship (`LocationModifier`).
    Location,
    /// Items on the ship in a given group (`LocationGroupModifier`).
    GroupOnShip(i64),
    /// Items on the ship requiring a given skill (`*RequiredSkillModifier`).
    SkillReqOnShip(i64),
}

/// One atomic attribute modification produced by an effect.
#[derive(Debug, Clone, PartialEq)]
pub struct ModifierDef {
    /// Attribute on the affecting item carrying the magnitude.
    pub src_attr: i64,
    pub op: Op,
    /// Attribute changed on each target.
    pub tgt_attr: i64,
    pub domain: Domain,
    /// Whether this modifier is subject to the stacking penalty.
    pub penalized: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn operation_codes_map_to_the_verified_ops() {
        assert_eq!(Op::from_code(2), Some(Op::ModAdd)); // shield extender flat HP
        assert_eq!(Op::from_code(4), Some(Op::PostMul));
        assert_eq!(Op::from_code(5), Some(Op::PostDiv));
        assert_eq!(Op::from_code(6), Some(Op::PostPercent)); // the common case
        assert_eq!(Op::from_code(-1), Some(Op::PreAssign));
        assert_eq!(Op::from_code(99), None);
        assert!(Op::PostPercent.is_post_mul());
        assert!(!Op::ModAdd.is_post_mul());
    }

    #[test]
    fn modifier_def_holds_a_group_filtered_modifier() {
        // Gyrostabilizer: +damage to projectile turrets (group 55) on the ship.
        let m = ModifierDef {
            src_attr: 64,
            op: Op::PostPercent,
            tgt_attr: 64,
            domain: Domain::GroupOnShip(55),
            penalized: true,
        };
        assert_eq!(m.domain, Domain::GroupOnShip(55));
        assert!(m.penalized);
    }
}
