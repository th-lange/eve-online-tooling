//! Generic hull-class target archetypes for the hover-DPS comparison (#890):
//! four fixed built-in `TargetProfile`s — a Frigate on an Afterburner, a
//! Frigate on a Microwarpdrive, a Cruiser on an Afterburner and a Battleship
//! on an Afterburner, each "high transversal" — distinct from
//! `npc_profiles`'s specific NPC factions: this is "how does my fit
//! perform against a *typical* hull of this class", not any one ship.
//!
//! Data provenance, same discipline as #873 (real SDE data, never Pyfa's
//! tables, method documented inline):
//! - `signatureRadius` (552) and `maxVelocity` (37) average across every
//!   published **Tech I** hull in the SDE's canonical "Frigate"/"Cruiser"/
//!   "Battleship" `invGroups` (ids 25/26/27 — stable EVE-canonical ids, the
//!   same "read a curated `invGroups` id" convention `npc_profiles`'s
//!   `PIRATE_FACTION_GROUPS` uses) via `Sde::modules_in_groups`'s
//!   `metaGroupID` filter (`[1]` = Tech I; a hull with no `invMetaTypes` row
//!   defaults to Tech I too — the SDE's own convention). This is the
//!   "representative T1 hull group per class" the issue asks for: Faction/
//!   Navy/Pirate variants (metaGroup 4) are excluded so a fast, cheap pirate
//!   frigate doesn't skew the "typical" frigate average.
//! - Hull mass reads the dogma `mass` attribute (4) when a hull happens to
//!   carry it, else falls back to `invTypes.mass` — the same fallback
//!   `stats::run_dogma` itself uses for align-time mass, since most hulls
//!   only carry mass on the type row, not as a dogma attribute.
//! - The Afterburner/Microwarpdrive bonus reads real module `speedFactor`
//!   (20) / `speedBoostFactor` (567) off one representative T2 prop mod per
//!   hull size (1MN Afterburner II / 5MN Microwarpdrive II for frigates,
//!   10MN Afterburner II for cruisers, 100MN Afterburner II for
//!   battleships — real, verified SDE type ids) and applies
//!   `engine::navigation::prop_velocity` — the exact formula a player fit's
//!   own prop mod uses.
//!
//! "High transversal": angular velocity = boosted speed ÷ a fixed 500 m
//! orbit distance — inside Stasis Webifier range and well under most turret
//! optimal, the tight brawling orbit a fast tackler or an overheated-AB
//! kiter typically holds against a target that can't push them out. This is
//! a representative **estimate** of "how hard does a fast, close target
//! punish my tracking", not per-fight orbital mechanics — the same
//! expected-value-estimate convention `engine::heat`'s burnout time uses
//! (see that module's doc comment), not exact physics for any one
//! engagement.

use super::engine::navigation::prop_velocity;
use super::types::TargetProfile;
use crate::sde::Sde;

const ATTR_SIG_RADIUS: i64 = 552;
const ATTR_MAX_VELOCITY: i64 = 37;
const ATTR_MASS: i64 = 4;
const ATTR_SPEED_FACTOR: i64 = 20;
const ATTR_SPEED_BOOST_FACTOR: i64 = 567;

/// Canonical SDE `invGroups` ids for the three hull classes this module
/// derives archetypes for (categoryID 6 "Ship").
const FRIGATE_GROUP: i64 = 25;
const CRUISER_GROUP: i64 = 26;
const BATTLESHIP_GROUP: i64 = 27;

/// Tech I `metaGroupID` — a hull with no `invMetaTypes` row is Tech I too
/// (only non-T1 metas get an explicit row, the SDE's own convention, see
/// `Sde::modules_in_groups`'s doc comment).
const META_GROUP_TECH_I: i64 = 1;

/// "1MN Afterburner II" (verified real SDE type id).
const AB_1MN_II: i64 = 438;
/// "5MN Microwarpdrive II" (verified real SDE type id; also the fixture
/// `golden_tests.rs`'s mutated-MWD test uses for the 5MN size).
const MWD_5MN_II: i64 = 440;
/// "10MN Afterburner II" (verified real SDE type id).
const AB_10MN_II: i64 = 12058;
/// "100MN Afterburner II" (verified real SDE type id).
const AB_100MN_II: i64 = 12068;

