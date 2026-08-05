#[cfg(test)]
use rusqlite::Connection;
use rusqlite::{params, OptionalExtension};
use std::collections::HashMap;

use super::super::types::{AttrMeta, EffectMeta, ModifierInfo, ShipLayout};
use super::super::SdeError;
use super::Sde;

impl Sde {
    /// Charges usable in `weapon_type_id`: published types whose group is one of
    /// the weapon's `chargeGroup1..5` (attrs 604, 605, 606, 609, 610 — not a
    /// contiguous range: 607 doesn't exist and 608 is `powerNeed`, unrelated),
    /// whose `chargeSize` (128) matches when the weapon is sized, and that
    /// physically fit its ammo capacity (charge volume ≤ module capacity).
    /// Ordered Tech I → II → Faction then name. Empty when the module takes no
    /// charge. Drives the per-weapon ammo picker.
    pub fn compatible_charges(&self, weapon_type_id: i64) -> Result<Vec<(i64, String)>, SdeError> {
        let mut stmt = self.conn.prepare(
            "SELECT t.typeID, t.typeName
             FROM invTypes t
             WHERE t.published = 1
               AND t.groupID IN (
                 SELECT CAST(valueFloat AS INTEGER) FROM dgmTypeAttributes
                 WHERE typeID = ?1 AND attributeID IN (604, 605, 606, 609, 610)
                   AND valueFloat IS NOT NULL
               )
               -- Fits the ammo capacity (skip when the module records none).
               AND t.volume <= COALESCE(
                 NULLIF((SELECT capacity FROM invTypes WHERE typeID = ?1), 0), 1e30)
               -- Size must match when the weapon is sized (turrets/launchers);
               -- script-takers (no chargeSize) accept any size in the group.
               AND (
                 (SELECT valueFloat FROM dgmTypeAttributes
                  WHERE typeID = ?1 AND attributeID = 128) IS NULL
                 OR (SELECT valueFloat FROM dgmTypeAttributes
                     WHERE typeID = t.typeID AND attributeID = 128)
                    = (SELECT valueFloat FROM dgmTypeAttributes
                       WHERE typeID = ?1 AND attributeID = 128)
               )
             ORDER BY
               COALESCE((SELECT metaGroupID FROM invMetaTypes WHERE typeID = t.typeID), 1),
               t.typeName",
        )?;
        let rows = stmt.query_map(params![weapon_type_id], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Wormhole-class and Pochven-space "environment beacon" effects a fit
    /// can be sitting in: published `groupID = 920` ("Effect Beacon") types
    /// named "Class N \<effect\> Effects" (wormholes, classes 1–6) or "Weak/Strong
    /// Metaliminal \<weather\> Storm" (**Pochven metaliminal storms** — a
    /// nullsec/Pochven mechanic, distinct from Abyssal Deadspace's per-
    /// filament weather, which has no dogma-attribute data in the SDE at
    /// all: it's computed dynamically per pocket instance, not carried by
    /// any static type) — the two naming shapes that actually carry
    /// `shipID`-targeted dogma modifiers (verified against the SDE: e.g.
    /// "Class 1 Pulsar Effects" boosts capacitor recharge and shield HP;
    /// "Strong Metaliminal Electrical Storm" boosts capacitor recharge by
    /// 25%, Weak by 10%). Excludes the unrelated Drifter/SOE/Triglavian/
    /// holiday-event beacons that also live in this group. Drives the
    /// environment selector.
    pub fn environment_effects(&self) -> Result<Vec<(i64, String)>, SdeError> {
        let mut stmt = self.conn.prepare(
            "SELECT typeID, typeName FROM invTypes
             WHERE groupID = 920 AND published = 1
               AND (
                 typeName LIKE 'Class % Effects'
                 OR typeName LIKE 'Weak Metaliminal %'
                 OR typeName LIKE 'Strong Metaliminal %'
               )
               AND typeName NOT LIKE '%Festival%'
             ORDER BY typeName",
        )?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Search published **ships** (category 6) by name substring, capped. For the
    /// fitting hull picker (so it doesn't offer modules/charges/blueprints).
    pub fn search_ships(&self, query: &str, limit: i64) -> Result<Vec<(i64, String)>, SdeError> {
        let pattern = format!("%{}%", query.trim());
        let mut stmt = self.conn.prepare(
            "SELECT t.typeID, t.typeName FROM invTypes t
             JOIN invGroups g ON g.groupID = t.groupID
             WHERE g.categoryID = 6 AND t.published = 1 AND t.typeName LIKE ?1
             ORDER BY LENGTH(t.typeName), t.typeName LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![pattern, limit], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Dogma attributes for a type: (display name, value), published attrs only.
    pub fn type_attributes(&self, type_id: i64) -> Result<Vec<(String, f64)>, SdeError> {
        let mut stmt = self.conn.prepare(
            "SELECT COALESCE(NULLIF(a.displayName, ''), a.attributeName),
                    COALESCE(ta.valueFloat, ta.valueInt)
             FROM dgmTypeAttributes ta
             JOIN dgmAttributeTypes a ON a.attributeID = ta.attributeID
             WHERE ta.typeID = ?1 AND a.published = 1
             ORDER BY a.attributeName",
        )?;
        let rows = stmt.query_map(params![type_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, Option<f64>>(1)?.unwrap_or(0.0),
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// All dogma attributes for a type as `(attributeID, value)`. Unlike
    /// [`type_attributes`](Self::type_attributes) this keys by id and keeps
    /// unpublished attributes, because the fitting engine reads by id (#158).
    pub fn type_attributes_raw(&self, type_id: i64) -> Result<Vec<(i64, f64)>, SdeError> {
        let mut stmt = self.conn.prepare(
            "SELECT attributeID, COALESCE(valueFloat, valueInt)
             FROM dgmTypeAttributes WHERE typeID = ?1",
        )?;
        let rows = stmt.query_map(params![type_id], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, Option<f64>>(1)?.unwrap_or(0.0),
            ))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Batched [`type_attributes_raw`](Self::type_attributes_raw): one query for
    /// many types (a whole fit + its skills), grouped by typeID in Rust. Avoids
    /// the per-item round-trips that resolving a full fit would otherwise need.
    pub fn types_attributes_raw(
        &self,
        type_ids: &[i64],
    ) -> Result<HashMap<i64, Vec<(i64, f64)>>, SdeError> {
        if type_ids.is_empty() {
            return Ok(HashMap::new());
        }
        // Build a `(?, ?, …)` placeholder list — rusqlite has no native array bind.
        let placeholders = vec!["?"; type_ids.len()].join(", ");
        let sql = format!(
            "SELECT typeID, attributeID, COALESCE(valueFloat, valueInt)
             FROM dgmTypeAttributes WHERE typeID IN ({placeholders})",
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(type_ids.iter()), |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, Option<f64>>(2)?.unwrap_or(0.0),
            ))
        })?;
        let mut map: HashMap<i64, Vec<(i64, f64)>> = HashMap::new();
        for row in rows {
            let (type_id, attr_id, value) = row?;
            map.entry(type_id).or_default().push((attr_id, value));
        }
        Ok(map)
    }

    /// The effects attached to a type as `(effectID, isDefault)` from
    /// `dgmTypeEffects` (#159). `isDefault` marks a module's auto-selected
    /// effect (e.g. the charge a launcher fires). Also used by the EFT importer
    /// to classify a module into its slot (#162).
    pub fn type_effects(&self, type_id: i64) -> Result<Vec<(i64, bool)>, SdeError> {
        let mut stmt = self.conn.prepare(
            "SELECT effectID, COALESCE(isDefault, 0) FROM dgmTypeEffects WHERE typeID = ?1",
        )?;
        let rows = stmt.query_map(params![type_id], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)? != 0))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Published modules in the given groups whose meta group is allowed, for
    /// the fitting optimizer (#156). Items with no meta entry count as Tech I
    /// (metaGroup 1). Returns `(type_id, group_id)`.
    pub fn modules_in_groups(
        &self,
        group_ids: &[i64],
        allowed_meta: &[i64],
    ) -> Result<Vec<(i64, i64)>, SdeError> {
        if group_ids.is_empty() || allowed_meta.is_empty() {
            return Ok(Vec::new());
        }
        let gph = vec!["?"; group_ids.len()].join(", ");
        let mph = vec!["?"; allowed_meta.len()].join(", ");
        let sql = format!(
            "SELECT t.typeID, t.groupID
             FROM invTypes t
             LEFT JOIN invMetaTypes mt ON mt.typeID = t.typeID
             WHERE t.groupID IN ({gph}) AND t.published = 1
               AND COALESCE(mt.metaGroupID, 1) IN ({mph})",
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let params: Vec<i64> = group_ids
            .iter()
            .chain(allowed_meta.iter())
            .copied()
            .collect();
        let rows = stmt.query_map(rusqlite::params_from_iter(params.iter()), |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Map of typeID → groupID for the given types (bulk; for the optimizer).
    pub fn types_groups(&self, type_ids: &[i64]) -> Result<HashMap<i64, i64>, SdeError> {
        if type_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let placeholders = vec!["?"; type_ids.len()].join(", ");
        let sql = format!("SELECT typeID, groupID FROM invTypes WHERE typeID IN ({placeholders})");
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(type_ids.iter()), |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
        })?;
        rows.collect::<Result<HashMap<_, _>, _>>()
            .map_err(Into::into)
    }

    /// Map of typeID → categoryID for the given types (bulk; avoids per-id
    /// `type_category` round-trips in loops like the pvp report and fitting
    /// charge classifier).
    pub fn types_categories(&self, type_ids: &[i64]) -> Result<HashMap<i64, i64>, SdeError> {
        if type_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let placeholders = vec!["?"; type_ids.len()].join(", ");
        let sql = format!(
            "SELECT t.typeID, g.categoryID FROM invTypes t
             JOIN invGroups g ON g.groupID = t.groupID
             WHERE t.typeID IN ({placeholders})"
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(type_ids.iter()), |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
        })?;
        rows.collect::<Result<HashMap<_, _>, _>>()
            .map_err(Into::into)
    }

    /// Published Skill (category 16) type ids — the "all V" skill set the
    /// fitting engine applies (#172).
    pub fn skill_type_ids(&self) -> Result<Vec<i64>, SdeError> {
        let mut stmt = self.conn.prepare(
            "SELECT t.typeID FROM invTypes t
             JOIN invGroups g ON g.groupID = t.groupID
             WHERE g.categoryID = 16 AND t.published = 1",
        )?;
        let rows = stmt.query_map([], |r| r.get::<_, i64>(0))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Batched [`type_effects`](Self::type_effects): effect ids per type for many
    /// types at once (the fit + all skills), keyed by typeID (#172).
    pub fn types_effects(&self, type_ids: &[i64]) -> Result<HashMap<i64, Vec<i64>>, SdeError> {
        if type_ids.is_empty() {
            return Ok(HashMap::new());
        }
        let placeholders = vec!["?"; type_ids.len()].join(", ");
        let sql = format!(
            "SELECT typeID, effectID FROM dgmTypeEffects WHERE typeID IN ({placeholders})",
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(type_ids.iter()), |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
        })?;
        let mut map: HashMap<i64, Vec<i64>> = HashMap::new();
        for row in rows {
            let (type_id, effect_id) = row?;
            map.entry(type_id).or_default().push(effect_id);
        }
        Ok(map)
    }

    /// Every dogma effect with its parsed `modifierInfo`, keyed by effectID
    /// (#159). `dgmExpressions` is empty in the Fuzzwork dump, so `modifierInfo`
    /// is the engine's structured modifier source. A malformed payload is logged
    /// and skipped rather than failing the whole map.
    pub fn effect_meta(&self) -> Result<HashMap<i64, EffectMeta>, SdeError> {
        let mut stmt = self.conn.prepare(
            "SELECT effectID, effectName, effectCategory, isOffensive, isAssistance,
                    durationAttributeID, dischargeAttributeID, rangeAttributeID,
                    falloffAttributeID, trackingSpeedAttributeID, modifierInfo
             FROM dgmEffects",
        )?;
        let rows = stmt.query_map([], |r| {
            let meta = EffectMeta {
                effect_id: r.get(0)?,
                name: r.get::<_, Option<String>>(1)?.unwrap_or_default(),
                category: r.get::<_, Option<i64>>(2)?.unwrap_or(0),
                is_offensive: r.get::<_, Option<i64>>(3)?.unwrap_or(0) != 0,
                is_assistance: r.get::<_, Option<i64>>(4)?.unwrap_or(0) != 0,
                duration_attribute_id: r.get(5)?,
                discharge_attribute_id: r.get(6)?,
                range_attribute_id: r.get(7)?,
                falloff_attribute_id: r.get(8)?,
                tracking_speed_attribute_id: r.get(9)?,
                modifiers: Vec::new(),
            };
            let modifier_json: Option<String> = r.get(10)?;
            Ok((meta, modifier_json))
        })?;
        let mut map = HashMap::new();
        for row in rows {
            let (mut meta, modifier_json) = row?;
            if let Some(json) = modifier_json.filter(|s| !s.trim().is_empty()) {
                match serde_json::from_str::<Vec<ModifierInfo>>(&json) {
                    Ok(mods) => meta.modifiers = mods,
                    Err(e) => {
                        eprintln!(
                            "effect {} has unparseable modifierInfo: {e}",
                            meta.effect_id
                        )
                    }
                }
            }
            map.insert(meta.effect_id, meta);
        }
        Ok(map)
    }

    /// Per-attribute metadata from `dgmAttributeTypes`, keyed by attributeID
    /// (#159). `stackable`/`highIsGood` drive the stacking-penalty logic.
    pub fn attribute_defaults(&self) -> Result<HashMap<i64, AttrMeta>, SdeError> {
        let mut stmt = self.conn.prepare(
            "SELECT attributeID, COALESCE(defaultValue, 0), COALESCE(stackable, 1),
                    COALESCE(highIsGood, 1)
             FROM dgmAttributeTypes",
        )?;
        let rows = stmt.query_map([], |r| {
            Ok(AttrMeta {
                attribute_id: r.get(0)?,
                default_value: r.get::<_, f64>(1)?,
                stackable: r.get::<_, i64>(2)? != 0,
                high_is_good: r.get::<_, i64>(3)? != 0,
            })
        })?;
        let mut map = HashMap::new();
        for row in rows {
            let meta = row?;
            map.insert(meta.attribute_id, meta);
        }
        Ok(map)
    }

    /// A ship hull's slot layout + fitting resources for the editor (#160).
    /// Reads the relevant dogma attributes by id (verified against the SDE);
    /// `None` if the type doesn't exist.
    pub fn ship_layout(&self, type_id: i64) -> Result<Option<ShipLayout>, SdeError> {
        let found: Option<(String, String, i64)> = self
            .conn
            .query_row(
                "SELECT t.typeName, COALESCE(g.groupName, ''), COALESCE(t.groupID, 0)
                 FROM invTypes t LEFT JOIN invGroups g ON g.groupID = t.groupID
                 WHERE t.typeID = ?1",
                params![type_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .optional()?;
        let Some((name, group_name, group_id)) = found else {
            return Ok(None);
        };
        // attributeID -> value for this hull; missing attributes default to 0.
        let attrs: HashMap<i64, f64> = self.type_attributes_raw(type_id)?.into_iter().collect();
        let a = |id: i64| attrs.get(&id).copied().unwrap_or(0.0);
        Ok(Some(ShipLayout {
            type_id,
            name,
            group_name,
            high_slots: a(14) as i64,           // hiSlots
            mid_slots: a(13) as i64,            // medSlots
            low_slots: a(12) as i64,            // lowSlots
            rig_slots: a(1137) as i64,          // rigSlots
            subsystem_slots: a(1367) as i64,    // maxSubSystems
            // Tactical Destroyers (groupID 1305) have exactly 1 mode slot.
            mode_slots: (group_id == 1305) as i64,
            turret_hardpoints: a(102) as i64,   // turretSlotsLeft
            launcher_hardpoints: a(101) as i64, // launcherSlotsLeft
            cpu_output: a(48),                  // cpuOutput
            powergrid_output: a(11),            // powerOutput
            calibration: a(1132),               // upgradeCapacity
            drone_bay: a(283),                  // droneCapacity
            drone_bandwidth: a(1271),           // droneBandwidth
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_only_loadable_charges() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE invTypes(typeID INT, typeName TEXT, groupID INT, published INT, volume REAL, capacity REAL);
             CREATE TABLE dgmTypeAttributes(typeID INT, attributeID INT, valueFloat REAL);
             CREATE TABLE invMetaTypes(typeID INT, parentTypeID INT, metaGroupID INT);

             -- Weapon 100: chargeGroup1=83, chargeSize=2 (medium), capacity 1.5.
             INSERT INTO invTypes VALUES (100,'220mm AutoCannon',55,1,5.0,1.5);
             INSERT INTO dgmTypeAttributes VALUES (100,604,83.0),(100,128,2.0);

             -- Charges: right group+size+fits; right group wrong size; wrong group;
             -- right but too big; right but unpublished.
             INSERT INTO invTypes VALUES
               (1,'EMP M',83,1,0.0125,0),
               (2,'Phased Plasma M T2',83,1,0.0125,0),
               (3,'EMP S',83,1,0.0125,0),   -- wrong size (1)
               (4,'Mining Crystal',600,1,0.0125,0), -- wrong group
               (5,'Huge Charge',83,1,99.0,0),       -- too big for capacity
               (6,'Unpublished M',83,0,0.0125,0);   -- unpublished
             INSERT INTO dgmTypeAttributes VALUES
               (1,128,2.0),(2,128,2.0),(3,128,1.0),(5,128,2.0),(6,128,2.0);
             INSERT INTO invMetaTypes VALUES (2,1,2); -- T2 sorts after T1",
        )
        .unwrap();
        let sde = Sde::from_connection(conn);

        let charges = sde.compatible_charges(100).unwrap();
        let names: Vec<_> = charges.iter().map(|(_, n)| n.as_str()).collect();
        // Only the right-group, right-size, fitting, published charges — T1 then T2.
        assert_eq!(names, vec!["EMP M", "Phased Plasma M T2"]);

        // A module with no chargeGroup attrs takes no charge.
        assert!(sde.compatible_charges(1).unwrap().is_empty());
    }

    #[test]
    fn finds_charges_in_charge_group_4() {
        // Regression test (#T2-ammo-bug): the launcher stores its Advanced
        // (T2) ammo group in chargeGroup4 (attribute 609), not a contiguous
        // 604..608 range — 607 doesn't exist and 608 is `powerNeed`,
        // unrelated. A Rapid Light Missile Launcher II-shaped fixture: T1
        // ammo in chargeGroup1 (604), T2 "Fury" ammo in a second group
        // (chargeGroup4, 609) — both must come back.
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE invTypes(typeID INT, typeName TEXT, groupID INT, published INT, volume REAL, capacity REAL);
             CREATE TABLE dgmTypeAttributes(typeID INT, attributeID INT, valueFloat REAL);
             CREATE TABLE invMetaTypes(typeID INT, parentTypeID INT, metaGroupID INT);

             -- Launcher: chargeGroup1=384 (Light Missile), chargeGroup4=653
             -- (Advanced Light Missile), no chargeSize (unsized, like real RLML).
             INSERT INTO invTypes VALUES (1877,'Rapid Light Missile Launcher II',511,1,10.0,0.3);
             INSERT INTO dgmTypeAttributes VALUES (1877,604,384.0),(1877,609,653.0);

             INSERT INTO invTypes VALUES
               (2629,'Scourge Light Missile',384,1,0.03,0),
               (24495,'Scourge Fury Light Missile',653,1,0.015,0);
             INSERT INTO invMetaTypes VALUES (24495,2629,2)",
        )
        .unwrap();
        let sde = Sde::from_connection(conn);

        let charges = sde.compatible_charges(1877).unwrap();
        let names: Vec<_> = charges.iter().map(|(_, n)| n.as_str()).collect();
        assert_eq!(
            names,
            vec!["Scourge Light Missile", "Scourge Fury Light Missile"]
        );
    }

    #[test]
    fn finds_wormhole_and_pochven_storm_environment_beacons_only() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE invTypes(typeID INT, typeName TEXT, groupID INT, published INT, volume REAL, capacity REAL);

             -- Matches: a wormhole class effect and a Pochven metaliminal storm tier.
             INSERT INTO invTypes VALUES
               (30844,'Class 1 Pulsar Effects',920,1,20,0),
               (56061,'Strong Metaliminal Gamma Ray Storm',920,1,20,0);
             -- Non-matches: unpublished, wrong group, and an unrelated group-920
             -- beacon (Drifter/holiday-event) whose name doesn't fit either shape.
             INSERT INTO invTypes VALUES
               (37542,'Tournament Effects',920,0,20,0),
               (99999,'Class 1 Pulsar Effects (unpublished dupe)',921,1,20,0),
               (56968,'Strong Lowsec Metaliminal Yoiul Festival YC122 Storm',920,1,20,0);",
        )
        .unwrap();
        let sde = Sde::from_connection(conn);

        let names: Vec<_> = sde
            .environment_effects()
            .unwrap()
            .into_iter()
            .map(|(_, n)| n)
            .collect();
        assert_eq!(
            names,
            vec!["Class 1 Pulsar Effects", "Strong Metaliminal Gamma Ray Storm"]
        );
    }

    /// A tiny dogma fixture: a hull (587) with slots/resources and a module
    /// (519) with a raw+published attribute and a default effect.
    /// attribute/effect metadata tables. Mirrors the real SDE shapes (#158–#160).
    fn dogma_fixture() -> Sde {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE invTypes(typeID INT, groupID INT, typeName TEXT, volume REAL, published INT);
             CREATE TABLE invGroups(groupID INT, groupName TEXT);
             CREATE TABLE dgmTypeAttributes(typeID INT, attributeID INT, valueFloat REAL, valueInt INT);
             CREATE TABLE dgmAttributeTypes(attributeID INT, attributeName TEXT, defaultValue REAL, stackable INT, highIsGood INT);
             CREATE TABLE dgmTypeEffects(typeID INT, effectID INT, isDefault INT);
             CREATE TABLE dgmEffects(effectID INT, effectName TEXT, effectCategory INT, isOffensive INT, isAssistance INT, durationAttributeID INT, dischargeAttributeID INT, rangeAttributeID INT, falloffAttributeID INT, trackingSpeedAttributeID INT, modifierInfo TEXT);

             INSERT INTO invTypes VALUES (587, 25, 'Rifter', 27.0, 1), (519, 60, 'Gyrostabilizer II', 5.0, 1);
             INSERT INTO invGroups VALUES (25, 'Frigate'), (60, 'Damage Control');
             INSERT INTO dgmTypeAttributes(typeID, attributeID, valueFloat) VALUES
               (587,14,3),(587,13,3),(587,12,4),(587,1137,3),(587,102,3),(587,101,2),
               (587,48,130),(587,11,41),(587,1132,400),(587,283,0),(587,1271,0),
               (519,64,1.1);
             INSERT INTO dgmAttributeTypes VALUES
               (64,'damageMultiplier',1.0,0,1),
               (48,'cpuOutput',0.0,1,1);
             INSERT INTO dgmTypeEffects VALUES (519, 92, 1);
             INSERT INTO dgmEffects VALUES
               (92,'projectileWeaponDamageMultiply',1,0,0,NULL,NULL,NULL,NULL,NULL,
                '[{\"domain\": \"shipID\", \"func\": \"LocationGroupModifier\", \"groupID\": 55, \"modifiedAttributeID\": 64, \"modifyingAttributeID\": 64, \"operation\": 4}]'),
               (16,'online',0,0,0,NULL,NULL,NULL,NULL,NULL,NULL);",
        )
        .unwrap();
        Sde::from_connection(conn)
    }

    #[test]
    fn raw_attributes_by_id_single_and_batch() {
        let sde = dogma_fixture();
        let single: HashMap<i64, f64> = sde.type_attributes_raw(587).unwrap().into_iter().collect();
        assert_eq!(single.get(&14), Some(&3.0));
        assert_eq!(single.get(&48), Some(&130.0));

        let batch = sde.types_attributes_raw(&[587, 519]).unwrap();
        assert_eq!(batch.len(), 2);
        assert!(batch[&519]
            .iter()
            .any(|&(id, v)| id == 64 && (v - 1.1).abs() < 1e-9));
        assert!(sde.types_attributes_raw(&[]).unwrap().is_empty());
    }

    #[test]
    fn type_effects_and_effect_meta_parse_modifier_info() {
        let sde = dogma_fixture();
        assert_eq!(sde.type_effects(519).unwrap(), vec![(92, true)]);

        let meta = sde.effect_meta().unwrap();
        let dmg = meta.get(&92).unwrap();
        assert_eq!(dmg.name, "projectileWeaponDamageMultiply");
        assert_eq!(dmg.modifiers.len(), 1);
        let m = &dmg.modifiers[0];
        assert_eq!(m.func.as_deref(), Some("LocationGroupModifier"));
        assert_eq!(m.group_id, Some(55));
        assert_eq!(m.modified_attribute_id, Some(64));
        assert_eq!(m.operation, Some(4));
        // An effect with no modifierInfo parses to zero modifiers.
        assert!(meta.get(&16).unwrap().modifiers.is_empty());
    }

    #[test]
    fn attribute_defaults_expose_stacking_flags() {
        let sde = dogma_fixture();
        let defs = sde.attribute_defaults().unwrap();
        let dmg = defs.get(&64).unwrap();
        assert_eq!(dmg.default_value, 1.0);
        assert!(!dmg.stackable); // stackable = 0 -> penalized
        assert!(dmg.high_is_good);
    }

    #[test]
    fn ship_layout_reads_slots_and_resources() {
        let sde = dogma_fixture();
        let layout = sde.ship_layout(587).unwrap().unwrap();
        assert_eq!(layout.name, "Rifter");
        assert_eq!(layout.group_name, "Frigate");
        assert_eq!(layout.high_slots, 3);
        assert_eq!(layout.mid_slots, 3);
        assert_eq!(layout.low_slots, 4);
        assert_eq!(layout.rig_slots, 3);
        assert_eq!(layout.turret_hardpoints, 3);
        assert_eq!(layout.launcher_hardpoints, 2);
        assert_eq!(layout.cpu_output, 130.0);
        assert_eq!(layout.powergrid_output, 41.0);
        assert_eq!(layout.calibration, 400.0);
        assert!(sde.ship_layout(424242).unwrap().is_none());
    }
}
