//! Pure parser for EVE **gamelog** combat lines → typed [`DpsEvent`].
//!
//! EVE writes a per-session gamelog (`…/EVE/logs/Gamelogs/*.txt`) with one line
//! per combat tick, shaped like:
//!
//! ```text
//! [ 2026.06.25 12:00:00 ] (combat) <color=0xff..><b>342</b> <color=0x77..><font size=10>to</font> <b><color=0xff..>Target Pilot[CORP](Cruiser)</b> ... - Tractor Beam I - Hits
//! ```
//!
//! The numbers and direction live inside HTML-ish markup. The patterns here are
//! ports of PyEveLiveDPS's regexes, but implemented with plain substring scans
//! (no `regex` dependency, matching the rest of this crate). Direction is read
//! from the `>to<` / `>from<` / ` to ` / ` by ` markers EVE emits.
//!
//! This module is **pure and unit-tested**; the tail loop in [`super::commands`]
//! feeds it lines and never re-implements parsing.

use serde::Serialize;

/// What a parsed combat line represents, already resolved to a direction
/// (out = you are the source, in = you are the target).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum EventKind {
    /// Damage you dealt.
    DamageOut,
    /// Damage you took.
    DamageIn,
    /// Remote armor/shield/hull you repaired onto someone else.
    RepOut,
    /// Remote armor/shield/hull repaired onto you.
    RepIn,
    /// Capacitor you transmitted to someone (remote cap transfer).
    CapTransferOut,
    /// Capacitor transmitted to you.
    CapTransferIn,
    /// Enemy capacitor you removed (neut) or stole (nos) — cap warfare you apply.
    CapWarfareOut,
    /// Your capacitor removed/stolen by an enemy.
    CapWarfareIn,
    /// Ore mined (the amount is in *units*; `volume` carries the m³ once the tail
    /// loop resolves the ore's volume from the SDE).
    Mining,
}

/// One parsed combat event. `pilot`/`ship`/`weapon` are populated for damage
/// lines (used by the breakdown tables, slice 2); they're `None` otherwise.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DpsEvent {
    /// Seconds since the unix epoch, parsed from the `[ … ]` timestamp (UTC).
    pub ts: i64,
    pub kind: EventKind,
    /// The damage / repair / capacitor amount, or mined **units** (always positive).
    pub amount: i64,
    pub pilot: Option<String>,
    pub ship: Option<String>,
    pub weapon: Option<String>,
    /// Hit quality on damage lines ("Grazes" … "Penetrates", "Smashes",
    /// "Wrecks"); `None` for non-damage events.
    pub quality: Option<String>,
    /// Mined ore type name (mining lines only) — used to resolve its volume.
    pub ore: Option<String>,
    /// Mined volume in m³ (mining only; filled by the tail loop from the SDE).
    pub volume: f64,
}

/// Parse one gamelog line into a [`DpsEvent`], or `None` if it isn't a combat
/// line we track (chat, system messages, mining, malformed lines, …).
pub fn parse_line(line: &str) -> Option<DpsEvent> {
    if line.contains("(mining)") {
        return parse_mining(line);
    }
    if !line.contains("(combat)") {
        return None;
    }
    let ts = parse_ts(line)?;
    let kind = classify(line)?;
    let amount = first_bold_int(line)?.unsigned_abs() as i64;
    // Pilot/ship/weapon are only meaningful (and only present) on damage lines;
    // they drive the breakdown tables.
    let (pilot, ship, weapon, quality) = match kind {
        EventKind::DamageOut | EventKind::DamageIn => extract_actor(line),
        _ => (None, None, None, None),
    };
    Some(DpsEvent {
        ts,
        kind,
        amount,
        pilot,
        ship,
        weapon,
        quality,
        ore: None,
        volume: 0.0,
    })
}

/// Parse a `(mining)` line: `… <b>34</b> units of <…>Veldspar<…>`. The amount is
/// the last integer before `units of`; the ore name is the first tagged text
/// after it. `volume` is left 0.0 — the tail loop fills m³ from the SDE.
fn parse_mining(line: &str) -> Option<DpsEvent> {
    let ts = parse_ts(line)?;
    let idx = line.find(" units of ")?;
    let amount = last_int(&line[..idx])?;
    let ore = first_inner_text(&line[idx + " units of ".len()..]);
    Some(DpsEvent {
        ts,
        kind: EventKind::Mining,
        amount,
        pilot: None,
        ship: None,
        weapon: None,
        quality: None,
        ore,
        volume: 0.0,
    })
}

