use rusqlite::params;
use std::collections::HashMap;

use super::super::types::SystemInfo;
use super::super::SdeError;
use super::Sde;

/// A solar system's `(regionID, x, y, z)` — region id plus 3D metre coordinates.
pub type SystemGeo = (i64, f64, f64, f64);

impl Sde {
    /// Search solar systems by name substring (case-insensitive), capped. For
    /// the route neighbourhood picker.
    pub fn search_systems(&self, query: &str, limit: i64) -> Result<Vec<(i64, String)>, SdeError> {
        let pattern = format!("%{}%", query.trim());
        let mut stmt = self.conn.prepare(
            "SELECT solarSystemID, solarSystemName FROM mapSolarSystems
             WHERE solarSystemName LIKE ?1
             ORDER BY LENGTH(solarSystemName), solarSystemName LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![pattern, limit], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Search NPC stations by name `(id, name)`, shortest-name-first. Player
    /// structures aren't in the SDE, so they're not searchable here.
    pub fn search_stations(&self, query: &str, limit: i64) -> Result<Vec<(i64, String)>, SdeError> {
        let pattern = format!("%{}%", query.trim());
        let mut stmt = self.conn.prepare(
            "SELECT stationID, stationName FROM staStations
             WHERE stationName LIKE ?1
             ORDER BY LENGTH(stationName), stationName LIMIT ?2",
        )?;
        let rows = stmt.query_map(params![pattern, limit], |r| Ok((r.get(0)?, r.get(1)?)))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// The `(solar_system_id, region_id)` an NPC station sits in, if known.
    pub fn station_location(&self, station_id: i64) -> Result<Option<(i64, i64)>, SdeError> {
        let mut stmt = self
            .conn
            .prepare("SELECT solarSystemID, regionID FROM staStations WHERE stationID = ?1")?;
        let mut rows = stmt.query(params![station_id])?;
        match rows.next()? {
            Some(r) => Ok(Some((r.get(0)?, r.get(1)?))),
            None => Ok(None),
        }
    }

    /// The region a solar system belongs to, if known.
    pub fn system_region(&self, system_id: i64) -> Result<Option<i64>, SdeError> {
        let mut stmt = self
            .conn
            .prepare("SELECT regionID FROM mapSolarSystems WHERE solarSystemID = ?1")?;
        let mut rows = stmt.query(params![system_id])?;
        match rows.next()? {
            Some(r) => Ok(Some(r.get(0)?)),
            None => Ok(None),
        }
    }

    /// A single solar system's name, security and region (id + name), via one
    /// join — the point-lookup counterpart to
    /// [`solar_system_info`](Self::solar_system_info), for call sites that
    /// only need one system and shouldn't pay for a full-map load.
    pub fn system_info(&self, system_id: i64) -> Result<Option<SystemInfo>, SdeError> {
        let mut stmt = self.conn.prepare(
            "SELECT s.solarSystemName, s.security, s.regionID, r.regionName
             FROM mapSolarSystems s
             LEFT JOIN mapRegions r ON r.regionID = s.regionID
             WHERE s.solarSystemID = ?1",
        )?;
        let mut rows = stmt.query(params![system_id])?;
        match rows.next()? {
            Some(r) => Ok(Some(SystemInfo {
                name: r.get(0)?,
                security: r.get::<_, Option<f64>>(1)?.unwrap_or(0.0),
                region_id: r.get::<_, Option<i64>>(2)?.unwrap_or(0),
                region_name: r.get::<_, Option<String>>(3)?.unwrap_or_default(),
            })),
            None => Ok(None),
        }
    }

    /// Stargate edges `(from, to)` whose source is one of `ids` — for building a
    /// system neighbourhood by BFS. K-space only (wormhole systems have no
    /// stargates). One query; the caller walks levels.
    pub fn stargate_edges_from(&self, ids: &[i64]) -> Result<Vec<(i64, i64)>, SdeError> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let placeholders = vec!["?"; ids.len()].join(", ");
        let sql = format!(
            "SELECT fromSolarSystemID, toSolarSystemID FROM mapSolarSystemJumps
             WHERE fromSolarSystemID IN ({placeholders})",
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(ids.iter()), |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?))
        })?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// NPC station names for the given station ids (from `staStations`). Player
    /// structures (citadels) aren't in the SDE, so they're simply absent and the
    /// caller falls back to a generic label.
    pub fn station_names(&self, ids: &[i64]) -> Result<HashMap<i64, String>, SdeError> {
        if ids.is_empty() {
            return Ok(HashMap::new());
        }
        let placeholders = vec!["?"; ids.len()].join(", ");
        let sql = format!(
            "SELECT stationID, stationName FROM staStations WHERE stationID IN ({placeholders})",
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(ids.iter()), |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?))
        })?;
        let mut map = HashMap::new();
        for row in rows {
            let (id, name) = row?;
            map.insert(id, name);
        }
        Ok(map)
    }

    /// NPC station info (name + solar system id) for the given station ids.
    /// Player structures (citadels) aren't in the SDE and are absent from the result.
    pub fn station_infos(&self, ids: &[i64]) -> Result<HashMap<i64, (String, i64)>, SdeError> {
        if ids.is_empty() {
            return Ok(HashMap::new());
        }
        let placeholders = vec!["?"; ids.len()].join(", ");
        let sql = format!(
            "SELECT stationID, stationName, solarSystemID FROM staStations WHERE stationID IN ({placeholders})",
        );
        let mut stmt = self.conn.prepare(&sql)?;
        let rows = stmt.query_map(rusqlite::params_from_iter(ids.iter()), |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })?;
        let mut map = HashMap::new();
        for row in rows {
            let (id, name, sys_id) = row?;
            map.insert(id, (name, sys_id));
        }
        Ok(map)
    }

    /// Every stargate edge `(from, to)` in known space — the full adjacency for
    /// in-memory route BFS (~13k rows). Cross-chain routing unions wormhole
    /// connections onto this.
    pub fn all_stargate_edges(&self) -> Result<Vec<(i64, i64)>, SdeError> {
        let mut stmt = self
            .conn
            .prepare("SELECT fromSolarSystemID, toSolarSystemID FROM mapSolarSystemJumps")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))?;
        rows.collect::<Result<Vec<_>, _>>().map_err(Into::into)
    }

    /// Undirected stargate adjacency, keyed by solar system id — the
    /// in-memory graph [`sde::graph`](crate::sde::graph) BFS utilities walk.
    /// Built from [`all_stargate_edges`](Self::all_stargate_edges), which
    /// reads `mapSolarSystemJumps`; that table already stores **both**
    /// directions of every gate connection (a `(from, to)` row and its
    /// `(to, from)` mirror), so each edge is added to the map twice over —
    /// once per direction's own `(a, b)` pair. That's harmless for BFS
    /// correctness (a duplicate neighbour is just visited and skipped a
    /// second time), so this does **not** deduplicate; doing so would only
    /// add work for no behavioural change.
    pub fn stargate_adjacency(&self) -> Result<HashMap<i64, Vec<i64>>, SdeError> {
        Ok(crate::sde::graph::undirected_adjacency(
            &self.all_stargate_edges()?,
        ))
    }

    /// Map of solar system id -> (name, security, region name). For the route /
    /// system-activity view. `security` is the raw SDE float (−1.0 … 1.0).
    pub fn solar_system_info(&self) -> Result<HashMap<i64, (String, f64, String)>, SdeError> {
        let mut stmt = self.conn.prepare(
            "SELECT s.solarSystemID, s.solarSystemName, s.security, r.regionName
             FROM mapSolarSystems s
             LEFT JOIN mapRegions r ON r.regionID = s.regionID",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                (
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<f64>>(2)?.unwrap_or(0.0),
                    row.get::<_, Option<String>>(3)?.unwrap_or_default(),
                ),
            ))
        })?;
        let mut map = HashMap::new();
        for row in rows {
            let (id, info) = row?;
            map.insert(id, info);
        }
        Ok(map)
    }

    /// Galactic map-plane coordinates `(x, z)` for every solar system. EVE's
    /// star map is the x/z plane (y is height above it), so these plot a
    /// top-down map. Used to seed the faction-warfare map layout.
    pub fn solar_system_positions(&self) -> Result<HashMap<i64, (f64, f64)>, SdeError> {
        let mut stmt = self
            .conn
            .prepare("SELECT solarSystemID, x, z FROM mapSolarSystems")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                (
                    r.get::<_, Option<f64>>(1)?.unwrap_or(0.0),
                    r.get::<_, Option<f64>>(2)?.unwrap_or(0.0),
                ),
            ))
        })?;
        rows.collect::<Result<HashMap<_, _>, _>>()
            .map_err(Into::into)
    }

    /// Full 3D galactic coordinates `(regionID, x, y, z)` in metres per solar
    /// system — for true light-year distances (e.g. filament range). `y` is the
    /// height off the map plane, which matters for distance.
    pub fn solar_system_geo(&self) -> Result<HashMap<i64, SystemGeo>, SdeError> {
        let mut stmt = self
            .conn
            .prepare("SELECT solarSystemID, regionID, x, y, z FROM mapSolarSystems")?;
        let rows = stmt.query_map([], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                (
                    r.get::<_, i64>(1)?,
                    r.get::<_, Option<f64>>(2)?.unwrap_or(0.0),
                    r.get::<_, Option<f64>>(3)?.unwrap_or(0.0),
                    r.get::<_, Option<f64>>(4)?.unwrap_or(0.0),
                ),
            ))
        })?;
        rows.collect::<Result<HashMap<_, _>, _>>()
            .map_err(Into::into)
    }

    /// Map of solar system id -> name (for mining ledger / fleet).
    pub fn system_names(&self) -> Result<HashMap<i64, String>, SdeError> {
        let mut stmt = self
            .conn
            .prepare("SELECT solarSystemID, solarSystemName FROM mapSolarSystems")?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?;
        rows.collect::<Result<HashMap<_, _>, _>>()
            .map_err(Into::into)
    }
}
