//! Built-in target/damage-pattern library (#873): derives [`NpcProfile`]
//! presets straight from real SDE NPC ship dogma attributes — never from
//! Pyfa's `targetProfile.py`/`damagePattern.py` tables (this repo is MIT,
//! Pyfa is GPL-3.0; only the *approach* — read the same dogma fields the
//! fitting engine already reads for player ships — is shared).
//!
//! Data provenance, attribute by attribute (ids verified against the same
//! dogma ids [`super::stats::tank_of`] uses for player resonances):
//! - `sigRadius` (552) and `maxVelocity` (37) feed [`TargetProfile`]
//!   directly.
//! - `angularVelocity` has no direct NPC attribute; it's derived the same
//!   way the frontend's old per-hull-class presets were (speed ÷ engagement
//!   distance), but per-ship from real SDE fields: `entityCruiseSpeed` (508,
//!   the NPC's orbit velocity) ÷ `entityAttackRange` (247, its orbit
//!   distance), falling back to `maxVelocity ÷ entityAttackRange` when the
//!   NPC has no explicit cruise speed (e.g. it never closes to orbit).
//! - The incoming damage split reads `emDamage`/`thermalDamage`/
//!   `kineticDamage`/`explosiveDamage` (114/118/117/116) directly for
//!   turret-firing NPCs; missile-firing NPCs carry all-zero weapon-damage
//!   attributes and reference their ammo via `entityMissileTypeID` (507), so
//!   the fallback reads the *same four ids* off that charge type instead —
//!   charges carry their own per-shot em/thermal/kinetic/explosive dogma
//!   attributes exactly like player ammo does.
//!
//! Each built-in preset averages every member of one or more curated
//! `invGroups` (faction × hull-class "Deadspace" groups for the five pirate
//! factions, difficulty-tiered Sleeper groups, the Abyssal entity groups) —
//! group ids are canonical SDE ids, referenced the same way
//! `environment_effects`' `groupID = 920` and the mode-item classifier's
//! `groupID = 1306` already are elsewhere in this module.
//!
//! Abyssal Deadspace deliberately gets *one* aggregate preset, not six
//! numbered tiers: unlike the Sleeper difficulty families (Sleepless/
//! Awakened/Emergent are genuinely distinct SDE typeIDs), Abyssal tier
//! scaling is a runtime multiplier the filament/instance generator applies —
//! `difficultyTier` (attribute 2761) lives on the *filament* type, not on any
//! NPC ship, and the same ship (e.g. "Harrowing Vedmak") has identical
//! dgmTypeAttributes at every tier. This mirrors [`super::types::AbyssalWeather`]'s
//! existing precedent: Abyssal-specific magnitudes needing tier granularity
//! simply aren't SDE data, so we don't fabricate one.

use crate::sde::Sde;

use super::types::{NpcProfile, TargetProfile};

const ATTR_SIG_RADIUS: i64 = 552;
const ATTR_MAX_VELOCITY: i64 = 37;
const ATTR_CRUISE_SPEED: i64 = 508;
const ATTR_ATTACK_RANGE: i64 = 247;
/// Newer-AI engagement-orbit-distance attribute (Abyssal/Triglavian-era NPCs
/// carry this instead of the legacy `entityAttackRange` — verified empirically:
/// every SDE Abyssal Spaceship/Drone Entity has 2786 and none have 247).
const ATTR_ORBIT_RANGE_ALT: i64 = 2786;
const ATTR_MISSILE_TYPE: i64 = 507;
const ATTR_EM_DAMAGE: i64 = 114;
const ATTR_THERM_DAMAGE: i64 = 118;
const ATTR_KIN_DAMAGE: i64 = 117;
const ATTR_EXP_DAMAGE: i64 = 116;

/// One faction/hull-class "Deadspace" NPC group (#873) — the mission-rat
/// groups every pirate faction has one of per hull size.
struct FactionClass {
    faction: &'static str,
    class: &'static str,
    group_id: i64,
}