/// Fixed close-orbit distance (m) the "high transversal" assumption holds
/// every archetype at — see module doc.
const HIGH_TRANSVERSAL_ORBIT_M: f64 = 500.0;

fn attr(attrs: &[(i64, f64)], id: i64) -> f64 {
    attrs
        .iter()
        .find(|(a, _)| *a == id)
        .map(|(_, v)| *v)
        .unwrap_or(0.0)
}

/// One generic hull-class target archetype: a label plus its derived
/// [`TargetProfile`] (see module doc for the derivation). Serializable so
/// the built library can be cached to disk (per SDE generation) between
/// `fitting_simulate` calls, the same way `npc_profiles::built_in_profiles`
/// is cached at the command layer — rebuilding it is a handful of SDE
/// queries, cheap but not free enough to redo on every keystroke.
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
pub(super) struct TargetArchetype {
    pub(super) id: String,
    pub(super) label: String,
    pub(super) target: TargetProfile,
}

/// Average signature radius / max velocity / mass across every published
/// Tech I hull in `group_id`. `None` when the group has no resolvable T1
/// hull (a stripped-down test SDE, or a future SDE reshuffle) — mirrors
/// `npc_profiles::average_group`'s graceful-skip convention.
fn average_t1_hull_class(sde: &Sde, group_id: i64) -> Option<(f64, f64, f64)> {
    let members = sde
        .modules_in_groups(&[group_id], &[META_GROUP_TECH_I])
        .ok()?;
    let type_ids: Vec<i64> = members.into_iter().map(|(id, _)| id).collect();
    if type_ids.is_empty() {
        return None;
    }
    let attrs_map = sde.types_attributes_raw(&type_ids).ok()?;
    let (mut sig_sum, mut vel_sum, mut mass_sum, mut n) = (0.0, 0.0, 0.0, 0.0);
    for tid in &type_ids {
        let Some(a) = attrs_map.get(tid) else {
            continue;
        };
        let sig = attr(a, ATTR_SIG_RADIUS);
        let vel = attr(a, ATTR_MAX_VELOCITY);
        if sig <= 0.0 || vel <= 0.0 {
            continue; // non-combat / structure entity, not a real hull
        }
        let mass_attr = attr(a, ATTR_MASS);
        let mass = if mass_attr > 0.0 {
            mass_attr
        } else {
            sde.ship_mass(*tid)
                .ok()
                .flatten()
                .map(|(_, m)| m)
                .unwrap_or(0.0)
        };
        if mass <= 0.0 {
            continue; // can't derive a prop-mod bonus without mass
        }
        sig_sum += sig;
        vel_sum += vel;
        mass_sum += mass;
        n += 1.0;
    }
    if n == 0.0 {
        return None;
    }
    Some((sig_sum / n, vel_sum / n, mass_sum / n))
}

/// A prop mod's `(speedFactor, speedBoostFactor)` pair, for
/// `engine::navigation::prop_velocity`. Empty (no bonus) if the type is
/// missing from the SDE or carries neither attribute.
fn prop_mod_props(sde: &Sde, type_id: i64) -> Vec<(f64, f64)> {
    let Ok(attrs) = sde.type_attributes_raw(type_id) else {
        return Vec::new();
    };
    let sf = attr(&attrs, ATTR_SPEED_FACTOR);
    let sbf = attr(&attrs, ATTR_SPEED_BOOST_FACTOR);
    if sf > 0.0 && sbf > 0.0 {
        vec![(sf, sbf)]
    } else {
        Vec::new()
    }
}

/// Build one archetype from a class average + its prop mod's bonus.
fn archetype(
    id: &str,
    label: &str,
    sig: f64,
    base_velocity: f64,
    mass: f64,
    props: &[(f64, f64)],
) -> TargetArchetype {
    let boosted_speed = prop_velocity(base_velocity, mass, props);
    TargetArchetype {
        id: id.to_string(),
        label: label.to_string(),
        target: TargetProfile {
            sig_radius: sig,
            speed: boosted_speed,
            angular_velocity: boosted_speed / HIGH_TRANSVERSAL_ORBIT_M,
            drones_keep_pace: true,
            missiles_need_overtake: false,
        },
    }
}

