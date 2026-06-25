//! Local Intel — paste the in-game Local member list, classify every pilot by
//! corp/alliance and your standing toward them (blue / neutral / red).
//!
//! EVE never writes the Local *member list* to a log, and ESI has no "who's in
//! my system" endpoint, so the data comes from the player copying the member
//! list (a manual, EULA-safe action). We resolve names → ids → corp/alliance
//! via public ESI, then classify against the logged-in character's standings.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, State};

use crate::esi::{authed_get, resolve_names, AuthState, ESI_BASE};
use crate::storage;

/// Cap on pasted names per scan (Local tops out well below this).
const NAME_CAP: usize = 256;

/// One classified pilot in the pasted Local list.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalPilot {
    pub character_id: i64,
    pub name: String,
    pub corporation: String,
    pub alliance: Option<String>,
    /// Your standing toward the most-specific entity that has one (corp →
    /// alliance → faction), or null if you have none.
    pub standing: Option<f64>,
    /// "blue" (standing > 0) / "red" (< 0) / "neutral" (0 or unknown).
    pub threat: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalScanResult {
    pub pilots: Vec<LocalPilot>,
    pub reds: i64,
    pub neutrals: i64,
    pub blues: i64,
    /// Pasted names that couldn't be resolved to a character.
    pub unresolved: Vec<String>,
}

/// Parse the in-game Local member-list copy: one character name per line. Trims,
/// drops blanks, dedupes (preserving order), and caps the count.
fn parse_names(text: &str) -> Vec<String> {
    let mut seen = std::collections::HashSet::new();
    text.lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .filter(|l| seen.insert(l.to_string()))
        .take(NAME_CAP)
        .map(str::to_string)
        .collect()
}

/// Classify a standing into a threat band. `None`/0.0 = neutral.
fn threat_of(standing: Option<f64>) -> &'static str {
    match standing {
        Some(s) if s > 0.0 => "blue",
        Some(s) if s < 0.0 => "red",
        _ => "neutral",
    }
}

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
#[derive(Deserialize)]
struct Affiliation {
    character_id: i64,
    corporation_id: i64,
    #[serde(default)]
    alliance_id: Option<i64>,
    #[serde(default)]
    faction_id: Option<i64>,
}
#[derive(Deserialize)]
struct EsiStanding {
    from_id: i64,
    standing: f64,
}