/// The last integer in `s` after markup is stripped (mining amount sits just
/// before `units of`; the only earlier digits are the timestamp).
fn last_int(s: &str) -> Option<i64> {
    let plain = strip_tags(s);
    let bytes = plain.as_bytes();
    let mut end = bytes.len();
    while end > 0 && !bytes[end - 1].is_ascii_digit() {
        end -= 1;
    }
    if end == 0 {
        return None;
    }
    let mut start = end;
    while start > 0 && bytes[start - 1].is_ascii_digit() {
        start -= 1;
    }
    plain.get(start..end)?.parse().ok()
}

/// First non-empty text between a `>` and the next `<` (the ore name lives in
/// `>Veldspar<` after the colour/bold tags).
fn first_inner_text(s: &str) -> Option<String> {
    let mut rest = s;
    while let Some(gt) = rest.find('>') {
        let tail = &rest[gt + 1..];
        let lt = tail.find('<').unwrap_or(tail.len());
        let t = tail[..lt].trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
        rest = &tail[lt..];
    }
    None
}

/// Pull the counterparty pilot + ship and the weapon from a damage line. EVE
/// renders the name in the **last** `<b>…</b>` block as `NAME[CORP](SHIP)`,
/// followed by ` - WEAPON - quality`. (The first `<b>…</b>` is the damage
/// number.) NPCs may omit the `[CORP]`/`(SHIP)` parts, so every field is
/// optional.
fn extract_actor(
    line: &str,
) -> (
    Option<String>,
    Option<String>,
    Option<String>,
    Option<String>,
) {
    let mut pilot = None;
    let mut ship = None;
    let mut weapon = None;
    let mut quality = None;
    if let Some(bpos) = line.rfind("<b>") {
        let after = &line[bpos + 3..];
        let (block, tail) = after.split_once("</b>").unwrap_or((after, ""));
        let plain = strip_tags(block); // "NAME[CORP](SHIP)"
        let name_end = plain.find(['[', '(']).unwrap_or(plain.len());
        let name = plain[..name_end].trim();
        if !name.is_empty() {
            pilot = Some(name.to_string());
        }
        if let Some(open) = plain.find('(') {
            if let Some(close) = plain[open + 1..].find(')') {
                let s = plain[open + 1..open + 1 + close].trim();
                if !s.is_empty() {
                    ship = Some(s.to_string());
                }
            }
        }
        // Weapon: the first ` - `-separated field after the name block (the tail
        // looks like ` - WEAPON - quality`; drop the leading separator first).
        let tail_txt = strip_tags(tail);
        let fields: Vec<&str> = tail_txt
            .trim_start_matches(['-', ' '])
            .split(" - ")
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .collect();
        weapon = fields.first().map(|s| s.to_string());
        // The hit quality is the last field ("… - WEAPON - Smashes"; a bare
        // "… - Hits" has quality only, which first() also picked up as weapon —
        // long-standing behaviour the breakdown table tolerates).
        quality = fields.last().map(|s| s.to_string());
    }
    (pilot, ship, weapon, quality)
}

