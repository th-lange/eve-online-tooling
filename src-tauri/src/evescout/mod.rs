//! EVE-Scout (`https://api.eve-scout.com`) — a free, no-auth community service
//! that publishes the *live scanned* Thera and Turnur wormhole connections.
//!
//! EVE itself has no wormhole-connection endpoint (connections are transient and
//! player-scanned), so this is the one public data source that lets us auto-fill
//! part of a chain instead of hand-entering every hole. Two feature modules use
//! it: `wormholes` (import connections into the map) and `route` (find the
//! nearest public wormhole entrance from k-space), so it lives here as a shared
//! service rather than inside either module.
//!
//! We only ever read the `/v2/public/signatures` feed; it refreshes every few
//! minutes, so a short TTL cache keeps us from hammering it on every view.

use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::storage;

const SIGNATURES_URL: &str = "https://api.eve-scout.com/v2/public/signatures";
/// Cache key for the raw signature feed.
const CACHE_KEY: &str = "evescout_signatures";
/// EVE-Scout data is minutes-fresh; 3 minutes is plenty and stays polite.
const TTL_SECS: u64 = 180;

/// One scanned public connection from the EVE-Scout `/v2/public/signatures` feed.
///
/// `out_*` is the hub side (Thera or Turnur), `in_*` is the far end — the k-space
/// system where the wormhole actually sits, which is what a traveller scans down.
/// Unknown JSON fields are ignored (serde default), so the feed can grow without
/// breaking us. Fields we don't consume are omitted.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct TheraSignature {
    /// "wormhole" for a connection; other signature types are skipped.
    pub signature_type: String,
    /// Hub side (Thera / Turnur).
    pub out_system_id: i64,
    pub out_system_name: String,
    /// Signature code on the hub side (may be absent until scanned).
    #[serde(default)]
    pub out_signature: Option<String>,
    /// Far side — the k-space system the hole connects to.
    pub in_system_id: i64,
    pub in_system_name: String,
    #[serde(default)]
    pub in_region_name: Option<String>,
    #[serde(default)]
    pub in_signature: Option<String>,
    /// Wormhole type code (e.g. "K162", "F135").
    #[serde(default)]
    pub wh_type: Option<String>,
    /// Largest hull that fits: "frigate" | "medium" | "large" | "xlarge" | "capital" | "unknown".
    #[serde(default)]
    pub max_ship_size: Option<String>,
    /// Hours until the hole is expected to collapse.
    #[serde(default)]
    pub remaining_hours: Option<f64>,
}

impl TheraSignature {
    /// True for an actual wormhole connection (vs. other signature types).
    pub fn is_wormhole(&self) -> bool {
        self.signature_type.eq_ignore_ascii_case("wormhole")
    }
}

/// Map EVE-Scout's `max_ship_size` string onto the app's jump-mass class
/// ("s"/"m"/"l"/"xl"). Unknown / missing sizes default to "xl" (least
/// restrictive) so we never under-report what can pass. Pure (testable).
pub fn jump_mass_from_ship_size(size: Option<&str>) -> String {
    match size.map(|s| s.to_ascii_lowercase()).as_deref() {
        Some("frigate") => "s",
        Some("medium") => "m",
        Some("large") => "l",
        Some("xlarge") | Some("capital") => "xl",
        _ => "xl",
    }
    .to_string()
}

/// How long past its TTL the cached feed may still serve as a fallback when
/// the live fetch fails. An hour bridges outages without resurrecting
/// long-dead holes (the shortest-lived public connections last hours).
const STALE_FALLBACK_SECS: u64 = 3600;

/// The signature feed plus how fresh it is.
#[derive(Debug, Clone, PartialEq)]
pub struct SignatureFeed {
    pub signatures: Vec<TheraSignature>,
    /// True when the live fetch failed and an expired cache was served —
    /// surface this to the user wherever the data is shown.
    pub stale: bool,
}

