//! The selectable markets to price against — the major trade hubs plus a couple
//! of whole-region options. Pricing one chosen market avoids pulling data for
//! every hub.

use serde::Serialize;

/// A market to value items at: a region, optionally narrowed to one station.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Market {
    pub id: String,
    pub label: String,
    pub region_id: i64,
    /// Station to price at; `None` = the whole region.
    pub station_id: Option<i64>,
}

struct HubDef {
    id: &'static str,
    label: &'static str,
    region_id: i64,
    station_id: Option<i64>,
}

impl HubDef {
    fn to_market(&self) -> Market {
        Market {
            id: self.id.to_string(),
            label: self.label.to_string(),
            region_id: self.region_id,
            station_id: self.station_id,
        }
    }
}

// Station/region ids verified against ESI.
const HUBS: &[HubDef] = &[
    HubDef {
        id: "jita",
        label: "Jita — The Forge",
        region_id: 10000002,
        station_id: Some(60003760),
    },
    HubDef {
        id: "amarr",
        label: "Amarr — Domain",
        region_id: 10000043,
        station_id: Some(60008494),
    },
    HubDef {
        id: "dodixie",
        label: "Dodixie — Sinq Laison",
        region_id: 10000032,
        station_id: Some(60011866),
    },
    HubDef {
        id: "rens",
        label: "Rens — Heimatar",
        region_id: 10000030,
        station_id: Some(60004588),
    },
    HubDef {
        id: "hek",
        label: "Hek — Metropolis",
        region_id: 10000042,
        station_id: Some(60005686),
    },
    HubDef {
        id: "the-forge",
        label: "The Forge (whole region)",
        region_id: 10000002,
        station_id: None,
    },
    HubDef {
        id: "domain",
        label: "Domain (whole region)",
        region_id: 10000043,
        station_id: None,
    },
];

/// All selectable markets, in display order.
pub fn markets() -> Vec<Market> {
    HUBS.iter().map(HubDef::to_market).collect()
}

/// Look up a market by id.
pub fn market_by_id(id: &str) -> Option<Market> {
    HUBS.iter().find(|h| h.id == id).map(HubDef::to_market)
}

/// The default market (Jita).
pub fn default_market() -> Market {
    market_by_id("jita").expect("jita is defined")
}
