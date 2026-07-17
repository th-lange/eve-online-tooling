#[cfg(test)]
use rusqlite::Connection;
use rusqlite::{params, OptionalExtension};

use super::super::types::WormholeType;
use super::super::SdeError;
use super::Sde;

/// Label a wormhole destination class id (`wormholeClassID` / target-class attr).
/// C1–C6 are the wormhole space classes; 7/8/9 are k-space security bands; the
/// rest are special spaces. Unknown ids pass through as `class {id}`.
pub fn wormhole_class_label(id: i64) -> String {
    match id {
        1..=6 => format!("C{id}"),
        7 => "HS".to_string(),
        8 => "LS".to_string(),
        9 => "NS".to_string(),
        12 => "Thera".to_string(),
        13 => "C13".to_string(),
        14..=18 => "Drifter".to_string(),
        25 => "Pochven".to_string(),
        _ => format!("class {id}"),
    }
}

/// Map a wormhole system's star (sun) type id to its environment effect. Only the
/// six effect-star types match; k-space spectral suns (incl. the *spectral* "Red
/// Giant" sun, id 8) and effect-less holes return `None`. Pure.
pub fn wormhole_effect_name(sun_type_id: i64) -> Option<String> {
    Some(
        match sun_type_id {
            30574 => "Magnetar",
            30575 => "Black Hole",
            30576 => "Red Giant",
            30577 => "Pulsar",
            30669 => "Wolf-Rayet",
            30670 => "Cataclysmic Variable",
            _ => return None,
        }
        .to_string(),
    )
}

