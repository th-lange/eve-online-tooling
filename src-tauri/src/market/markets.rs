//! The markets to price against: regions, each with its main trade-hub station.
//! Pricing uses a [`Location`] — a whole region (region average) or one station.

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Station {
    pub id: i64,
    pub name: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Region {
    pub id: i64,
    pub name: String,
    pub stations: Vec<Station>,
}

/// What to price against: a whole region, or a specific station within one.
#[derive(Debug, Clone, Copy)]
pub enum Location {
    Region(i64),
    Station { region_id: i64, station_id: i64 },
}

impl Location {
    /// A stable cache key. Region -> (region, 0); Station -> (0, station).
    pub fn key(&self) -> (i64, i64) {
        match self {
            Location::Region(r) => (*r, 0),
            Location::Station { station_id, .. } => (0, *station_id),
        }
    }

    /// The Fuzzwork query parameter (`region`/`station`) and id.
    pub fn query_param(&self) -> (&'static str, i64) {
        match self {
            Location::Region(r) => ("region", *r),
            Location::Station { station_id, .. } => ("station", *station_id),
        }
    }

    pub fn region_id(&self) -> i64 {
        match self {
            Location::Region(r) => *r,
            Location::Station { region_id, .. } => *region_id,
        }
    }

    pub fn station_id(&self) -> Option<i64> {
        match self {
            Location::Region(_) => None,
            Location::Station { station_id, .. } => Some(*station_id),
        }
    }
}

struct Hub {
    region_id: i64,
    region: &'static str,
    station_id: i64,
    station: &'static str,
}

// Region/station ids verified against ESI.
const HUBS: &[Hub] = &[
    Hub {
        region_id: 10000002,
        region: "The Forge",
        station_id: 60003760,
        station: "Jita IV-4",
    },
    Hub {
        region_id: 10000043,
        region: "Domain",
        station_id: 60008494,
        station: "Amarr VIII",
    },
    Hub {
        region_id: 10000032,
        region: "Sinq Laison",
        station_id: 60011866,
        station: "Dodixie IX",
    },
    Hub {
        region_id: 10000030,
        region: "Heimatar",
        station_id: 60004588,
        station: "Rens VI",
    },
    Hub {
        region_id: 10000042,
        region: "Metropolis",
        station_id: 60005686,
        station: "Hek VIII",
    },
];

/// All selectable regions, each with its hub station.
pub fn regions() -> Vec<Region> {
    HUBS.iter()
        .map(|h| Region {
            id: h.region_id,
            name: h.region.to_string(),
            stations: vec![Station {
                id: h.station_id,
                name: h.station.to_string(),
            }],
        })
        .collect()
}

/// Default region (The Forge / Jita).
pub fn default_region_id() -> i64 {
    10000002
}

/// Build a [`Location`] from a region and optional station.
pub fn resolve_location(region_id: i64, station_id: Option<i64>) -> Location {
    match station_id {
        Some(station_id) => Location::Station {
            region_id,
            station_id,
        },
        None => Location::Region(region_id),
    }
}

/// Human label for a location, e.g. "Jita IV-4 — The Forge" or
/// "The Forge (region average)".
pub fn location_label(region_id: i64, station_id: Option<i64>) -> String {
    let region = HUBS
        .iter()
        .find(|h| h.region_id == region_id)
        .map(|h| h.region)
        .unwrap_or("Unknown region");
    match station_id {
        Some(sid) => {
            let station = HUBS
                .iter()
                .find(|h| h.station_id == sid)
                .map(|h| h.station)
                .unwrap_or("station");
            format!("{station} — {region}")
        }
        None => format!("{region} (region average)"),
    }
}
