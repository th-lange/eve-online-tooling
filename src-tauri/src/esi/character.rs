//! Authenticated ESI reads for a character's assets and blueprints.

use serde::de::DeserializeOwned;
use serde::Deserialize;

use super::auth::{AuthError, AuthState};
use super::error::EsiError;
use super::net::{send_once, send_retrying};
use super::ESI_BASE;
use std::collections::HashMap;
use std::path::Path;

use crate::storage;

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
#[derive(Debug, Clone, Deserialize, serde::Serialize)]
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

/// Like [`authed_get_paged`], but a 403 (a corp endpoint hit by a character
/// without the required role, e.g. Director/Accountant) is treated as an
/// empty result rather than an error — "no access" reads the same as "nothing
/// there" to these callers.
async fn authed_get_paged_or_empty_on_403<T: DeserializeOwned>(
    auth: &AuthState,
    character_id: i64,
    path: &str,
) -> Result<Vec<T>, AuthError> {
    match authed_get_paged(auth, character_id, path).await {
        Err(AuthError::Esi(EsiError::Http(e)))
            if e.status() == Some(reqwest::StatusCode::FORBIDDEN) =>
        {
            Ok(Vec::new())
        }
        other => other,
    }
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
            let resp = send_retrying(|| {
                auth.http()
                    .post(format!("{ESI_BASE}/latest/universe/names/"))
                    .json(&batch)
            })
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

/// Cache of lowercased character name → id. A name→id mapping is permanent, so
/// this never expires.
const CHAR_IDS_CACHE: &str = "esi_char_ids";

/// Resolve character **names → ids** via the public `POST /universe/ids/`,
/// cached forever (case-insensitive). Returns a `lowercased-name → id` map
/// covering every name that resolves (cached + freshly fetched); names that
/// don't resolve are simply absent, so the caller derives its own "unresolved"
/// set. Shared by Local Intel and PVP. `http` only needs the app User-Agent;
/// `cache_dir` is optional (skips the on-disk cache when absent).
pub async fn resolve_character_ids(
    http: &reqwest::Client,
    cache_dir: Option<&Path>,
    names: &[String],
) -> HashMap<String, i64> {
    #[derive(Deserialize)]
    struct IdName {
        id: i64,
        name: String,
    }
    #[derive(Deserialize, Default)]
    struct UniverseIds {
        #[serde(default)]
        characters: Vec<IdName>,
    }
    let lower = |n: &str| n.to_lowercase();
    let mut id_cache: HashMap<String, i64> = cache_dir
        .and_then(|d| storage::load_data(d, CHAR_IDS_CACHE))
        .unwrap_or_default();
    let missing: Vec<String> = names
        .iter()
        .filter(|n| !id_cache.contains_key(&lower(n)))
        .cloned()
        .collect();
    if !missing.is_empty() {
        if let Some(ids) = (async {
            send_retrying(|| {
                http.post(format!("{ESI_BASE}/latest/universe/ids/"))
                    .json(&missing)
            })
            .await
            .ok()?
            .error_for_status()
            .ok()?
            .json::<UniverseIds>()
            .await
            .ok()
        })
        .await
        {
            for c in ids.characters {
                id_cache.insert(lower(&c.name), c.id);
            }
            if let Some(d) = cache_dir {
                let _ = storage::save_data(d, CHAR_IDS_CACHE, &id_cache);
            }
        }
    }
    id_cache
}

/// Open the in-game market details window for a type (ESI UI write).
pub async fn open_market_window(
    auth: &AuthState,
    character_id: i64,
    type_id: i64,
) -> Result<(), AuthError> {
    let token = auth.access_token_for(character_id).await?;
    send_retrying(|| {
        auth.http()
            .post(format!("{ESI_BASE}/latest/ui/openwindow/marketdetails/"))
            .query(&[("type_id", type_id.to_string())])
            .bearer_auth(&token)
    })
    .await?
    .error_for_status()?;
    Ok(())
}

/// Set the character's autopilot destination to a solar system (ESI UI write).
/// This is the closest *working* in-game hook for "take me to this colony":
/// `/ui/openwindow/information/` only accepts character/corporation/alliance
/// target ids — CCP never extended it to planets or systems (esi-issues#358) —
/// so PI's "Show in-game" sets a waypoint instead of trying (and failing) to
/// open a Show Info window. Clears other waypoints so it's a direct route.
pub async fn set_autopilot_waypoint(
    auth: &AuthState,
    character_id: i64,
    destination_system_id: i64,
) -> Result<(), AuthError> {
    let token = auth.access_token_for(character_id).await?;
    send_retrying(|| {
        auth.http()
            .post(format!("{ESI_BASE}/latest/ui/autopilot/waypoint/"))
            .query(&[
                ("destination_id", destination_system_id.to_string()),
                ("add_to_beginning", "true".to_string()),
                ("clear_other_waypoints", "true".to_string()),
            ])
            .bearer_auth(&token)
    })
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

/// Raw skill entry as returned by `/characters/{id}/skills/`.
#[derive(Deserialize)]
struct RawSkillsResponse {
    skills: Vec<RawSkillEntry>,
    total_sp: i64,
    #[serde(default)]
    unallocated_sp: i64,
}
#[derive(Deserialize)]
struct RawSkillEntry {
    skill_id: i64,
    #[serde(default)]
    active_skill_level: i64,
}

/// A character's trained skill levels + SP totals, from
/// `/characters/{id}/skills/`. Shared by the fitting simulator, industry slot
/// counts, and the character skills/standings/trade-fees viewers — every
/// caller was independently deserializing the same endpoint (#177, #55, #56).
#[derive(Debug, Clone, Default)]
pub struct SkillLevels {
    levels: HashMap<i64, i64>,
    pub total_sp: i64,
    pub unallocated_sp: i64,
}

impl SkillLevels {
    /// The character's trained level for `id` (0 if untrained/not returned).
    pub fn level(&self, id: i64) -> i64 {
        self.levels.get(&id).copied().unwrap_or(0)
    }

    /// Count of skills trained to at least level 1.
    pub fn trained_count(&self) -> usize {
        self.levels.values().filter(|&&level| level > 0).count()
    }
}

/// The character's trained skill levels + SP totals, via authenticated ESI
/// `/characters/{id}/skills/`. Requires the `esi-skills.read_skills.v1` scope.
pub async fn character_skill_levels(
    auth: &AuthState,
    character_id: i64,
) -> Result<SkillLevels, AuthError> {
    let raw: RawSkillsResponse = authed_get(
        auth,
        character_id,
        &format!("/latest/characters/{character_id}/skills/"),
    )
    .await?;
    Ok(SkillLevels {
        levels: raw
            .skills
            .into_iter()
            .map(|s| (s.skill_id, s.active_skill_level))
            .collect(),
        total_sp: raw.total_sp,
        unallocated_sp: raw.unallocated_sp,
    })
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
    authed_get_paged_or_empty_on_403(
        auth,
        character_id,
        &format!("/latest/corporations/{corporation_id}/blueprints/"),
    )
    .await
}

/// Corporation hangar/vault assets, using the character's token. Requires the
/// `esi-assets.read_corporation_assets.v1` scope and a corp role with
/// asset-hangar access (e.g. Director); if the character lacks either, ESI
/// returns 403 and we treat it as "none".
pub async fn fetch_corp_assets(
    auth: &AuthState,
    character_id: i64,
    corporation_id: i64,
) -> Result<Vec<RawAsset>, AuthError> {
    authed_get_paged_or_empty_on_403(
        auth,
        character_id,
        &format!("/latest/corporations/{corporation_id}/assets/"),
    )
    .await
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
    let resp = send_retrying(|| auth.http().get(&url).bearer_auth(&token))
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
    let created: Created = send_once(|| {
        auth.http().post(&url).bearer_auth(&token).json(&Body {
            name,
            description,
            ship_type_id,
            items,
        })
    })
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
    let resp = send_retrying(|| auth.http().get(&url).bearer_auth(&token)).await?;
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