/// Strip `<…>` markup from a fragment, returning the trimmed plain text.
fn strip_tags(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for c in s.chars() {
        match c {
            '<' => in_tag = true,
            '>' => in_tag = false,
            _ if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.trim().to_string()
}

/// Decide which series a combat line belongs to. Order matters — the specific
/// remote-/cap-warfare phrases are checked before the generic damage `to`/`from`.
fn classify(line: &str) -> Option<EventKind> {
    // Remote capacitor transfer (logistics).
    if line.contains("remote capacitor transmitted to ") {
        return Some(EventKind::CapTransferOut);
    }
    if line.contains("remote capacitor transmitted by ") {
        return Some(EventKind::CapTransferIn);
    }
    // Remote reps — armor repaired / shield boosted / hull repaired.
    if is_remote_rep(line, "to ") {
        return Some(EventKind::RepOut);
    }
    if is_remote_rep(line, "by ") {
        return Some(EventKind::RepIn);
    }
    // Nosferatu: you drain *from* an enemy (you gain), or it's drained *to* an
    // enemy from you (you lose).
    if line.contains("energy drained from ") {
        return Some(EventKind::CapWarfareOut);
    }
    if line.contains("energy drained to ") {
        return Some(EventKind::CapWarfareIn);
    }
    // Energy neutralized — direction isn't in the text, so use PyEveLiveDPS's
    // signal: the outgoing line carries the `ff7fffff` colour code.
    if line.contains("energy neutralized") {
        return Some(if line.contains("ff7fffff") {
            EventKind::CapWarfareOut
        } else {
            EventKind::CapWarfareIn
        });
    }
    // Plain weapon damage. EVE wraps the direction word in its own tag, so the
    // reliable marker is the bracketed `>to<` / `>from<`.
    if line.contains(">to<") {
        return Some(EventKind::DamageOut);
    }
    if line.contains(">from<") {
        return Some(EventKind::DamageIn);
    }
    None
}

/// True if the line is a remote armor/shield/hull rep with the given direction
/// suffix (`"to "` for outgoing, `"by "` for incoming).
fn is_remote_rep(line: &str, dir: &str) -> bool {
    line.contains(&format!("remote armor repaired {dir}"))
        || line.contains(&format!("remote shield boosted {dir}"))
        || line.contains(&format!("remote hull repaired {dir}"))
}

/// Extract the first integer inside a `<b>…</b>` tag (optionally signed, e.g.
/// the `+`/`-` on a nosferatu line). Returns `None` if there's no bold number.
fn first_bold_int(line: &str) -> Option<i64> {
    let after = &line[line.find("<b>")? + 3..];
    let bytes = after.as_bytes();
    // Skip to the first digit or sign.
    let mut i = 0;
    while i < bytes.len() && !(bytes[i].is_ascii_digit() || bytes[i] == b'+' || bytes[i] == b'-') {
        i += 1;
    }
    let start = i;
    if i < bytes.len() && (bytes[i] == b'+' || bytes[i] == b'-') {
        i += 1;
    }
    while i < bytes.len() && bytes[i].is_ascii_digit() {
        i += 1;
    }
    after.get(start..i)?.parse().ok()
}

/// Parse the leading `[ 2026.06.25 12:00:00 ]` stamp to unix epoch seconds (UTC).
fn parse_ts(line: &str) -> Option<i64> {
    let open = line.find('[')?;
    let close = line[open..].find(']')? + open;
    let inner = line[open + 1..close].trim();
    let (date, time) = inner.split_once(' ')?;
    let mut d = date.split('.');
    let y: i64 = d.next()?.trim().parse().ok()?;
    let mo: i64 = d.next()?.parse().ok()?;
    let da: i64 = d.next()?.parse().ok()?;
    let mut t = time.split(':');
    let h: i64 = t.next()?.parse().ok()?;
    let mi: i64 = t.next()?.parse().ok()?;
    let s: i64 = t.next()?.parse().ok()?;
    if !(1..=12).contains(&mo) || !(1..=31).contains(&da) {
        return None;
    }
    Some(
        crate::util::time::days_from_civil(y as i32, mo as u32, da as u32) * 86_400
            + h * 3_600
            + mi * 60
            + s,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // Representative gamelog lines (English overview). Real lines are longer but
    // contain these exact markers.
    fn ts() -> i64 {
        // 2026.06.25 12:00:00 UTC
        crate::util::time::days_from_civil(2026, 6, 25) * 86_400 + 12 * 3_600
    }

    #[test]
    fn parses_damage_out_and_in() {
        let out = "[ 2026.06.25 12:00:00 ] (combat) <color=0xff..><b>342</b> <color=0x77ffffff><font size=10>to</font> <b><color=0xff..>Target[X](Cruiser)</b> - Tractor Beam I - Hits";
        let e = parse_line(out).unwrap();
        assert_eq!(e.kind, EventKind::DamageOut);
        assert_eq!(e.amount, 342);
        assert_eq!(e.ts, ts());
        assert_eq!(e.quality.as_deref(), Some("Hits"));

        let smash = out.replace(" - Hits", " - Smashes");
        assert_eq!(
            parse_line(&smash).unwrap().quality.as_deref(),
            Some("Smashes")
        );

        let inc = "[ 2026.06.25 12:00:00 ] (combat) <color=0xff..><b>88</b> <color=0x77ffffff><font size=10>from</font> <b><color=0xff..>Bad Guy[Y](Frigate)</b> - Hits";
        let e = parse_line(inc).unwrap();
        assert_eq!(e.kind, EventKind::DamageIn);
        assert_eq!(e.amount, 88);
    }

    #[test]
    fn parses_remote_reps_both_directions() {
        let out = "[ 2026.06.25 12:00:00 ] (combat) <color=0xff..><b>250</b> remote shield boosted to <color=0xff..>Friendly</color>";
        assert_eq!(parse_line(out).unwrap().kind, EventKind::RepOut);
        let inc = "[ 2026.06.25 12:00:00 ] (combat) <color=0xff..><b>250</b> remote armor repaired by <color=0xff..>Logi</color>";
        assert_eq!(parse_line(inc).unwrap().kind, EventKind::RepIn);
    }

    #[test]
    fn parses_cap_transfer_and_warfare() {
        let xfer = "[ 2026.06.25 12:00:00 ] (combat) <color=0xff..><b>40</b> remote capacitor transmitted to <color=0xff..>Mate</color>";
        assert_eq!(parse_line(xfer).unwrap().kind, EventKind::CapTransferOut);

        let neut_out = "[ 2026.06.25 12:00:00 ] (combat) <color=0xffff7fffff><b>120</b> energy neutralized <color=0xff..>Victim</color>";
        assert_eq!(parse_line(neut_out).unwrap().kind, EventKind::CapWarfareOut);

        let nos_in = "[ 2026.06.25 12:00:00 ] (combat) <color=0xff..><b>-60</b> energy drained to <color=0xff..>Thief</color>";
        let e = parse_line(nos_in).unwrap();
        assert_eq!(e.kind, EventKind::CapWarfareIn);
        assert_eq!(e.amount, 60); // sign stripped
    }

    #[test]
    fn extracts_pilot_ship_and_weapon_from_damage() {
        let line = "[ 2026.06.25 12:00:00 ] (combat) <color=0xff00ffff><b>342</b> <color=0x77ffffff><font size=10>to</font> <b><color=0xffffffff>Target Pilot[CORP](Cynabal)</b><color=0x77ffffff><font size=10> - 425mm AutoCannon II - Hits</font></color>";
        let e = parse_line(line).unwrap();
        assert_eq!(e.kind, EventKind::DamageOut);
        assert_eq!(e.amount, 342);
        assert_eq!(e.pilot.as_deref(), Some("Target Pilot"));
        assert_eq!(e.ship.as_deref(), Some("Cynabal"));
        assert_eq!(e.weapon.as_deref(), Some("425mm AutoCannon II"));
    }

    #[test]
    fn extracts_npc_name_without_corp_or_ship() {
        let line = "[ 2026.06.25 12:00:00 ] (combat) <color=0xffcc0000><b>88</b> <color=0x77ffffff><font size=10>from</font> <b><color=0xffffffff>Angel Cartel Outlaw</b><color=0x77ffffff><font size=10> - Hits</font></color>";
        let e = parse_line(line).unwrap();
        assert_eq!(e.kind, EventKind::DamageIn);
        assert_eq!(e.pilot.as_deref(), Some("Angel Cartel Outlaw"));
        assert_eq!(e.ship, None);
        assert_eq!(e.weapon.as_deref(), Some("Hits"));
    }

    #[test]
    fn non_damage_lines_carry_no_actor() {
        let xfer = "[ 2026.06.25 12:00:00 ] (combat) <color=0xff..><b>40</b> remote capacitor transmitted to <color=0xff..>Mate</color>";
        let e = parse_line(xfer).unwrap();
        assert_eq!(e.pilot, None);
        assert_eq!(e.weapon, None);
    }

    #[test]
    fn parses_mining_amount_and_ore() {
        let line = "[ 2026.06.25 12:00:00 ] (mining) <color=0xffffffff><b>34</b> units of <color=0xffe6b800><b>Dense Veldspar</b></color>";
        let e = parse_line(line).unwrap();
        assert_eq!(e.kind, EventKind::Mining);
        assert_eq!(e.amount, 34);
        assert_eq!(e.ore.as_deref(), Some("Dense Veldspar"));
        assert_eq!(e.volume, 0.0); // filled later by the tail loop
        assert_eq!(e.ts, ts());
    }

    #[test]
    fn ignores_non_combat_lines() {
        assert!(parse_line("[ 2026.06.25 12:00:00 ] (none) Some other line").is_none());
        assert!(parse_line("garbage").is_none());
    }
}
