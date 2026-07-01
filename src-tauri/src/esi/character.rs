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
///
/// ESI **fails the whole batch with a 404 if any single id is unresolvable**, so
/// a naive request would drop every name (this is why hostile corps showed as
/// ids). We split-and-retry on failure to isolate the bad id, so one bad id only
/// costs itself, not the rest of the batch.
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

    // Dedup (callers pass many duplicate corp/alliance ids) and seed the work
    // stack with ESI-sized batches (cap 1000 per call).
    let mut unique: Vec<i64> = ids.iter().copied().filter(|&id| id > 0).collect();
    unique.sort_unstable();
    unique.dedup();
    let mut stack: Vec<Vec<i64>> = unique.chunks(1000).map(<[i64]>::to_vec).collect();

    while let Some(batch) = stack.pop() {
        if batch.is_empty() {
            continue;
        }
        let result = async {
            let resp = auth
                .http()
                .post(format!("{ESI_BASE}/latest/universe/names/"))
                .json(&batch)
                .send()
                .await
                .ok()?
                .error_for_status()
                .ok()?;
            resp.json::<Vec<NameRow>>().await.ok()
        }
        .await;

        match result {
            Some(rows) => {
                for r in rows {
                    out.insert(r.id, r.name);
                }
            }
            // Failed — a single id can poison the whole batch. Split to isolate
            // it; a lone id that still fails is simply unresolvable and dropped.
            None if batch.len() > 1 => {
                let mid = batch.len() / 2;
                stack.push(batch[mid..].to_vec());
                stack.push(batch[..mid].to_vec());
            }
            None => {}
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

/// Open the in-game Show Info window for an entity (ESI UI write). ESI has no
/// "open PI window" endpoint; this is the closest hook (systems are always
/// supported; some celestials may not be, so callers can fall back).
pub async fn open_information_window(
    auth: &AuthState,
    character_id: i64,
    target_id: i64,
) -> Result<(), AuthError> {
    let token = auth.access_token_for(character_id).await?;
    auth.http()
        .post(format!("{ESI_BASE}/latest/ui/openwindow/information/"))
        .query(&[("target_id", target_id.to_string())])
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

/// An in-game saved fitting from ESI (`/characters|corporations/{id}/fittings/`).
#[derive(Debug, Clone, Deserialize)]
pub struct EsiFitting {
    pub fitting_id: i64,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    #[allow(dead_code)] // part of the ESI shape; not surfaced in the editor yet
    pub description: String,
    pub ship_type_id: i64,
    #[serde(default)]
    pub items: Vec<EsiFitItem>,
}

/// One item in an ESI fitting: a module/charge/drone and its slot `flag` (a
/// string enum like `"HiSlot0"` / `"LoSlot3"` / `"DroneBay"` / `"Cargo"`), plus a
/// quantity (drones/charges).
#[derive(Debug, Clone, Deserialize)]
pub struct EsiFitItem {
    pub type_id: i64,
    pub flag: String,
    #[serde(default = "one_i64")]
    pub quantity: i64,
}
fn one_i64() -> i64 {
    1
}

/// The character's in-game saved fittings (#178). Requires the
/// `esi-fittings.read_fittings.v1` scope. Errors (including a 403 from a missing
/// scope) surface to the caller so the UI can explain why nothing loaded — an
/// empty result here means the character genuinely has no saved fittings.
pub async fn fetch_character_fittings(
    auth: &AuthState,
    character_id: i64,
) -> Result<Vec<EsiFitting>, AuthError> {
    let token = auth.access_token_for(character_id).await?;
    let url = format!("{ESI_BASE}/latest/characters/{character_id}/fittings/");
    let resp = auth
        .http()
        .get(&url)
        .bearer_auth(&token)
        .send()
        .await?
        .error_for_status()?;
    Ok(resp.json().await?)
}

/// Save a fitting to the character's in-game fittings (POST). Requires the
/// `esi-fittings.write_fittings.v1` scope; a 403 from a missing scope surfaces to
/// the caller. Returns the new `fitting_id`. `items` serializes to ESI's body.
pub async fn create_character_fitting<T: serde::Serialize>(
    auth: &AuthState,
    character_id: i64,
    name: &str,
    description: &str,
    ship_type_id: i64,
    items: &[T],
) -> Result<i64, AuthError> {
    #[derive(serde::Serialize)]
    struct Body<'a, T> {
        name: &'a str,
        description: &'a str,
        ship_type_id: i64,
        items: &'a [T],
    }
    #[derive(Deserialize)]
    struct Created {
        fitting_id: i64,
    }
    let token = auth.access_token_for(character_id).await?;
    let url = format!("{ESI_BASE}/latest/characters/{character_id}/fittings/");
    let created: Created = auth
        .http()
        .post(&url)
        .bearer_auth(&token)
        .json(&Body { name, description, ship_type_id, items })
        .send()
        .await?
        .error_for_status()?
        .json()
        .await?;
    Ok(created.fitting_id)
}

/// The corporation's saved fittings, using the character's token. Requires the
/// scope **and** the Fitting Manager role; lacking either, ESI returns 403 and
/// we treat it as "none".
pub async fn fetch_corp_fittings(
    auth: &AuthState,
    character_id: i64,
    corporation_id: i64,
) -> Result<Vec<EsiFitting>, AuthError> {
    let token = auth.access_token_for(character_id).await?;
    let url = format!("{ESI_BASE}/latest/corporations/{corporation_id}/fittings/");
    let resp = auth.http().get(&url).bearer_auth(&token).send().await?;
    if resp.status() == reqwest::StatusCode::FORBIDDEN {
        return Ok(Vec::new());
    }
    Ok(resp.error_for_status()?.json().await?)
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