/// Five pirate factions × five hull classes = 25 presets. Group ids read off
/// the live SDE's `invGroups` table (categoryID 11, "Deadspace <Faction>
/// <Class>" naming) — stable EVE-canonical ids, not something that changes
/// between SDE updates.
const PIRATE_FACTION_GROUPS: &[FactionClass] = &[
    FactionClass {
        faction: "Guristas",
        class: "Frigate",
        group_id: 615,
    },
    FactionClass {
        faction: "Guristas",
        class: "Destroyer",
        group_id: 614,
    },
    FactionClass {
        faction: "Guristas",
        class: "Cruiser",
        group_id: 613,
    },
    FactionClass {
        faction: "Guristas",
        class: "Battlecruiser",
        group_id: 611,
    },
    FactionClass {
        faction: "Guristas",
        class: "Battleship",
        group_id: 612,
    },
    FactionClass {
        faction: "Serpentis",
        class: "Frigate",
        group_id: 633,
    },
    FactionClass {
        faction: "Serpentis",
        class: "Destroyer",
        group_id: 632,
    },
    FactionClass {
        faction: "Serpentis",
        class: "Cruiser",
        group_id: 631,
    },
    FactionClass {
        faction: "Serpentis",
        class: "Battlecruiser",
        group_id: 629,
    },
    FactionClass {
        faction: "Serpentis",
        class: "Battleship",
        group_id: 630,
    },
    FactionClass {
        faction: "Sansha's Nation",
        class: "Frigate",
        group_id: 624,
    },
    FactionClass {
        faction: "Sansha's Nation",
        class: "Destroyer",
        group_id: 623,
    },
    FactionClass {
        faction: "Sansha's Nation",
        class: "Cruiser",
        group_id: 622,
    },
    FactionClass {
        faction: "Sansha's Nation",
        class: "Battlecruiser",
        group_id: 620,
    },
    FactionClass {
        faction: "Sansha's Nation",
        class: "Battleship",
        group_id: 621,
    },
    FactionClass {
        faction: "Blood Raiders",
        class: "Frigate",
        group_id: 606,
    },
    FactionClass {
        faction: "Blood Raiders",
        class: "Destroyer",
        group_id: 605,
    },
    FactionClass {
        faction: "Blood Raiders",
        class: "Cruiser",
        group_id: 604,
    },
    FactionClass {
        faction: "Blood Raiders",
        class: "Battlecruiser",
        group_id: 602,
    },
    FactionClass {
        faction: "Blood Raiders",
        class: "Battleship",
        group_id: 603,
    },
    FactionClass {
        faction: "Angel Cartel",
        class: "Frigate",
        group_id: 597,
    },
    FactionClass {
        faction: "Angel Cartel",
        class: "Destroyer",
        group_id: 596,
    },
    FactionClass {
        faction: "Angel Cartel",
        class: "Cruiser",
        group_id: 595,
    },
    FactionClass {
        faction: "Angel Cartel",
        class: "Battlecruiser",
        group_id: 593,
    },
    FactionClass {
        faction: "Angel Cartel",
        class: "Battleship",
        group_id: 594,
    },
];

/// Sleeper difficulty family → its Sentinel/Defender/Patroller group ids
/// (real distinct SDE typeIDs per family, unlike Abyssal tiers — see the
/// module doc).
const SLEEPER_GROUPS: &[(&str, &[i64])] = &[
    ("Sleepless", &[959, 982, 983]),
    ("Awakened", &[960, 984, 985]),
    ("Emergent", &[961, 986, 987]),
];

/// Abyssal Spaceship/Drone Entities — every NPC ship spawnable in an Abyssal
/// Deadspace pocket, averaged into one preset (see module doc for why not
/// per-tier).
const ABYSSAL_GROUPS: &[i64] = &[1982, 1997];