/// The full built-in archetype library (#890): Frigate+AB, Frigate+MWD,
/// Cruiser+AB, Battleship+AB, every one "high transversal" (see module
/// doc). A class with no resolvable T1 hull data is silently skipped
/// rather than failing the whole batch, matching
/// `npc_profiles::built_in_profiles`'s convention.
pub(super) fn built_in_archetypes(sde: &Sde) -> Vec<TargetArchetype> {
    let mut out = Vec::new();

    if let Some((sig, vel, mass)) = average_t1_hull_class(sde, FRIGATE_GROUP) {
        out.push(archetype(
            "builtin:frigate-ab",
            "Frigate (AB, high transversal)",
            sig,
            vel,
            mass,
            &prop_mod_props(sde, AB_1MN_II),
        ));
        out.push(archetype(
            "builtin:frigate-mwd",
            "Frigate (MWD, high transversal)",
            sig,
            vel,
            mass,
            &prop_mod_props(sde, MWD_5MN_II),
        ));
    }

    if let Some((sig, vel, mass)) = average_t1_hull_class(sde, CRUISER_GROUP) {
        out.push(archetype(
            "builtin:cruiser-ab",
            "Cruiser (AB, high transversal)",
            sig,
            vel,
            mass,
            &prop_mod_props(sde, AB_10MN_II),
        ));
    }

    if let Some((sig, vel, mass)) = average_t1_hull_class(sde, BATTLESHIP_GROUP) {
        out.push(archetype(
            "builtin:battleship-ab",
            "Battleship (AB, high transversal)",
            sig,
            vel,
            mass,
            &prop_mod_props(sde, AB_100MN_II),
        ));
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sde::test_sde;

    /// A tiny two-T1-hull + one-Faction-hull frigate fixture, plus a real
    /// AB and MWD module — enough to exercise the T1 filter, the averaging
    /// math and the prop-velocity boost without touching the real SDE.
    fn fixture() -> Sde {
        test_sde(
            "CREATE TABLE invTypes(typeID INT, groupID INT, typeName TEXT, published INT, mass REAL);
             CREATE TABLE invMetaTypes(typeID INT, parentTypeID INT, metaGroupID INT);
             CREATE TABLE dgmTypeAttributes(typeID INT, attributeID INT, valueFloat REAL, valueInt INT);
             CREATE TABLE dgmAttributeTypes(attributeID INT, attributeName TEXT, displayName TEXT, defaultValue REAL, stackable INT, highIsGood INT, published INT);

             -- Frigate group 25: two Tech I hulls + one Faction hull (excluded).
             INSERT INTO invTypes VALUES (900, 25, 'T1 Frig A', 1, 1000000.0);
             INSERT INTO invTypes VALUES (901, 25, 'T1 Frig B', 1, 1200000.0);
             INSERT INTO invTypes VALUES (902, 25, 'Faction Frig', 1, 900000.0);
             INSERT INTO invMetaTypes VALUES (902, 900, 4);
             INSERT INTO dgmTypeAttributes VALUES (900, 552, 30.0, NULL);
             INSERT INTO dgmTypeAttributes VALUES (900, 37, 350.0, NULL);
             INSERT INTO dgmTypeAttributes VALUES (901, 552, 40.0, NULL);
             INSERT INTO dgmTypeAttributes VALUES (901, 37, 370.0, NULL);
             INSERT INTO dgmTypeAttributes VALUES (902, 552, 20.0, NULL);
             INSERT INTO dgmTypeAttributes VALUES (902, 37, 500.0, NULL);

             -- 1MN Afterburner II (438): speedFactor 135, speedBoostFactor 1.5e6.
             INSERT INTO invTypes VALUES (438, 50, '1MN Afterburner II', 1, 0.0);
             INSERT INTO dgmTypeAttributes VALUES (438, 20, 135.0, NULL);
             INSERT INTO dgmTypeAttributes VALUES (438, 567, 1500000.0, NULL);
             -- 5MN Microwarpdrive II (440): speedFactor 510, speedBoostFactor 1.5e6.
             INSERT INTO invTypes VALUES (440, 51, '5MN Microwarpdrive II', 1, 0.0);
             INSERT INTO dgmTypeAttributes VALUES (440, 20, 510.0, NULL);
             INSERT INTO dgmTypeAttributes VALUES (440, 567, 1500000.0, NULL);",
        )
    }

    #[test]
    fn average_t1_hull_class_excludes_faction_variants() {
        let sde = fixture();
        let (sig, vel, mass) = average_t1_hull_class(&sde, FRIGATE_GROUP).unwrap();
        // Only the two Tech I hulls (900, 901) average in; the Faction hull
        // (902, metaGroup 4) is excluded.
        assert!((sig - 35.0).abs() < 1e-9);
        assert!((vel - 360.0).abs() < 1e-9);
        assert!((mass - 1_100_000.0).abs() < 1e-6);
    }

    #[test]
    fn empty_group_yields_none() {
        let sde = fixture();
        assert!(average_t1_hull_class(&sde, CRUISER_GROUP).is_none());
    }

    #[test]
    fn built_in_archetypes_boosts_speed_and_derives_high_transversal() {
        let sde = fixture();
        let archetypes = built_in_archetypes(&sde);
        // Only frigate data exists in the fixture — cruiser/battleship are
        // silently skipped.
        assert_eq!(archetypes.len(), 2);

        let ab = archetypes
            .iter()
            .find(|a| a.id == "builtin:frigate-ab")
            .unwrap();
        assert!((ab.target.sig_radius - 35.0).abs() < 1e-9);
        // prop_velocity(360, 1_100_000, [(135, 1.5e6)])
        // = 360 * (1 + 135*1_500_000/1_100_000/100) = 360 * 2.840909... = 1022.727...
        let expected_ab_speed = 360.0 * (1.0 + 135.0 * 1_500_000.0 / 1_100_000.0 / 100.0);
        assert!((ab.target.speed - expected_ab_speed).abs() < 1e-6);
        assert!((ab.target.angular_velocity - expected_ab_speed / 500.0).abs() < 1e-9);
        assert!(ab.target.drones_keep_pace);
        assert!(!ab.target.missiles_need_overtake);

        let mwd = archetypes
            .iter()
            .find(|a| a.id == "builtin:frigate-mwd")
            .unwrap();
        // MWD's larger speedFactor (510) should boost speed further than the AB.
        assert!(mwd.target.speed > ab.target.speed);
    }

    /// Spot-checks the derived Frigate archetype's sig/speed against the real
    /// bundled SDE's actual Tech I frigate average (hand-computed from
    /// `sde.sqlite` directly: 28 published Tech I frigates, sig ≈ 36.57 m,
    /// maxVelocity ≈ 361.96 m/s — same spot-check convention #873 used).
    /// Skips when `EVE_SDE_PATH` isn't set (CI has no bundled SDE).
    #[test]
    fn real_sde_frigate_average_matches_hand_computed_values() {
        let Some(path) = std::env::var_os("EVE_SDE_PATH") else {
            eprintln!(
                "real_sde_frigate_average_matches_hand_computed_values: EVE_SDE_PATH unset — skipping"
            );
            return;
        };
        let path = std::path::PathBuf::from(&path);
        if !path.exists() {
            eprintln!(
                "real_sde_frigate_average_matches_hand_computed_values: {path:?} missing — skipping"
            );
            return;
        }
        let sde = Sde::open(&path).expect("open bundled SDE");
        let (sig, vel, _mass) = average_t1_hull_class(&sde, FRIGATE_GROUP)
            .expect("real SDE should have Tech I frigate data");
        assert!(
            (sig - 36.571_428_571).abs() < 0.5,
            "frigate avg sig = {sig}, want ~36.57"
        );
        assert!(
            (vel - 361.964_285_71).abs() < 1.0,
            "frigate avg maxVelocity = {vel}, want ~361.96"
        );

        let archetypes = built_in_archetypes(&sde);
        // All four archetypes should resolve against the real SDE.
        assert_eq!(archetypes.len(), 4);
        let ids: Vec<&str> = archetypes.iter().map(|a| a.id.as_str()).collect();
        assert_eq!(
            ids,
            vec![
                "builtin:frigate-ab",
                "builtin:frigate-mwd",
                "builtin:cruiser-ab",
                "builtin:battleship-ab",
            ]
        );
        // Every archetype should carry a real, positive "high transversal"
        // angular velocity derived from its boosted speed.
        for a in &archetypes {
            assert!(a.target.speed > 0.0, "{}: speed should be positive", a.id);
            assert!(
                a.target.angular_velocity > 0.0,
                "{}: angular_velocity should be positive",
                a.id
            );
        }
    }
}
