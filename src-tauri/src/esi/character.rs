//! Authenticated ESI reads for a character's assets and blueprints.

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use super::auth::{AuthError, AuthState};
use super::error::EsiError;
use super::net::{get_immutable_json, post_json, send_once, send_retrying};
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
    /// True for a blueprint *copy*: ESI reports it under the BPO's type id, so
    /// pricing it by type would value a BPC at the original's market price.
    #[serde(default)]
    pub is_blueprint_copy: bool,
}

/// Run an authed ESI call with the character's access token, retrying **once**
/// with a freshly refreshed token if ESI rejects it with 401/403.
///
/// The cached token can be dead even though its recorded expiry hasn't passed
/// (laptop suspend, revocation elsewhere). Without this every authed call
/// keeps failing — or reads as "empty"/"re-login to enable scope" — until the
/// cache entry lapses (#1146). The refresh goes through
/// [`AuthState::access_token_for`], so it stays single-flighted per character;
/// [`AuthState::invalidate_rejected`] declines the retry when the rejected
/// token is brand new, i.e. the 403 is a genuine missing scope/role.
/// `op` gets the token and must build and send the request itself.
pub(super) async fn with_token_retry<T, F, Fut>(
    auth: &AuthState,
    character_id: i64,
    op: F,
) -> Result<T, AuthError>
where
    F: Fn(String) -> Fut,
    Fut: std::future::Future<Output = Result<T, EsiError>>,
{
    let token = auth.access_token_for(character_id).await?;
    match op(token.clone()).await {
        Err(EsiError::Http(e))
            if matches!(
                e.status(),
                Some(reqwest::StatusCode::UNAUTHORIZED | reqwest::StatusCode::FORBIDDEN)
            ) && auth.invalidate_rejected(character_id, &token) =>
        {
            let fresh = auth.access_token_for(character_id).await?;
            Ok(op(fresh).await?)
        }
        other => Ok(other?),
    }
}

/// Authenticated, paginated ESI GET for the given character. Conditionally
/// cached per (character, path) — see [`super::cache::ConditionalCache`].
async fn authed_get_paged<T: DeserializeOwned>(
    auth: &AuthState,
    character_id: i64,
    path: &str,
) -> Result<Vec<T>, AuthError> {
    let url = format!("{ESI_BASE}{path}");
    let key = format!("c{character_id}:{path}");
    let (url, key) = (&url, &key);
    with_token_retry(auth, character_id, |token| async move {
        auth.cache()
            .get_paged(key, |page| {
                auth.http()
                    .get(url)
                    .query(&[("page", page.to_string())])
                    .bearer_auth(&token)
            })
            .await
    })
    .await
}

/// Like [`authed_get_paged`], but a 403 (a corp endpoint hit by a character
/// without the required role, e.g. Director/Accountant) is treated as an
/// empty result rather than an error — "no access" reads the same as "nothing
/// there" to these callers.
pub async fn authed_get_paged_or_empty_on_403<T: DeserializeOwned>(
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
    let url = format!("{ESI_BASE}{path}");
    let key = format!("c{character_id}:{path}");
    let (url, key) = (&url, &key);
    with_token_retry(auth, character_id, |token| async move {
        auth.cache()
            .get_json(key, || auth.http().get(url).bearer_auth(&token))
            .await
    })
    .await
}

/// Like [`authed_get`], but distinguishes a 403 (missing scope, or a scope
/// granted before this call site started requiring it — the user just
/// hasn't re-logged-in yet) from every other failure. `Ok(None)` means
/// specifically 403 — callers that need to show a "re-login to enable" hint
/// rather than a generic error react to that case; any other error still
/// propagates as `Err`.
pub async fn authed_get_or_none_on_403<T: DeserializeOwned>(
    auth: &AuthState,
    character_id: i64,
    path: &str,
) -> Result<Option<T>, AuthError> {
    match authed_get(auth, character_id, path).await {
        Ok(v) => Ok(Some(v)),
        Err(AuthError::Esi(EsiError::Http(e)))
            if e.status() == Some(reqwest::StatusCode::FORBIDDEN) =>
        {
            Ok(None)
        }
        Err(e) => Err(e),
    }
}

