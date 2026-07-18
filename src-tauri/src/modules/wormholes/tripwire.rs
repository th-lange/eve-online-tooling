//! Tripwire (the collaborative wormhole mapper) import (#302) — **opt-in**.
//!
//! Tripwire's third-party API (`public/api.php` → `api/auth.php`) is HTTP **Basic
//! Auth** only (username + password; no SSO/token path), routed as
//! `GET {base}/api.php?q=/wormholes|/signatures&maskID=<mask>`. This module holds
//! the opt-in config, the fetch, the raw row types, and the mass→class mapping.
//! Turning a Tripwire chain into our `Connection`s lives in `commands.rs` (where
//! `Connection` is defined), reusing the same merge/dedupe as the EVE-Scout import.
//!
//! Nothing here runs unless a user explicitly connects — with no stored config,
//! the whole feature is inert.

use serde::{Deserialize, Serialize};

use crate::esi::USER_AGENT;

/// The public hosted instance (overridable for self-hosters).
pub const DEFAULT_BASE_URL: &str = "https://tripwire.eve-apps.com";
/// Storage keys for the (non-secret) config and the keychain password.
pub const CONFIG_KEY: &str = "tripwire_config";
pub const SECRET_KEY: &str = "tripwire_password";

/// Opt-in Tripwire connection settings (password is kept in the OS keychain, not
/// here). `mask` overrides the default personal mask (`<characterId>.1`).
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TripwireConfig {
    pub base_url: String,
    pub username: String,
    #[serde(default)]
    pub mask: Option<String>,
}

/// Accept an integer that MySQL/PDO may serialize as a JSON string or a number.
fn de_opt_i64<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Option<i64>, D::Error> {
    use serde::Deserialize as _;
    match Option::<serde_json::Value>::deserialize(d)? {
        None | Some(serde_json::Value::Null) => Ok(None),
        Some(serde_json::Value::Number(n)) => Ok(n.as_i64()),
        Some(serde_json::Value::String(s)) => Ok(s.trim().parse::<i64>().ok()),
        _ => Ok(None),
    }
}

fn de_i64<'de, D: serde::Deserializer<'de>>(d: D) -> Result<i64, D::Error> {
    Ok(de_opt_i64(d)?.unwrap_or(0))
}

/// One `signatures` row from the Tripwire API (only the fields we consume).
#[derive(Debug, Clone, Deserialize)]
pub struct RawSignature {
    #[serde(deserialize_with = "de_i64")]
    pub id: i64,
    #[serde(rename = "signatureID", default)]
    pub signature_id: Option<String>,
    #[serde(rename = "systemID", default, deserialize_with = "de_opt_i64")]
    pub system_id: Option<i64>,
}

/// One `wormholes` row from the Tripwire API — a connection between two signatures.
#[derive(Debug, Clone, Deserialize)]
pub struct RawWormhole {
    #[serde(rename = "initialID", deserialize_with = "de_i64")]
    pub initial_id: i64,
    #[serde(rename = "secondaryID", deserialize_with = "de_i64")]
    pub secondary_id: i64,
    /// Wormhole type code, e.g. "K162", "N766".
    #[serde(rename = "type", default)]
    pub wh_type: Option<String>,
    /// "stable" | "critical" — EOL when critical.
    #[serde(default)]
    pub life: Option<String>,
    /// "stable" | "destab" | "critical".
    #[serde(default)]
    pub mass: Option<String>,
}

/// Map a wormhole type's max jump mass (kg) to our jump-mass class (s/m/l/xl).
/// Buckets mirror the frontend `maxShipLabel`. Missing mass → `Xl` (least
/// restrictive, so we never under-report). Pure.
pub fn jump_mass_class(max_jump_mass_kg: Option<f64>) -> super::store::JumpMass {
    use super::store::JumpMass;
    match max_jump_mass_kg {
        Some(m) if m > 0.0 && m <= 5_000_000.0 => JumpMass::S,
        Some(m) if m > 0.0 && m <= 62_000_000.0 => JumpMass::M,
        Some(m) if m > 0.0 && m <= 375_000_000.0 => JumpMass::L,
        _ => JumpMass::Xl,
    }
}