fn attr(attrs: &[(i64, f64)], id: i64) -> f64 {
    attrs
        .iter()
        .find(|(a, _)| *a == id)
        .map(|(_, v)| *v)
        .unwrap_or(0.0)
}

/// Incoming damage split `[em, thermal, kinetic, explosive]` fractions for
/// one NPC type: direct weapon-damage attributes when present, else its
/// missile's own damage split (see module doc). `None` for a support/EWAR
/// rat that deals no damage at all.
fn npc_damage_fraction(sde: &Sde, own_attrs: &[(i64, f64)]) -> Option<[f64; 4]> {
    let direct = [
        attr(own_attrs, ATTR_EM_DAMAGE),
        attr(own_attrs, ATTR_THERM_DAMAGE),
        attr(own_attrs, ATTR_KIN_DAMAGE),
        attr(own_attrs, ATTR_EXP_DAMAGE),
    ];
    let raw = if direct.iter().sum::<f64>() > 0.0 {
        direct
    } else {
        let missile_id = attr(own_attrs, ATTR_MISSILE_TYPE) as i64;
        if missile_id <= 0 {
            return None;
        }
        let missile_attrs = sde.type_attributes_raw(missile_id).ok()?;
        [
            attr(&missile_attrs, ATTR_EM_DAMAGE),
            attr(&missile_attrs, ATTR_THERM_DAMAGE),
            attr(&missile_attrs, ATTR_KIN_DAMAGE),
            attr(&missile_attrs, ATTR_EXP_DAMAGE),
        ]
    };
    let total: f64 = raw.iter().sum();
    if total <= 0.0 {
        return None;
    }
    Some([
        raw[0] / total,
        raw[1] / total,
        raw[2] / total,
        raw[3] / total,
    ])
}

/// Average a [`TargetProfile`] + damage split across every member of
/// `type_ids`. `None` when no member has usable sig/velocity data (an empty
/// or purely non-combat group).
fn average_group(sde: &Sde, type_ids: &[i64]) -> Option<(TargetProfile, [f64; 4])> {
    if type_ids.is_empty() {
        return None;
    }
    let attrs_map = sde.types_attributes_raw(type_ids).ok()?;
    let (mut sig_sum, mut vel_sum, mut n) = (0.0, 0.0, 0.0);
    let (mut ang_sum, mut ang_n) = (0.0, 0.0);
    let mut dmg_sum = [0.0; 4];
    let mut dmg_n = 0.0;
    for tid in type_ids {
        let Some(a) = attrs_map.get(tid) else {
            continue;
        };
        let sig = attr(a, ATTR_SIG_RADIUS);
        let vel = attr(a, ATTR_MAX_VELOCITY);
        if sig <= 0.0 || vel <= 0.0 {
            continue; // non-combat / structure entity, not a real ship rat
        }
        sig_sum += sig;
        vel_sum += vel;
        n += 1.0;
        let legacy_range = attr(a, ATTR_ATTACK_RANGE);
        let range = if legacy_range > 0.0 {
            legacy_range
        } else {
            attr(a, ATTR_ORBIT_RANGE_ALT)
        };
        if range > 0.0 {
            let cruise = attr(a, ATTR_CRUISE_SPEED);
            let orbit = if cruise > 0.0 { cruise } else { vel };
            ang_sum += orbit / range;
            ang_n += 1.0;
        }
        if let Some(d) = npc_damage_fraction(sde, a) {
            for i in 0..4 {
                dmg_sum[i] += d[i];
            }
            dmg_n += 1.0;
        }
    }
    if n == 0.0 {
        return None;
    }
    let target = TargetProfile {
        sig_radius: sig_sum / n,
        speed: vel_sum / n,
        angular_velocity: if ang_n > 0.0 { ang_sum / ang_n } else { 0.0 },
        drones_keep_pace: true,
        missiles_need_overtake: false,
    };
    let damage_profile = if dmg_n > 0.0 {
        let mut d = [0.0; 4];
        for i in 0..4 {
            d[i] = dmg_sum[i] / dmg_n;
        }
        let total: f64 = d.iter().sum();
        if total > 0.0 {
            for x in d.iter_mut() {
                *x /= total;
            }
        }
        d
    } else {
        [0.25; 4] // no dealt-damage data at all — omni, matches the existing default
    };
    Some((target, damage_profile))
}

