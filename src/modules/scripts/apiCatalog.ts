/** One entry in the script host/stdlib API, used to drive editor completions. */
export interface ApiEntry {
  /** The identifier as typed. */
  label: string;
  /** Human-readable signature shown inline in the completion. */
  signature: string;
  /** Longer description shown when the completion is highlighted. */
  doc: string;
}

/**
 * The functions a script can call. Shared by both engines (Rhai + JS) and
 * surfaced as editor autocompletion so the editor hints names + signatures.
 */
export const SCRIPT_API: ApiEntry[] = [
  {
    label: "log",
    signature: "log(message)",
    doc: "Append a line to the run log.",
  },
  {
    label: "notify",
    signature: "notify(title, body)",
    doc: "Fire a desktop notification.",
  },
  {
    label: "market_price",
    signature: "market_price(typeId, regionId?)",
    doc: "Price model for a type at a region (defaults to Jita / The Forge). Read fields like .sell / .buy.",
  },
  {
    label: "sde_type_info",
    signature: "sde_type_info(typeId)",
    doc: "SDE info for a type (.name, .group, .volume), or null if unknown.",
  },
  {
    label: "assets",
    signature: "assets()",
    doc: "The active character's assets (requires a logged-in character).",
  },
  {
    label: "corp_assets",
    signature: "corp_assets()",
    doc: "The character's corporation assets (needs a Director/asset role + scope; empty otherwise).",
  },
  {
    label: "my_orders",
    signature: "my_orders()",
    doc: "Your open market orders, each with .undercut and .bestPrice (needs esi-markets.read_character_orders + login).",
  },
  {
    label: "kv_get",
    signature: "kv_get(key)",
    doc: "Read a value from this script's private key/value store.",
  },
  {
    label: "kv_set",
    signature: "kv_set(key, value)",
    doc: "Write a value to this script's private key/value store.",
  },
  {
    label: "now",
    signature: "now()",
    doc: "Current time as Unix epoch seconds.",
  },
  {
    label: "json_encode",
    signature: "json_encode(value)",
    doc: "Serialize a value to a JSON string.",
  },
  {
    label: "json_decode",
    signature: "json_decode(text)",
    doc: "Parse a JSON string into a value.",
  },
  {
    label: "play_sound",
    signature: "play_sound(path)",
    doc: "Play a local audio file (mp3/wav/ogg/flac/aac/webm) through the app.",
  },
  {
    label: "send_alarm",
    signature: "send_alarm(text, detail?)",
    doc: "Post a high-severity alarm to the Info Panel (under Support). Optional detail (any value) shows as the body.",
  },
  {
    label: "write_message",
    signature: "write_message(text, detail?)",
    doc: "Post a plain text message to the Info Panel. Optional detail (any value) shows as the body.",
  },
  {
    label: "invoke",
    signature: "invoke(name, args)",
    doc: 'Call any registry capability by name (e.g. invoke("appraise", { items }), "sde_search", "route") \u2014 the generic gateway to every module read/compute op.',
  },
];