/// Fetch the live Thera/Turnur signature feed, served from a ~3 min TTL cache.
/// When the live fetch fails but a recently-expired snapshot exists on disk,
/// the snapshot is served with `stale: true` instead of erroring — a feed blip
/// shouldn't take the whole feature down. Network errors surface as a `String`
/// (the callers are Tauri commands).
///
/// Note: in a sandboxed/proxied environment the EVE-Scout host may be blocked
/// (returns 403); on a normal desktop this is an ordinary outbound HTTPS call.
pub async fn fetch_signatures(dir: &Path) -> Result<SignatureFeed, String> {
    if let Some(cached) = storage::cache_get::<Vec<TheraSignature>>(dir, CACHE_KEY) {
        return Ok(SignatureFeed {
            signatures: cached,
            stale: false,
        });
    }

    match fetch_live().await {
        Ok(sigs) => {
            let _ = storage::cache_put(dir, CACHE_KEY, &sigs, TTL_SECS);
            Ok(SignatureFeed {
                signatures: sigs,
                stale: false,
            })
        }
        Err(e) => {
            storage::cache_get_stale::<Vec<TheraSignature>>(dir, CACHE_KEY, STALE_FALLBACK_SECS)
                .map(|signatures| SignatureFeed {
                    signatures,
                    stale: true,
                })
                .ok_or(e)
        }
    }
}

async fn fetch_live() -> Result<Vec<TheraSignature>, String> {
    let http = crate::esi::http_client_builder()
        .build()
        .map_err(|e| e.to_string())?;
    http.get(SIGNATURES_URL)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A trimmed but representative slice of the `/v2/public/signatures` payload.
    const FIXTURE: &str = r#"[
      {
        "id": 1,
        "signature_type": "wormhole",
        "out_system_id": 31000005,
        "out_system_name": "Thera",
        "out_signature": "ABC",
        "in_system_id": 30002086,
        "in_system_name": "Rancer",
        "in_region_name": "Sinq Laison",
        "in_signature": "XYZ",
        "wh_type": "K162",
        "max_ship_size": "large",
        "wh_exits_outward": true,
        "remaining_hours": 2.5,
        "expires_at": "2026-07-01T12:00:00Z"
      },
      {
        "id": 2,
        "signature_type": "wormhole",
        "out_system_id": 31000005,
        "out_system_name": "Thera",
        "out_signature": null,
        "in_system_id": 30000142,
        "in_system_name": "Jita",
        "in_region_name": "The Forge",
        "in_signature": null,
        "wh_type": "F135",
        "max_ship_size": "frigate",
        "remaining_hours": 10.0
      },
      {
        "id": 3,
        "signature_type": "data",
        "out_system_id": 31000005,
        "out_system_name": "Thera",
        "in_system_id": 30001234,
        "in_system_name": "Somewhere"
      }
    ]"#;

    #[test]
    fn parses_public_signatures_fixture() {
        let sigs: Vec<TheraSignature> = serde_json::from_str(FIXTURE).unwrap();
        assert_eq!(sigs.len(), 3);

        let rancer = &sigs[0];
        assert!(rancer.is_wormhole());
        assert_eq!(rancer.out_system_name, "Thera");
        assert_eq!(rancer.in_system_id, 30002086);
        assert_eq!(rancer.out_signature.as_deref(), Some("ABC"));
        assert_eq!(rancer.in_signature.as_deref(), Some("XYZ"));
        assert_eq!(rancer.max_ship_size.as_deref(), Some("large"));
        assert_eq!(rancer.remaining_hours, Some(2.5));

        // Null sig codes deserialize as None; unknown fields are ignored.
        assert_eq!(sigs[1].out_signature, None);
        // Non-wormhole rows still parse but are filtered by callers.
        assert!(!sigs[2].is_wormhole());
    }

    #[test]
    fn maps_ship_size_to_jump_mass() {
        assert_eq!(jump_mass_from_ship_size(Some("frigate")), "s");
        assert_eq!(jump_mass_from_ship_size(Some("Medium")), "m");
        assert_eq!(jump_mass_from_ship_size(Some("large")), "l");
        assert_eq!(jump_mass_from_ship_size(Some("xlarge")), "xl");
        assert_eq!(jump_mass_from_ship_size(Some("capital")), "xl");
        assert_eq!(jump_mass_from_ship_size(Some("unknown")), "xl");
        assert_eq!(jump_mass_from_ship_size(None), "xl");
    }
}