fn slug(s: &str) -> String {
    s.chars()
        .map(|c| {
            if c.is_alphanumeric() {
                c.to_ascii_lowercase()
            } else {
                '-'
            }
        })
        .collect()
}

/// The full built-in library (#873): 25 pirate-faction/hull-class presets +
/// 3 Sleeper difficulty families + 1 Abyssal aggregate. Groups with no
/// resolvable NPC data (a stripped-down test SDE, or a future SDE reshuffle)
/// are silently skipped rather than failing the whole command.
pub fn built_in_profiles(sde: &Sde) -> Vec<NpcProfile> {
    let mut out = Vec::new();

    for fc in PIRATE_FACTION_GROUPS {
        let Ok(members) = sde.universe_types(fc.group_id, false) else {
            continue;
        };
        let type_ids: Vec<i64> = members.into_iter().map(|(id, _)| id).collect();
        if let Some((target, damage_profile)) = average_group(sde, &type_ids) {
            out.push(NpcProfile {
                id: format!("builtin:{}-{}", slug(fc.faction), slug(fc.class)),
                label: format!("{} {}", fc.faction, fc.class),
                group: fc.faction.to_string(),
                target,
                damage_profile,
            });
        }
    }

    for (family, group_ids) in SLEEPER_GROUPS {
        let mut type_ids = Vec::new();
        for gid in *group_ids {
            let Ok(members) = sde.universe_types(*gid, false) else {
                continue;
            };
            type_ids.extend(members.into_iter().map(|(id, _)| id));
        }
        if let Some((target, damage_profile)) = average_group(sde, &type_ids) {
            out.push(NpcProfile {
                id: format!("builtin:sleepers-{}", slug(family)),
                label: format!("Sleepers ({family})"),
                group: "Sleepers".to_string(),
                target,
                damage_profile,
            });
        }
    }

    let mut abyssal_ids = Vec::new();
    for gid in ABYSSAL_GROUPS {
        let Ok(members) = sde.universe_types(*gid, false) else {
            continue;
        };
        abyssal_ids.extend(members.into_iter().map(|(id, _)| id));
    }
    if let Some((target, damage_profile)) = average_group(sde, &abyssal_ids) {
        out.push(NpcProfile {
            id: "builtin:abyssal".to_string(),
            label: "Abyssal Deadspace".to_string(),
            group: "Abyssal".to_string(),
            target,
            damage_profile,
        });
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sde::test_sde;

    /// A tiny two-ship fixture: a turret rat (direct damage attrs) and a
    /// missile rat (zero weapon-damage attrs, damage comes from its ammo).
    fn fixture() -> Sde {
        test_sde(
            "CREATE TABLE invTypes(typeID INT, groupID INT, typeName TEXT, published INT);
             CREATE TABLE dgmTypeAttributes(typeID INT, attributeID INT, valueFloat REAL, valueInt INT);
             CREATE TABLE dgmAttributeTypes(attributeID INT, attributeName TEXT, displayName TEXT, defaultValue REAL, stackable INT, highIsGood INT, published INT);

             INSERT INTO invTypes VALUES (100, 900, 'Turret Rat', 0);
             INSERT INTO invTypes VALUES (101, 900, 'Missile Rat', 0);

             -- Turret rat: sig 100, vel 200, cruise 150 @ range 30000, deals thermal/kinetic directly.
             INSERT INTO dgmTypeAttributes VALUES (100, 552, 100.0, NULL);
             INSERT INTO dgmTypeAttributes VALUES (100, 37, 200.0, NULL);
             INSERT INTO dgmTypeAttributes VALUES (100, 508, 150.0, NULL);
             INSERT INTO dgmTypeAttributes VALUES (100, 247, 30000.0, NULL);
             INSERT INTO dgmTypeAttributes VALUES (100, 118, 6.0, NULL);
             INSERT INTO dgmTypeAttributes VALUES (100, 117, 2.0, NULL);

             -- Missile rat: sig 300, vel 100, no cruise/range, zero weapon damage,
             -- references missile type 200 for its actual damage split.
             INSERT INTO dgmTypeAttributes VALUES (101, 552, 300.0, NULL);
             INSERT INTO dgmTypeAttributes VALUES (101, 37, 100.0, NULL);
             INSERT INTO dgmTypeAttributes VALUES (101, 507, 200.0, NULL);
             INSERT INTO dgmTypeAttributes VALUES (200, 114, 5.0, NULL);
             INSERT INTO dgmTypeAttributes VALUES (200, 116, 5.0, NULL);",
        )
    }

    #[test]
    fn direct_damage_attributes_normalize_to_fractions() {
        let sde = fixture();
        let attrs = sde.type_attributes_raw(100).unwrap();
        let frac = npc_damage_fraction(&sde, &attrs).unwrap();
        // thermal 6, kinetic 2 -> 0.75 / 0.25
        assert!((frac[1] - 0.75).abs() < 1e-9);
        assert!((frac[2] - 0.25).abs() < 1e-9);
        assert_eq!(frac[0], 0.0);
        assert_eq!(frac[3], 0.0);
    }

    #[test]
    fn missile_rat_falls_back_to_its_ammo_damage() {
        let sde = fixture();
        let attrs = sde.type_attributes_raw(101).unwrap();
        let frac = npc_damage_fraction(&sde, &attrs).unwrap();
        // em 5, explosive 5 -> 0.5 / 0.5, read off the referenced missile type.
        assert!((frac[0] - 0.5).abs() < 1e-9);
        assert!((frac[3] - 0.5).abs() < 1e-9);
    }

    #[test]
    fn average_group_derives_angular_velocity_from_cruise_speed_over_range() {
        let sde = fixture();
        let (target, damage) = average_group(&sde, &[100]).unwrap();
        assert_eq!(target.sig_radius, 100.0);
        assert_eq!(target.speed, 200.0);
        // 150 / 30000 = 0.005 rad/s
        assert!((target.angular_velocity - 0.005).abs() < 1e-9);
        assert!((damage[1] - 0.75).abs() < 1e-9);
    }

    #[test]
    fn average_group_falls_back_to_max_velocity_without_cruise_speed() {
        // Ship with no entityCruiseSpeed(508) but a real attack range — angular
        // velocity should derive from maxVelocity instead of defaulting to 0.
        let sde = test_sde(
            "CREATE TABLE invTypes(typeID INT, groupID INT, typeName TEXT, published INT);
             CREATE TABLE dgmTypeAttributes(typeID INT, attributeID INT, valueFloat REAL, valueInt INT);
             CREATE TABLE dgmAttributeTypes(attributeID INT, attributeName TEXT, displayName TEXT, defaultValue REAL, stackable INT, highIsGood INT, published INT);
             INSERT INTO invTypes VALUES (300, 900, 'No Cruise Rat', 0);
             INSERT INTO dgmTypeAttributes VALUES (300, 552, 50.0, NULL);
             INSERT INTO dgmTypeAttributes VALUES (300, 37, 400.0, NULL);
             INSERT INTO dgmTypeAttributes VALUES (300, 247, 20000.0, NULL);",
        );
        let (target, _) = average_group(&sde, &[300]).unwrap();
        assert!((target.angular_velocity - 0.02).abs() < 1e-9);
    }

    #[test]
    fn empty_group_yields_none() {
        let sde = fixture();
        assert!(average_group(&sde, &[]).is_none());
    }
}