/// Map Tripwire's `mass` enum to our mass-status vocabulary. Pure.
pub fn mass_status(mass: Option<&str>) -> super::store::MassStatus {
    use super::store::MassStatus;
    match mass {
        Some("critical") => MassStatus::Critical,
        Some("destab") => MassStatus::Reduced,
        _ => MassStatus::Fresh,
    }
}

/// Fetch the wormholes + signatures for a mask via Basic Auth. The API echoes a
/// bare JSON array (or `null` when empty); on an auth/authorization problem it
/// echoes a plain-text message, so we read the body and surface it as an error.
pub async fn fetch(
    config: &TripwireConfig,
    password: &str,
    mask: &str,
) -> Result<(Vec<RawSignature>, Vec<RawWormhole>), String> {
    let http = reqwest::Client::builder()
        .user_agent(USER_AGENT)
        .build()
        .map_err(|e| e.to_string())?;
    let base = config.base_url.trim_end_matches('/');
    let url = format!("{base}/api.php");

    let get = |q: &'static str| {
        http.get(&url)
            .query(&[("q", q), ("maskID", mask)])
            .basic_auth(&config.username, Some(password.to_string()))
            .send()
    };

    let whs: Vec<RawWormhole> = parse_body(get("/wormholes").await).await?;
    let sigs: Vec<RawSignature> = parse_body(get("/signatures").await).await?;
    Ok((sigs, whs))
}

/// Read a response body and parse the JSON array, turning HTTP errors and
/// non-JSON auth messages ("Authentication failed", "not authorized …") into a
/// clean error string.
async fn parse_body<T: serde::de::DeserializeOwned>(
    resp: Result<reqwest::Response, reqwest::Error>,
) -> Result<Vec<T>, String> {
    let resp = resp.map_err(|e| e.to_string())?;
    let status = resp.status();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    if !status.is_success() {
        return Err(format!("Tripwire {}: {}", status.as_u16(), body.trim()));
    }
    // The API returns `null` for an empty/unauthorized mask.
    match serde_json::from_str::<Option<Vec<T>>>(&body) {
        Ok(v) => Ok(v.unwrap_or_default()),
        Err(_) => Err(format!("Tripwire: {}", body.trim())),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn jump_mass_buckets() {
        use super::super::store::JumpMass;
        assert_eq!(jump_mass_class(Some(5_000_000.0)), JumpMass::S);
        assert_eq!(jump_mass_class(Some(62_000_000.0)), JumpMass::M);
        assert_eq!(jump_mass_class(Some(375_000_000.0)), JumpMass::L);
        assert_eq!(jump_mass_class(Some(1_000_000_000.0)), JumpMass::Xl);
        assert_eq!(jump_mass_class(None), JumpMass::Xl);
    }

    #[test]
    fn mass_status_maps_tripwire_enum() {
        use super::super::store::MassStatus;
        assert_eq!(mass_status(Some("stable")), MassStatus::Fresh);
        assert_eq!(mass_status(Some("destab")), MassStatus::Reduced);
        assert_eq!(mass_status(Some("critical")), MassStatus::Critical);
        assert_eq!(mass_status(None), MassStatus::Fresh);
    }

    #[test]
    fn raw_rows_accept_string_or_numeric_ids() {
        // PDO may serialize ints as strings; both must parse.
        let sigs: Vec<RawSignature> = serde_json::from_str(
            r#"[{"id":"5","signatureID":"ABC","systemID":"31000005"},
                {"id":6,"signatureID":null,"systemID":null}]"#,
        )
        .unwrap();
        assert_eq!(sigs[0].id, 5);
        assert_eq!(sigs[0].system_id, Some(31000005));
        assert_eq!(sigs[1].system_id, None);

        let whs: Vec<RawWormhole> = serde_json::from_str(
            r#"[{"initialID":"5","secondaryID":"6","type":"N766","life":"stable","mass":"destab"}]"#,
        )
        .unwrap();
        assert_eq!(whs[0].initial_id, 5);
        assert_eq!(whs[0].wh_type.as_deref(), Some("N766"));
    }
}
