//! Public `/universe/*` endpoint wrappers.
//!
//! CCP publishes hourly per-system activity aggregates on unauthenticated
//! endpoints. Feature modules used to hand-roll the fetch + row struct for
//! these (and the copies drifted — see #606); the wrapper here is the one
//! canonical fetch/decode, while callers keep their own caching TTLs and
//! aggregation on top.

use serde::Deserialize;

use super::client::EsiClient;
use super::error::EsiError;

/// One `/universe/system_kills/` row: ship/pod/npc kills in a solar system
/// over the last hour. The kill counts are `#[serde(default)]` because ESI
/// omits fields that are zero on some aggregate rows — a strict decode would
/// fail the whole response over one sparse row.
#[derive(Debug, Clone, Deserialize)]
pub struct SystemKills {
    pub system_id: i64,
    #[serde(default)]
    pub ship_kills: i64,
    #[serde(default)]
    pub pod_kills: i64,
    #[serde(default)]
    pub npc_kills: i64,
}

/// Fetch the hourly per-system kill aggregate (`GET /universe/system_kills/`,
/// public). Goes through the client's conditional cache like every other
/// public read; callers layer their own on-disk TTL caches on top.
pub async fn system_kills(esi: &EsiClient) -> Result<Vec<SystemKills>, EsiError> {
    esi.get_json("/latest/universe/system_kills/", &[]).await
}