/// The cached freshness deadline (Unix epoch secs) for a prior
/// [`authed_get`] call at `path` for `character_id`, if the conditional
/// cache still holds an entry. Lets callers surface ESI's own
/// `Cache-Control`/`Expires` window downstream (e.g. the frontend's
/// `expiresAt` freshness cue, #885) without duplicating [`authed_get`]'s
/// cache-key derivation.
pub async fn authed_get_expires_at(auth: &AuthState, character_id: i64, path: &str) -> Option<u64> {
    let key = format!("c{character_id}:{path}");
    auth.cache().expires_at(&key).await
}

/// Public wrapper over the paginated authed GET (for the mining ledger).
pub async fn authed_get_paged_pub<T: DeserializeOwned>(
    auth: &AuthState,
    character_id: i64,
    path: &str,
) -> Result<Vec<T>, AuthError> {
    authed_get_paged(auth, character_id, path).await
}

/// First id of the player-structure range (≥ 1 trillion). `/universe/names/`
/// can never resolve these (they need the authed `/universe/structures/{id}/`),
/// so they are dropped before a request is spent on them.
pub(crate) const STRUCTURE_ID_MIN: i64 = 1_000_000_000_000;

/// Public `/universe/names/` resolver: ids → names (characters, corps, factions,
/// systems, types). Unauthenticated POST; unknown ids are simply absent.
///
/// ESI **fails the whole batch with a 404 if any single id is unresolvable**, so
/// a naive request would drop every name (this is why hostile corps showed as
/// ids). On a 400/404 we split the batch and retry the halves to isolate the
/// bad id, so one bad id only costs itself. Any *other* failure — transport
/// error, 5xx, 420, 429 — says nothing about the ids, so the whole resolve
/// stops there and returns what it has: bisecting an outage would only multiply
/// failing (and error-budget-burning) requests (#1145).
pub async fn resolve_names(
    auth: &AuthState,
    ids: &[i64],
) -> std::collections::HashMap<i64, String> {
    resolve_names_at(
        auth.http(),
        &format!("{ESI_BASE}/latest/universe/names/"),
        ids,
    )
    .await
}