impl Sde {
    /// Every wormhole type (`invTypes` group 988) with its physics, read from the
    /// five `dgmTypeAttributes` rows (same correlated-subquery style as
    /// [`decryptors`](Self::decryptors)). Fully offline — no external data.
    ///
    /// Attribute ids (chruker/whtype.info): 1381 target system class, 1382 max
    /// stable time (min), 1383 max stable mass (kg), 1384 mass regen (kg), 1385
    /// max jump mass (kg). K162 has no fixed target class (attr 0/absent) → it's
    /// labelled the generic "exit (variable)" rather than a bogus destination.
    pub fn wormhole_types(&self) -> Result<Vec<WormholeType>, SdeError> {
        let mut stmt = self.conn.prepare(
            "SELECT t.typeID, t.typeName,
               (SELECT valueFloat FROM dgmTypeAttributes WHERE typeID = t.typeID AND attributeID = 1381),
               (SELECT valueFloat FROM dgmTypeAttributes WHERE typeID = t.typeID AND attributeID = 1382),
               (SELECT valueFloat FROM dgmTypeAttributes WHERE typeID = t.typeID AND attributeID = 1383),
               (SELECT valueFloat FROM dgmTypeAttributes WHERE typeID = t.typeID AND attributeID = 1384),
               (SELECT valueFloat FROM dgmTypeAttributes WHERE typeID = t.typeID AND attributeID = 1385)
             FROM invTypes t
             WHERE t.groupID = 988
             ORDER BY t.typeName",
        )?;
        let rows = stmt.query_map([], |row| {
            let raw_class: Option<f64> = row.get(2)?;
            // K162 (and any exit) has class 0/absent → variable destination.
            let dest_class_id = raw_class.map(|c| c as i64).filter(|&c| c != 0).unwrap_or(0);
            Ok(WormholeType {
                type_id: row.get(0)?,
                code: row.get(1)?,
                dest_class_id,
                dest_class_label: if dest_class_id == 0 {
                    "exit (variable)".to_string()
                } else {
                    wormhole_class_label(dest_class_id)
                },
                max_stable_time_min: row.get(3)?,
                max_stable_mass: row.get(4)?,
                mass_regen: row.get(5)?,
                max_jump_mass: row.get(6)?,
            })
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// A wormhole system's environment **effect** (Pulsar/WR/…), derived offline
    /// from its star type. Fuzzwork's classic schema carries `sunTypeID` on
    /// `mapSolarSystems`; newer conversions instead expose the star as a celestial
    /// in `mapDenormalize` (groupID 6 = Sun). We try both so we work across SDE
    /// variants — a missing column/table just falls through to "no effect", never
    /// a wrong one. Only the six effect-star types map to an effect (#314).
    pub fn system_effect(&self, system_id: i64) -> Result<Option<String>, SdeError> {
        let sun = self
            .sun_type_from_mss(system_id)
            .ok()
            .flatten()
            .or_else(|| self.sun_type_from_denorm(system_id).ok().flatten());
        Ok(sun.and_then(wormhole_effect_name))
    }

    fn sun_type_from_mss(&self, system_id: i64) -> rusqlite::Result<Option<i64>> {
        self.conn
            .query_row(
                "SELECT sunTypeID FROM mapSolarSystems WHERE solarSystemID = ?1",
                params![system_id],
                |r| r.get::<_, Option<i64>>(0),
            )
            .optional()
            .map(Option::flatten)
    }

    fn sun_type_from_denorm(&self, system_id: i64) -> rusqlite::Result<Option<i64>> {
        self.conn
            .query_row(
                "SELECT typeID FROM mapDenormalize WHERE solarSystemID = ?1 AND groupID = 6 LIMIT 1",
                params![system_id],
                |r| r.get::<_, Option<i64>>(0),
            )
            .optional()
            .map(Option::flatten)
    }

    /// A hull's `(name, base mass in kg)` from `invTypes` — the input the jump
    /// planner (#303) weighs against a wormhole's max jump mass. Base hull mass;
    /// prop-mod effects on mass are out of scope for the planner.
    pub fn ship_mass(&self, type_id: i64) -> Result<Option<(String, f64)>, SdeError> {
        let mut stmt = self
            .conn
            .prepare("SELECT typeName, mass FROM invTypes WHERE typeID = ?1")?;
        let mut rows = stmt.query(params![type_id])?;
        match rows.next()? {
            Some(r) => Ok(Some((
                r.get(0)?,
                r.get::<_, Option<f64>>(1)?.unwrap_or(0.0),
            ))),
            None => Ok(None),
        }
    }

    /// A J-system's wormhole class, offline. Reads `mapLocationWormholeClasses`
    /// by system id, falling back to the system's region (k-space classes are
    /// keyed at the region level). Lets us cross-check the Anoik.is snapshot (#305).
    pub fn wormhole_system_class(&self, system_id: i64) -> Result<Option<i64>, SdeError> {
        let by_location = |loc: i64| -> Result<Option<i64>, SdeError> {
            let mut stmt = self.conn.prepare(
                "SELECT wormholeClassID FROM mapLocationWormholeClasses WHERE locationID = ?1",
            )?;
            let mut rows = stmt.query(params![loc])?;
            match rows.next()? {
                Some(r) => Ok(Some(r.get(0)?)),
                None => Ok(None),
            }
        };
        if let Some(class) = by_location(system_id)? {
            return Ok(Some(class));
        }
        match self.system_region(system_id)? {
            Some(region) => by_location(region),
            None => Ok(None),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn wormhole_types_read_physics_and_handle_k162() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE invTypes(typeID INT, groupID INT, typeName TEXT, volume REAL);
             CREATE TABLE dgmTypeAttributes(typeID INT, attributeID INT, valueFloat REAL);
             INSERT INTO invTypes VALUES
               (30832, 988, 'N766', 0.0),   -- C2-static (to C2)
               (30371, 988, 'K162', 0.0),   -- generic exit (no target class)
               (99, 55, 'Not A Wormhole', 0.0);
             -- 1381 target class, 1382 stable time, 1383 stable mass, 1384 regen, 1385 jump mass.
             INSERT INTO dgmTypeAttributes VALUES
               (30832, 1381, 2.0), (30832, 1382, 1440.0), (30832, 1383, 2000000000.0),
               (30832, 1384, 0.0), (30832, 1385, 300000000.0),
               (30371, 1382, 1440.0), (30371, 1383, 3000000000.0), (30371, 1385, 1000000000.0);",
        )
        .unwrap();
        let sde = Sde::from_connection(conn);

        let whs = sde.wormhole_types().unwrap();
        // Only group-988 rows, ordered by code (K162 before N766).
        assert_eq!(whs.len(), 2);
        assert_eq!(whs[0].code, "K162");
        assert_eq!(whs[1].code, "N766");

        let n766 = &whs[1];
        assert_eq!(n766.dest_class_id, 2);
        assert_eq!(n766.dest_class_label, "C2");
        assert_eq!(n766.max_jump_mass, Some(300_000_000.0));
        assert_eq!(n766.max_stable_mass, Some(2_000_000_000.0));
        assert_eq!(n766.max_stable_time_min, Some(1440.0));

        // K162: no target class → variable exit, not a bogus destination.
        let k162 = &whs[0];
        assert_eq!(k162.dest_class_id, 0);
        assert_eq!(k162.dest_class_label, "exit (variable)");
        assert_eq!(k162.max_jump_mass, Some(1_000_000_000.0));
    }

    #[test]
    fn wormhole_class_labels() {
        assert_eq!(wormhole_class_label(1), "C1");
        assert_eq!(wormhole_class_label(6), "C6");
        assert_eq!(wormhole_class_label(7), "HS");
        assert_eq!(wormhole_class_label(8), "LS");
        assert_eq!(wormhole_class_label(9), "NS");
        assert_eq!(wormhole_class_label(12), "Thera");
        assert_eq!(wormhole_class_label(25), "Pochven");
        assert_eq!(wormhole_class_label(99), "class 99");
    }

    #[test]
    fn wormhole_effect_maps_only_effect_star_types() {
        assert_eq!(wormhole_effect_name(30577).as_deref(), Some("Pulsar"));
        assert_eq!(wormhole_effect_name(30574).as_deref(), Some("Magnetar"));
        assert_eq!(
            wormhole_effect_name(30670).as_deref(),
            Some("Cataclysmic Variable")
        );
        // The spectral k-space "Sun K5 (Red Giant)" (id 8) is NOT an effect.
        assert_eq!(wormhole_effect_name(8), None);
        assert_eq!(wormhole_effect_name(0), None);
    }

    #[test]
    fn system_effect_reads_sun_type() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE mapSolarSystems(solarSystemID INT, sunTypeID INT);
             INSERT INTO mapSolarSystems VALUES (31000100, 30577), (31000200, 8), (31000300, NULL);",
        )
        .unwrap();
        let sde = Sde::from_connection(conn);
        assert_eq!(
            sde.system_effect(31000100).unwrap().as_deref(),
            Some("Pulsar")
        );
        // Spectral red-giant sun → no wormhole effect.
        assert_eq!(sde.system_effect(31000200).unwrap(), None);
        // No sun / unknown system → None, no error.
        assert_eq!(sde.system_effect(31000300).unwrap(), None);
        assert_eq!(sde.system_effect(39999999).unwrap(), None);
    }

    #[test]
    fn wormhole_system_class_falls_back_to_region() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(
            "CREATE TABLE mapSolarSystems(solarSystemID INT, regionID INT);
             CREATE TABLE mapLocationWormholeClasses(locationID INT, wormholeClassID INT);
             INSERT INTO mapSolarSystems VALUES (31000005, 11000031), (30000142, 10000002);
             -- J-system keyed directly; k-space keyed at the region.
             INSERT INTO mapLocationWormholeClasses VALUES (31000005, 12), (10000002, 7);",
        )
        .unwrap();
        let sde = Sde::from_connection(conn);
        // Thera by direct system id.
        assert_eq!(sde.wormhole_system_class(31000005).unwrap(), Some(12));
        // Jita resolves via its region (The Forge → HS class 7).
        assert_eq!(sde.wormhole_system_class(30000142).unwrap(), Some(7));
        // Unknown system → None.
        assert_eq!(sde.wormhole_system_class(30009999).unwrap(), None);
    }
}
