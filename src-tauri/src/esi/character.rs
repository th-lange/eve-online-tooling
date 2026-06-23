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
}

/// Authenticated, paginated ESI GET for the given character.
async fn authed_get_paged<T: DeserializeOwned>(
    auth: &AuthState,
    character_id: i64,
    path: &str,
) -> Result<Vec<T>, AuthError> {
    let token = auth.access_token_for(character_id).await?;
    let url = format!("{ESI_BASE}{path}");
    let resp = auth
        .http()
        .get(&url)
        .bearer_auth(&token)
        .send()
        .await?
        .error_for_status()?;
    let pages: u32 = resp
        .headers()
        .get("x-pages")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse().ok())
        .unwrap_or(1);
    let mut out: Vec<T> = resp.json().await?;
    for page in 2..=pages {
        let resp = auth
            .http()
            .get(&url)
            .query(&[("page", page.to_string())])
            .bearer_auth(&token)
            .send()
            .await?
            .error_for_status()?;
        out.extend(resp.json::<Vec<T>>().await?);
    }
    Ok(out)
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
