//! Shared EVE chatlog reading + parsing.
//!
//! EVE writes chatlogs as UTF-16LE with a BOM; message lines look like
//! `[ 2026.06.25 12:00:00 ] Sender Name > text`. Used by the Local Intel
//! module (who spoke in Local) and the Shopping module's chat capture (which
//! items were linked in a channel).

use std::collections::HashSet;

/// Read an EVE chatlog file, decoding UTF-16LE (the format EVE writes) or UTF-8.
pub fn read_chatlog(path: &std::path::Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        // UTF-16LE with BOM.
        let u16s: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        Some(String::from_utf16_lossy(&u16s))
    } else {
        Some(String::from_utf8_lossy(&bytes).into_owned())
    }
}

/// Distinct sender names from chatlog content, in order of first appearance.
/// The member list isn't logged, so this only yields pilots who actually
/// spoke; `EVE System` lines are skipped. Pure (testable).
pub fn parse_chat_senders(content: &str) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for line in content.lines() {
        let Some((_, after)) = line.split_once("] ") else {
            continue;
        };
        let Some((sender, _msg)) = after.split_once(" > ") else {
            continue;
        };
        let s = sender.trim();
        if s.is_empty() || s == "EVE System" {
            continue;
        }
        if seen.insert(s.to_string()) {
            out.push(s.to_string());
        }
    }
    out
}

/// The message text of each chat line, in order. System lines and empty
/// messages are skipped. Pure (testable).
pub fn parse_chat_messages(content: &str) -> Vec<String> {
    content
        .lines()
        .filter_map(|line| {
            let (_, after) = line.split_once("] ")?;
            let (sender, msg) = after.split_once(" > ")?;
            if sender.trim() == "EVE System" {
                return None;
            }
            let m = msg.trim();
            (!m.is_empty()).then(|| m.to_string())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    const LOG: &str = "\
[ 2026.06.25 12:00:00 ] EVE System > Channel MOTD: hi
[ 2026.06.25 12:00:05 ] Alice Pilot > Tritanium
[ 2026.06.25 12:00:06 ] Bob Pilot > Pyerite
[ 2026.06.25 12:00:07 ] Alice Pilot > o7
[ 2026.06.25 12:00:08 ] Bob Pilot >   ";

    #[test]
    fn parses_senders_in_order_deduped() {
        assert_eq!(parse_chat_senders(LOG), vec!["Alice Pilot", "Bob Pilot"]);
    }

    #[test]
    fn parses_messages_and_skips_system_and_empty_lines() {
        assert_eq!(parse_chat_messages(LOG), vec!["Tritanium", "Pyerite", "o7"]);
    }
}