/// [`resolve_names`] against an explicit endpoint URL (so tests can stub it).
async fn resolve_names_at(
    http: &reqwest::Client,
    url: &str,
    ids: &[i64],
) -> std::collections::HashMap<i64, String> {
    #[derive(Deserialize)]
    struct NameRow {
        id: i64,
        name: String,
    }

    let mut out = std::collections::HashMap::new();

    // Dedup (callers pass many duplicate corp/alliance ids), drop ids this
    // endpoint can't resolve, and seed the work stack with ESI-sized batches
    // (cap 1000 per call).
    let mut unique: Vec<i64> = ids
        .iter()
        .copied()
        .filter(|&id| id > 0 && id < STRUCTURE_ID_MIN)
        .collect();
    unique.sort_unstable();
    unique.dedup();
    let mut stack: Vec<Vec<i64>> = unique.chunks(1000).map(<[i64]>::to_vec).collect();

    while let Some(batch) = stack.pop() {
        if batch.is_empty() {
            continue;
        }
        let Ok(resp) = send_retrying(|| http.post(url).json(&batch)).await else {
            break; // transport failure: offline / ESI unreachable
        };
        let status = resp.status();
        if status.is_success() {
            if let Ok(rows) = resp.json::<Vec<NameRow>>().await {
                for r in rows {
                    out.insert(r.id, r.name);
                }
            }
        } else if matches!(
            status,
            reqwest::StatusCode::BAD_REQUEST | reqwest::StatusCode::NOT_FOUND
        ) {
            // A bad id poisoned the batch: split to isolate it; a lone id that
            // still fails is simply unresolvable and dropped.
            if batch.len() > 1 {
                let mid = batch.len() / 2;
                stack.push(batch[mid..].to_vec());
                stack.push(batch[..mid].to_vec());
            }
        } else {
            break; // 5xx / 420 / 429 / …: not about the ids — don't bisect
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
        if let Some(ids) =
            post_json::<UniverseIds, _>(http, &format!("{ESI_BASE}/latest/universe/ids/"), &missing)
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

/// One row of the public `POST /characters/affiliation/`: a character's
/// current corporation/alliance/faction. Unauthenticated; ESI accepts
/// batches up to 1000 ids.
#[derive(Debug, Clone, Deserialize)]
pub struct CharacterAffiliation {
    pub character_id: i64,
    pub corporation_id: i64,
    #[serde(default)]
    pub alliance_id: Option<i64>,
    #[serde(default)]
    pub faction_id: Option<i64>,
}

/// Resolve character ids → current corp/alliance/faction via the public
/// `POST /characters/affiliation/`. `None` on any failure (network, status,
/// or decode) — callers that cache per-id (e.g. Local Intel's 1h TTL
/// affiliation cache) should treat that as "nothing fresh this round" and
/// keep serving what they already have cached.
pub async fn character_affiliation(
    http: &reqwest::Client,
    ids: &[i64],
) -> Option<Vec<CharacterAffiliation>> {
    post_json(
        http,
        &format!("{ESI_BASE}/latest/characters/affiliation/"),
        ids,
    )
    .await
}

/// On-disk cache of character id → affiliation, keyed under this name.
const AFFILIATION_CACHE: &str = "esi_affiliations";
/// Affiliations go stale slowly (corp/alliance moves, FW enlistment changes)
/// but do change — unlike the permanent name→id cache, this one expires.
const AFFILIATION_TTL_SECS: u64 = 60 * 60;

#[derive(Serialize, Deserialize, Clone)]
struct CachedAffiliation {
    corporation_id: i64,
    alliance_id: Option<i64>,
    faction_id: Option<i64>,
    /// Unix epoch (secs) of the fetch, for the TTL check.
    ts: u64,
}

/// Resolve character ids → current corp/alliance/faction, cached on disk with
/// a 1h TTL (only ids missing or past the TTL hit ESI's batch endpoint).
/// Shared by Local Intel and PVP — both store under the same on-disk key, so
/// a character either feature has already looked up warms the other's cache
/// too. Ids ESI couldn't affiliate (or whose fetch failed this round) are
/// simply absent from the result rather than erroring the whole batch.
pub async fn cached_character_affiliations(
    http: &reqwest::Client,
    cache_dir: Option<&Path>,
    ids: &[i64],
) -> HashMap<i64, CharacterAffiliation> {
    let now = crate::util::time::now_secs();
    let mut cache: HashMap<i64, CachedAffiliation> = cache_dir
        .and_then(|d| storage::load_data(d, AFFILIATION_CACHE))
        .unwrap_or_default();
    let stale: Vec<i64> = ids
        .iter()
        .copied()
        .filter(|id| {
            cache
                .get(id)
                .is_none_or(|c| now.saturating_sub(c.ts) >= AFFILIATION_TTL_SECS)
        })
        .collect();
    if !stale.is_empty() {
        if let Some(rows) = character_affiliation(http, &stale).await {
            for a in rows {
                cache.insert(
                    a.character_id,
                    CachedAffiliation {
                        corporation_id: a.corporation_id,
                        alliance_id: a.alliance_id,
                        faction_id: a.faction_id,
                        ts: now,
                    },
                );
            }
            if let Some(d) = cache_dir {
                let _ = storage::save_data(d, AFFILIATION_CACHE, &cache);
            }
        }
    }
    ids.iter()
        .filter_map(|id| {
            cache.get(id).map(|c| {
                (
                    *id,
                    CharacterAffiliation {
                        character_id: *id,
                        corporation_id: c.corporation_id,
                        alliance_id: c.alliance_id,
                        faction_id: c.faction_id,
                    },
                )
            })
        })
        .collect()
}

/// Fetch one public killmail (`GET /killmails/{id}/{hash}/`). Killmails are
/// immutable once created, so this is a plain budget-observed GET — no
/// conditional-cache revalidation needed. `None` on any failure, including a
/// 404 (e.g. a killmail ESI has since dropped).
pub async fn fetch_killmail<T: DeserializeOwned>(
    http: &reqwest::Client,
    killmail_id: i64,
    hash: &str,
) -> Option<T> {
    get_immutable_json(
        http,
        &format!("{ESI_BASE}/latest/killmails/{killmail_id}/{hash}/"),
    )
    .await
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

/// Open the in-game "Show Info" window for a character, corporation, or
/// alliance id (ESI UI write) — e.g. surfacing a corp's info window (with its
/// "Give ISK" action) for players who want to donate.
pub async fn open_info_window(
    auth: &AuthState,
    character_id: i64,
    target_id: i64,
) -> Result<(), AuthError> {
    let token = auth.access_token_for(character_id).await?;
    send_retrying(|| {
        auth.http()
            .post(format!("{ESI_BASE}/latest/ui/openwindow/information/"))
            .query(&[("target_id", target_id.to_string())])
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

/// A player structure (citadel / upweller) as returned by
/// `GET /universe/structures/{structure_id}/`.
#[derive(Debug, Clone, Deserialize)]
pub struct StructureInfo {
    pub name: String,
    #[serde(rename = "solar_system_id")]
    pub solar_system_id: i64,
}

/// Most structure lookups in flight at once. ESI's error budget is checked
/// before a request goes out, not when its 403 comes back, so an unbounded
/// burst of inaccessible structures sails past the guard together.
const STRUCTURE_LOOKUP_CONCURRENCY: usize = 6;

/// Resolve player-structure names + home system ids via authenticated
/// `GET /universe/structures/{id}/`. One request per structure — there is no
/// batch endpoint that resolves arbitrary ids — with bounded concurrency.
/// Outcomes are remembered in [`AuthState`]: names for a day, and a 403/404
/// (structure not accessible to the character) for a short while, so repeated
/// Assets loads don't re-spend error budget on structures the character can no
/// longer dock at. Other failures (5xx, transport) are not remembered. The
/// caller falls back to a generic label for anything not resolved. All
/// requests flow through [`send_retrying`] so the ESI error budget is
/// respected.
///
/// Returns `HashMap<structure_id, (name, solar_system_id)>`.
pub async fn fetch_structure_info(
    auth: &AuthState,
    character_id: i64,
    structure_ids: &[i64],
) -> HashMap<i64, (String, i64)> {
    if structure_ids.is_empty() {
        return HashMap::new();
    }

    let token = match auth.access_token_for(character_id).await {
        Ok(t) => t,
        Err(_) => return HashMap::new(),
    };
    lookup_structures(auth, character_id, &token, ESI_BASE, structure_ids).await
}

/// [`fetch_structure_info`] with the token and API base supplied (testable).
async fn lookup_structures(
    auth: &AuthState,
    character_id: i64,
    token: &str,
    base: &str,
    structure_ids: &[i64],
) -> HashMap<i64, (String, i64)> {
    use super::token_cache::StructureLookup;
    use futures_util::StreamExt;

    let mut out = HashMap::new();
    let mut todo = Vec::new();
    for &id in structure_ids {
        match auth.structure_cached(character_id, id) {
            Some(StructureLookup::Found(name, system)) => {
                out.insert(id, (name, system));
            }
            Some(StructureLookup::Denied) => {}
            None if !todo.contains(&id) => todo.push(id),
            None => {}
        }
    }

    let http = auth.http();
    let lookups = futures_util::stream::iter(todo)
        .map(|id| async move {
            let url = format!("{base}/latest/universe/structures/{id}/");
            let resp = send_retrying(|| http.get(&url).bearer_auth(token))
                .await
                .ok()?;
            let status = resp.status();
            if status.is_success() {
                let info: StructureInfo = resp.json().await.ok()?;
                Some((id, StructureLookup::Found(info.name, info.solar_system_id)))
            } else if matches!(
                status,
                reqwest::StatusCode::FORBIDDEN | reqwest::StatusCode::NOT_FOUND
            ) {
                Some((id, StructureLookup::Denied))
            } else {
                None
            }
        })
        .buffer_unordered(STRUCTURE_LOOKUP_CONCURRENCY)
        .collect::<Vec<_>>()
        .await;

    for (id, lookup) in lookups.into_iter().flatten() {
        if let StructureLookup::Found(name, system) = &lookup {
            out.insert(id, (name.clone(), *system));
        }
        auth.remember_structure(character_id, id, lookup);
    }
    out
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
    let url = format!("{ESI_BASE}/latest/characters/{character_id}/fittings/");
    let url = &url;
    with_token_retry(auth, character_id, |token| async move {
        let resp = send_retrying(|| auth.http().get(url).bearer_auth(&token))
            .await?
            .error_for_status()?;
        Ok(resp.json().await?)
    })
    .await
}

/// The character's current ship, from `/characters/{id}/ship/`. Requires the
/// `esi-location.read_ship_type.v1` scope (a 403 surfaces as an error so the
/// caller can treat "scope not granted" as "unknown ship").
#[derive(Debug, Clone, Deserialize)]
pub struct RawShip {
    pub ship_type_id: i64,
    #[serde(default)]
    pub ship_name: String,
    #[allow(dead_code)] // part of the ESI shape; the item id isn't surfaced
    pub ship_item_id: i64,
}

/// Fetch the character's currently-boarded ship (hull type + given name).
pub async fn fetch_character_ship(
    auth: &AuthState,
    character_id: i64,
) -> Result<RawShip, AuthError> {
    authed_get(
        auth,
        character_id,
        &format!("/latest/characters/{character_id}/ship/"),
    )
    .await
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
    let url = format!("{ESI_BASE}/latest/corporations/{corporation_id}/fittings/");
    let url = &url;
    let fetched = with_token_retry(auth, character_id, |token| async move {
        let resp = send_retrying(|| auth.http().get(url).bearer_auth(&token))
            .await?
            .error_for_status()?;
        Ok(resp.json().await?)
    })
    .await;
    match fetched {
        // Still 403 after the fresh-token retry: no scope or role — "none".
        Err(AuthError::Esi(EsiError::Http(e)))
            if e.status() == Some(reqwest::StatusCode::FORBIDDEN) =>
        {
            Ok(Vec::new())
        }
        other => other,
    }
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

    // ── stub HTTP server shared by the resolver/structure tests ─────────────

    type Seen = std::sync::Arc<parking_lot::Mutex<Vec<(String, String)>>>;

    /// A loopback server answering every request via `handler(url, body)` →
    /// `(status, body)`, recording `(url, body)` of each. Stops when dropped.
    struct Stub {
        base: String,
        seen: Seen,
        stop: std::sync::Arc<std::sync::atomic::AtomicBool>,
    }

    impl Drop for Stub {
        fn drop(&mut self) {
            self.stop.store(true, std::sync::atomic::Ordering::SeqCst);
        }
    }

    fn stub(handler: impl Fn(&str, &str) -> (u16, String) + Send + 'static) -> Stub {
        use std::sync::atomic::Ordering;
        let server = tiny_http::Server::http("127.0.0.1:0").expect("bind stub");
        let addr = server.server_addr().to_ip().expect("addr");
        let seen: Seen = Default::default();
        let stop = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let (log, flag) = (seen.clone(), stop.clone());
        std::thread::spawn(move || {
            while !flag.load(Ordering::SeqCst) {
                let Ok(Some(mut req)) = server.recv_timeout(std::time::Duration::from_millis(50))
                else {
                    continue;
                };
                let mut body = String::new();
                let _ = std::io::Read::read_to_string(req.as_reader(), &mut body);
                let url = req.url().to_string();
                let (status, reply) = handler(&url, &body);
                log.lock().push((url, body));
                let _ =
                    req.respond(tiny_http::Response::from_string(reply).with_status_code(status));
            }
        });
        Stub {
            base: format!("http://{addr}"),
            seen,
            stop,
        }
    }

    fn run<F: std::future::Future>(f: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .expect("runtime")
            .block_on(f)
    }

    /// 404s a batch containing the poisoned id 13, like ESI; otherwise echoes
    /// every id back as `name-<id>`.
    fn names_handler(_url: &str, body: &str) -> (u16, String) {
        let ids: Vec<i64> = serde_json::from_str(body).unwrap();
        if ids.contains(&13) {
            return (404, r#"{"error":"Invalid IDs"}"#.into());
        }
        let rows: Vec<_> = ids
            .iter()
            .map(|id| serde_json::json!({"id": id, "name": format!("name-{id}")}))
            .collect();
        (200, serde_json::Value::Array(rows).to_string())
    }

    #[test]
    fn resolve_names_bisects_a_404_down_to_the_bad_id() {
        let server = stub(names_handler);
        let http = reqwest::Client::new();
        let out = run(resolve_names_at(&http, &server.base, &[1, 2, 13, 4]));
        let mut ids: Vec<_> = out.keys().copied().collect();
        ids.sort_unstable();
        assert_eq!(ids, vec![1, 2, 4], "only the poisoned id is lost");
    }

    #[test]
    fn resolve_names_aborts_instead_of_bisecting_on_a_rate_limit() {
        // 429 + a huge Retry-After is returned immediately by send_retrying;
        // the resolver must stop there rather than split 100 ids into ~200
        // more failing requests.
        let server = {
            let s = tiny_http::Server::http("127.0.0.1:0").expect("bind");
            let addr = s.server_addr().to_ip().expect("addr");
            let hits = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let counter = hits.clone();
            std::thread::spawn(move || {
                while let Ok(req) = s.recv() {
                    counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let h =
                        tiny_http::Header::from_bytes(&b"Retry-After"[..], &b"3600"[..]).unwrap();
                    let _ = req.respond(
                        tiny_http::Response::from_string("")
                            .with_status_code(429)
                            .with_header(h),
                    );
                }
            });
            (format!("http://{addr}"), hits)
        };
        let ids: Vec<i64> = (1..=100).collect();
        let out = run(resolve_names_at(&reqwest::Client::new(), &server.0, &ids));
        assert!(out.is_empty());
        assert_eq!(server.1.load(std::sync::atomic::Ordering::SeqCst), 1);
    }

    #[test]
    fn resolve_names_never_sends_structure_ids() {
        let server = stub(names_handler);
        let http = reqwest::Client::new();
        let structure = STRUCTURE_ID_MIN + 5;
        let out = run(resolve_names_at(&http, &server.base, &[structure, 7]));
        assert_eq!(out.len(), 1);
        let seen = server.seen.lock();
        assert_eq!(seen.len(), 1);
        assert!(!seen[0].1.contains(&structure.to_string()));
    }

    #[test]
    fn structure_lookups_negative_cache_denied_ids_and_cache_names() {
        let server = stub(|url, _| {
            if url.contains("/777/") {
                (403, r#"{"error":"forbidden"}"#.into())
            } else {
                (
                    200,
                    r#"{"name":"Fortizar","solar_system_id":30000142}"#.into(),
                )
            }
        });
        let auth = AuthState::new();
        let ids = [888, 777];
        let first = run(lookup_structures(&auth, 1, "tok", &server.base, &ids));
        assert_eq!(first.get(&888), Some(&("Fortizar".to_string(), 30000142)));
        assert!(!first.contains_key(&777));
        assert_eq!(server.seen.lock().len(), 2);

        // Second load: both outcomes come from memory, zero requests.
        let second = run(lookup_structures(&auth, 1, "tok", &server.base, &ids));
        assert_eq!(second, first);
        assert_eq!(server.seen.lock().len(), 2, "no repeat requests");

        // The denial is per character: another character still asks.
        run(lookup_structures(&auth, 2, "tok", &server.base, &[777]));
        assert_eq!(server.seen.lock().len(), 3);
    }

    #[test]
    fn structure_lookup_does_not_cache_server_errors() {
        let server = stub(|_, _| (400, "{}".into()));
        let auth = AuthState::new();
        run(lookup_structures(&auth, 1, "tok", &server.base, &[5]));
        run(lookup_structures(&auth, 1, "tok", &server.base, &[5]));
        assert_eq!(server.seen.lock().len(), 2, "a 400 is not remembered");
    }
}
