//! Authenticated ESI reads for a character's assets and blueprints.

use serde::de::DeserializeOwned;
use serde::Deserialize;

use super::auth::{AuthError, AuthState};
use super::ESI_BASE;

/// A blueprint as returned by `/characters/{id}/blueprints/`.
#[derive(Debug, Clone, Deserialize)]
pub struct RawBlueprint {
    pub type_id: i64,
    pub material_efficiency: i64,
    pub time_efficiency: i64,
    /// Remaining runs; `-1` for a BPO (original, unlimited).
    pub runs: i64,
    /// `-1` for a BPO, `-2` for a single BPC, otherwise a stack count.
    pub quantity: i64,
}

/// An asset as returned by `/characters/{id}/assets/`.
#[derive(Debug, Clone, Deserialize)]
pub struct RawAsset {
    pub type_id: i64,
    pub quantity: i64,
    pub location_id: i64,
    /// Unique in-game id of this asset stack (a container's id can be another
    /// asset's `location_id` — that's how the location tree nests). 0 if absent.
    #[serde(default)]
    pub item_id: i64,
}

/// Authenticated, paginated ESI GET for the given character. Conditionally
/// cached per (character, path) — see [`super::cache::ConditionalCache`].
async fn authed_get_paged<T: DeserializeOwned>(
    auth: &AuthState,
    character_id: i64,
    path: &str,
) -> Result<Vec<T>, AuthError> {
    let token = auth.access_token_for(character_id).await?;
    let url = format!("{ESI_BASE}{path}");
    let key = format!("c{character_id}:{path}");
    let out = auth
        .cache()
        .get_paged(&key, |page| {
            auth.http()
                .get(&url)
                .query(&[("page", page.to_string())])
                .bearer_auth(&token)
        })
        .await?;
    Ok(out)
}

/// Authenticated single-page ESI GET (deserialized). Shared by the character
/// data viewers (skills, standings, research, mining, fleet). Conditionally
/// cached per (character, path).
pub async fn authed_get<T: DeserializeOwned>(
    auth: &AuthState,
    character_id: i64,
    path: &str,
) -> Result<T, AuthError> {
    let token = auth.access_token_for(character_id).await?;
    let url = format!("{ESI_BASE}{path}");
    let key = format!("c{character_id}:{path}");
    let val = auth
        .cache()
        .get_json(&key, || auth.http().get(&url).bearer_auth(&token))
        .await?;
    Ok(val)
}

/// Public wrapper over the paginated authed GET (for the mining ledger).
pub async fn authed_get_paged_pub<T: DeserializeOwned>(
    auth: &AuthState,
    character_id: i64,
    path: &str,
) -> Result<Vec<T>, AuthError> {
    authed_get_paged(auth, character_id, path).await
}

/// Public `/universe/names/` resolver: ids → names (characters, corps, factions,
/// systems, types). Unauthenticated POST; unknown ids are simply absent.
pub async fn resolve_names(
    auth: &AuthState,
    ids: &[i64],
) -> std::collections::HashMap<i64, String> {
    #[derive(Deserialize)]
    struct NameRow {
        id: i64,
        name: String,
    }
    let mut out = std::collections::HashMap::new();
    if ids.is_empty() {
        return out;
    }
    // ESI caps the batch at 1000 ids per call. Failures are skipped, not fatal.
    for chunk in ids.chunks(1000) {
        let Ok(resp) = auth
            .http()
            .post(format!("{ESI_BASE}/latest/universe/names/"))
            .json(&chunk)
            .send()
            .await
        else {
            continue;
        };
        let Ok(resp) = resp.error_for_status() else {
            continue;
        };
        if let Ok(rows) = resp.json::<Vec<NameRow>>().await {
            for r in rows {
                out.insert(r.id, r.name);
            }
        }
    }
    out
}

/// Open the in-game market details window for a type (ESI UI write).
pub async fn open_market_window(
    auth: &AuthState,
    character_id: i64,
    type_id: i64,
) -> Result<(), AuthError> {
    let token = auth.access_token_for(character_id).await?;
    auth.http()
        .post(format!("{ESI_BASE}/latest/ui/openwindow/marketdetails/"))
        .query(&[("type_id", type_id.to_string())])
        .bearer_auth(&token)
        .send()
        .await?
        .error_for_status()?;
    Ok(())
}

pub async fn fetch_blueprints(
    auth: &AuthState,
    character_id: i64,
) -> Result<Vec<RawBlueprint>, AuthError> {
    authed_get_paged(
        auth,
        character_id,
        &format!("/latest/characters/{character_id}/blueprints/"),
    )
    .await
}

pub async fn fetch_assets(auth: &AuthState, character_id: i64) -> Result<Vec<RawAsset>, AuthError> {
    authed_get_paged(
        auth,
        character_id,
        &format!("/latest/characters/{character_id}/assets/"),
    )
    .await
}

#[derive(Deserialize)]
struct CharacterPublic {
    corporation_id: i64,
}

/// The character's corporation id (public endpoint, conditionally cached).
pub async fn corporation_id(auth: &AuthState, character_id: i64) -> Result<i64, AuthError> {
    let url = format!("{ESI_BASE}/latest/characters/{character_id}/");
    let key = format!("pub:char:{character_id}");
    let info: CharacterPublic = auth
        .cache()
        .get_json(&key, || auth.http().get(&url))
        .await?;
    Ok(info.corporation_id)
}

/// Corporation blueprints, using the character's token. Requires the
/// `esi-corporations.read_blueprints.v1` scope and the Director role; if the
/// character lacks either, ESI returns 403 and we treat it as "none".
pub async fn fetch_corp_blueprints(
    auth: &AuthState,
    character_id: i64,
    corporation_id: i64,
) -> Result<Vec<RawBlueprint>, AuthError> {
    let token = auth.access_token_for(character_id).await?;
    let url = format!("{ESI_BASE}/latest/corporations/{corporation_id}/blueprints/");
    let resp = auth.http().get(&url).bearer_auth(&token).send().await?;
    if resp.status() == reqwest::StatusCode::FORBIDDEN {
        return Ok(Vec::new());
    }
    let resp = resp.error_for_status()?;
    let pages: u32 = resp
        .headers()
        .get("x-pages")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok())
        .unwrap_or(1);
    let mut out: Vec<RawBlueprint> = resp.json().await?;
    for page in 2..=pages {
        let resp = auth
            .http()
            .get(&url)
            .query(&[("page", page.to_string())])
            .bearer_auth(&token)
            .send()
            .await?
            .error_for_status()?;
        out.extend(resp.json::<Vec<RawBlueprint>>().await?);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_blueprint_rows() {
        let json = r#"[
            {"item_id":1,"type_id":12345,"location_id":60003760,"location_flag":"Hangar","quantity":-1,"material_efficiency":10,"time_efficiency":20,"runs":-1},
            {"item_id":2,"type_id":999,"location_id":60003760,"location_flag":"Hangar","quantity":-2,"material_efficiency":2,"time_efficiency":4,"runs":30}
        ]"#;
        let bps: Vec<RawBlueprint> = serde_json::from_str(json).unwrap();
        assert_eq!(bps.len(), 2);
        assert_eq!(bps[0].type_id, 12345);
        assert_eq!(bps[0].material_efficiency, 10);
        assert_eq!(bps[1].runs, 30);
    }
}
