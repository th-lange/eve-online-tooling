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
    let text = if bytes.len() >= 2 && bytes[0] == 0xFF && bytes[1] == 0xFE {
        // UTF-16LE with BOM.
        let u16s: Vec<u16> = bytes[2..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        String::from_utf16_lossy(&u16s)
    } else {
        String::from_utf8_lossy(&bytes).into_owned()
    };
    // EVE prefixes U+FEFF (BOM / zero-width no-break space) to *every* logged
    // chat line, not just the file start. Left in place, each message line reads
    // as `\u{feff}[ ts ] …` and header detection (`starts_with('[')`) fails, so
    // no messages parse. It's never meaningful in chat text, so strip them all.
    Some(text.replace('\u{feff}', ""))
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

/// Longest message we keep (chat text is untrusted input — bound the memory a
/// hostile paste can occupy).
const MAX_MESSAGE_LEN: usize = 10_000;

/// One parsed chat message: a stable `key` identifying it independently of
/// which log file it came from, plus the message `text`.
///
/// `key` is the header's `[ timestamp ] Sender` — identical across every
/// client's log of the same channel, so the same message logged by several of
/// the user's online characters can be de-duplicated to a single import.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ChatEntry {
    pub key: String,
    pub text: String,
}

/// Each player chat entry (identity + text), in order. A message that contains
/// linebreaks (a multi-line paste) is logged as one header line
/// (`[ ts ] Sender > first line`) followed by bare continuation lines — those
/// are re-joined onto their message here. System lines and empty messages are
/// skipped. Pure (testable).
pub fn parse_chat_entries(content: &str) -> Vec<ChatEntry> {
    let mut out: Vec<ChatEntry> = Vec::new();
    // Whether the previous header line was a (kept) player message, so bare
    // continuation lines know where they belong.
    let mut in_message = false;
    for line in content.lines() {
        // Header lines look like `[ 2026.06.25 12:00:00 ] Sender > text`.
        let header = line
            .starts_with('[')
            .then(|| line.split_once("] "))
            .flatten()
            .and_then(|(ts, after)| after.split_once(" > ").map(|(s, m)| (ts, s, m)));
        match header {
            Some((ts, sender, msg)) => {
                if sender.trim() == "EVE System" {
                    in_message = false;
                } else {
                    out.push(ChatEntry {
                        // `ts` still carries the leading '['; keep it as-is —
                        // we only need it to be stable, not pretty.
                        key: format!("{ts}] {}", sender.trim()),
                        text: msg.trim().to_string(),
                    });
                    in_message = true;
                }
            }
            None => {
                // Continuation of the previous message (multi-line paste).
                if in_message {
                    if let Some(last) = out.last_mut() {
                        if last.text.len() + line.len() < MAX_MESSAGE_LEN {
                            last.text.push('\n');
                            last.text.push_str(line.trim());
                        }
                    }
                }
            }
        }
    }
    out.retain(|e| !e.text.trim().is_empty());
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The message text of each entry — what the old `parse_chat_messages`
    /// returned; kept as a test helper now that callers want `ChatEntry`.
    fn parse_chat_messages(content: &str) -> Vec<String> {
        parse_chat_entries(content).into_iter().map(|e| e.text).collect()
    }

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

    #[test]
    fn entry_keys_are_stable_across_clients_but_distinct_per_message() {
        // Two clients logging the same channel produce identical keys for the
        // same message (dedup), while a repeat of the same text at a different
        // time keeps a distinct key (not deduped).
        let a = parse_chat_entries("[ 2026.06.25 12:00:05 ] Alice Pilot > Tritanium");
        let b = parse_chat_entries("[ 2026.06.25 12:00:05 ] Alice Pilot > Tritanium");
        assert_eq!(a[0].key, b[0].key);

        let twice = parse_chat_entries(
            "[ 2026.06.25 12:00:05 ] Alice Pilot > Tritanium\n\
             [ 2026.06.25 12:00:09 ] Alice Pilot > Tritanium",
        );
        assert_ne!(twice[0].key, twice[1].key);
    }

    #[test]
    fn read_chatlog_strips_per_line_bom_from_utf16() {
        // EVE writes UTF-16LE with a file BOM *and* a U+FEFF before every line.
        // Without stripping those, each header reads as `\u{feff}[ ts ] …` and
        // no messages parse (the corp-capture bug this guards against).
        let content = "\u{feff}[ 2026.07.09 16:46:33 ] Tarimaka > Titanium Carbide 30000\n\
             \u{feff}[ 2026.07.09 16:47:00 ] Tarimaka > Fullerides";
        let mut bytes = vec![0xFF, 0xFE];
        for u in content.encode_utf16() {
            bytes.extend_from_slice(&u.to_le_bytes());
        }
        let path =
            std::env::temp_dir().join(format!("chatlog_bom_{}_{}.txt", std::process::id(), line!()));
        std::fs::write(&path, &bytes).unwrap();
        let text = read_chatlog(&path).unwrap();
        std::fs::remove_file(&path).ok();

        assert!(!text.contains('\u{feff}'), "per-line BOMs should be stripped");
        assert_eq!(
            parse_chat_messages(&text),
            vec!["Titanium Carbide 30000", "Fullerides"]
        );
    }

    #[test]
    fn rejoins_multiline_pastes_onto_their_message() {
        let log = "\
[ 2026.06.25 12:00:00 ] EVE System > MOTD
ignored continuation of a system line
[ 2026.06.25 12:00:05 ] Alice Pilot > Tritanium 100
Pyerite 50
Mexallon
[ 2026.06.25 12:00:09 ] Bob Pilot > o7";
        assert_eq!(
            parse_chat_messages(log),
            vec!["Tritanium 100\nPyerite 50\nMexallon", "o7"]
        );
    }
}