/// Resolve a pasted Local member list to classified pilots. Name→id and
/// affiliation use public ESI POST endpoints; standings use the logged-in
/// character (`esi-characters.read_standings.v1`, already granted).
#[tauri::command]
pub async fn local_scan(
    app: AppHandle,
    auth_state: State<'_, AuthState>,
    text: String,
) -> Result<LocalScanResult, String> {
    let names = parse_names(&text);
    if names.is_empty() {
        return Ok(LocalScanResult {
            pilots: Vec::new(),
            reds: 0,
            neutrals: 0,
            blues: 0,
            unresolved: Vec::new(),
        });
    }
    let http = auth_state.http();

    // 1. names → character ids (public POST /universe/ids/). Non-character
    //    matches (corp/alliance names someone pasted) are ignored.
    let ids: UniverseIds = http
        .post(format!("{ESI_BASE}/latest/universe/ids/"))
        .json(&names)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .error_for_status()
        .map_err(|e| e.to_string())?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let resolved: HashMap<String, i64> =
        ids.characters.iter().map(|c| (c.name.clone(), c.id)).collect();
    let unresolved: Vec<String> = names
        .iter()
        .filter(|n| !resolved.contains_key(*n))
        .cloned()
        .collect();
    let char_ids: Vec<i64> = ids.characters.iter().map(|c| c.id).collect();

    // 2. character ids → corp/alliance/faction (public POST /characters/affiliation/).
    let affiliations: Vec<Affiliation> = if char_ids.is_empty() {
        Vec::new()
    } else {
        http.post(format!("{ESI_BASE}/latest/characters/affiliation/"))
            .json(&char_ids)
            .send()
            .await
            .map_err(|e| e.to_string())?
            .error_for_status()
            .map_err(|e| e.to_string())?
            .json()
            .await
            .map_err(|e| e.to_string())?
    };

    // 3. resolve corp/alliance ids → names (POST /universe/names/).
    let mut org_ids: Vec<i64> = Vec::new();
    for a in &affiliations {
        org_ids.push(a.corporation_id);
        if let Some(al) = a.alliance_id {
            org_ids.push(al);
        }
    }
    org_ids.extend(char_ids.iter().copied());
    let org_names = resolve_names(&auth_state, &org_ids).await;

    // 4. the logged-in character's standings, keyed by entity id.
    let standings = load_standings(&app, &auth_state).await;

    let aff_by_id: HashMap<i64, &Affiliation> =
        affiliations.iter().map(|a| (a.character_id, a)).collect();

    let mut pilots: Vec<LocalPilot> = Vec::new();
    let (mut reds, mut neutrals, mut blues) = (0i64, 0i64, 0i64);
    for c in &ids.characters {
        let aff = aff_by_id.get(&c.id);
        let corporation = aff
            .and_then(|a| org_names.get(&a.corporation_id).cloned())
            .unwrap_or_default();
        let alliance = aff
            .and_then(|a| a.alliance_id)
            .and_then(|al| org_names.get(&al).cloned());
        // Standing: most specific entry wins (corp → alliance → faction).
        let standing = aff.and_then(|a| {
            standings
                .get(&a.corporation_id)
                .or_else(|| a.alliance_id.and_then(|al| standings.get(&al)))
                .or_else(|| a.faction_id.and_then(|f| standings.get(&f)))
                .copied()
        });
        let threat = threat_of(standing);
        match threat {
            "red" => reds += 1,
            "blue" => blues += 1,
            _ => neutrals += 1,
        }
        pilots.push(LocalPilot {
            character_id: c.id,
            name: org_names.get(&c.id).cloned().unwrap_or_else(|| c.name.clone()),
            corporation,
            alliance,
            standing,
            threat: threat.to_string(),
        });
    }
    // Reds first, then neutrals, then blues; by name within a band.
    pilots.sort_by(|a, b| {
        threat_rank(&a.threat)
            .cmp(&threat_rank(&b.threat))
            .then_with(|| a.name.cmp(&b.name))
    });

    Ok(LocalScanResult {
        pilots,
        reds,
        neutrals,
        blues,
        unresolved,
    })
}

fn threat_rank(threat: &str) -> u8 {
    match threat {
        "red" => 0,
        "neutral" => 1,
        _ => 2,
    }
}

/// The logged-in character's standings as an entity-id → standing map. Returns
/// empty (everyone neutral) if no character is logged in or the fetch fails.
async fn load_standings(app: &AppHandle, auth_state: &AuthState) -> HashMap<i64, f64> {
    let Ok(dir) = app.path().app_data_dir() else {
        return HashMap::new();
    };
    let Some(character_id) = storage::load_roster(&dir).into_iter().next().map(|c| c.character_id)
    else {
        return HashMap::new();
    };
    let standings: Result<Vec<EsiStanding>, _> = authed_get(
        auth_state,
        character_id,
        &format!("/latest/characters/{character_id}/standings/"),
    )
    .await;
    standings
        .map(|rows| rows.into_iter().map(|s| (s.from_id, s.standing)).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_dedupes_and_trims_names() {
        let text = "  Alice \nBob\n\nAlice\n  \nCharlie\n";
        assert_eq!(parse_names(text), vec!["Alice", "Bob", "Charlie"]);
    }

    #[test]
    fn classifies_standing_bands() {
        assert_eq!(threat_of(Some(5.0)), "blue");
        assert_eq!(threat_of(Some(-2.5)), "red");
        assert_eq!(threat_of(Some(0.0)), "neutral");
        assert_eq!(threat_of(None), "neutral");
    }
}
