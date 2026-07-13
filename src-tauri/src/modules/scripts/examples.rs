//! Bundled example scripts, offered in the editor's collapsible "Examples"
//! section. These are the single source of truth: the frontend lists them via
//! the `scripts_examples` command, and the engine tests run each against a fake
//! host, so what ships is exactly what's verified.

use serde::Serialize;

use super::types::Language;

/// Alarm + sound (and Info Panel output) when a market order is outpriced.
pub const OUTPRICED_RHAI: &str = r#"// Warn when any of your market orders is outpriced. The alarm shows in the
// Info Panel (under Support) — the headline plus the beaten orders as detail —
// lights the bell badge, and plays a sound.
// Needs the esi-markets.read_character_orders scope and a logged-in character.
let beaten = my_orders().filter(|o| o.undercut);
if beaten.len() > 0 {
    send_alarm("" + beaten.len() + " market order(s) outpriced", beaten);
    play_sound("/home/letigre/Music/jeremayjimenez-greece-eas-alarm-451404.mp3");
}
beaten.len()"#;

pub const OUTPRICED_JS: &str = r#"// Warn when any of your market orders is outpriced. The alarm shows in the
// Info Panel (under Support) — the headline plus the beaten orders as detail —
// lights the bell badge, and plays a sound.
// Needs the esi-markets.read_character_orders scope and a logged-in character.
const beaten = my_orders().filter((o) => o.undercut);
if (beaten.length > 0) {
  send_alarm(`${beaten.length} market order(s) outpriced`, beaten);
  play_sound("/home/letigre/Music/jeremayjimenez-greece-eas-alarm-451404.mp3");
}
beaten.length;"#;

/// Items whose demand outstrips saturation; posts the list as detail.
pub const DEMAND_RHAI: &str = r#"// Items whose demand (daily traded volume) far outstrips market saturation
// (competing orders). Posts the count as the headline and the list as detail.
let types = [34, 35, 36, 37, 38, 39, 40]; // the seven minerals
let hits = [];
for t in types {
    let m = market_price(t);
    let demand = if type_of(m.dailyVolume) == "()" { 0 } else { m.dailyVolume };
    let orders = if type_of(m.orderCount) == "()" { 0 } else { m.orderCount };
    if orders > 0 && demand > orders * 100 {
        let info = sde_type_info(t);
        hits.push(if type_of(info) == "()" { "" + t } else { info.name });
    }
}
write_message("Under-served items: " + hits.len(), hits);
hits"#;

pub const DEMAND_JS: &str = r#"// Items whose demand (daily traded volume) far outstrips market saturation
// (competing orders). Posts the count as the headline and the list as detail.
const types = [34, 35, 36, 37, 38, 39, 40]; // the seven minerals
const hits = [];
for (const t of types) {
  const m = market_price(t);
  const demand = m.dailyVolume ?? 0;
  const orders = m.orderCount ?? 0;
  if (orders > 0 && demand > orders * 100) {
    const info = sde_type_info(t);
    hits.push(info ? info.name : String(t));
  }
}
write_message(`Under-served items: ${hits.length}`, hits);
hits;"#;

/// Appraise a list via the shared `appraise` capability; posts the breakdown.
pub const APPRAISE_RHAI: &str = r#"// Appraise a list at market (shared `appraise` capability) and post the value
// to the Info Panel — headline total, full breakdown as detail.
let result = invoke("appraise", #{ items: [
    #{ name: "Tritanium", quantity: 1000000 },
    #{ name: "Pyerite", quantity: 500000 },
] });
write_message("List sell value: " + result.sellTotal + " ISK", result);
result.sellTotal"#;

pub const APPRAISE_JS: &str = r#"// Appraise a list at market (shared `appraise` capability) and post the value
// to the Info Panel — headline total, full breakdown as detail.
const result = invoke("appraise", { items: [
  { name: "Tritanium", quantity: 1000000 },
  { name: "Pyerite", quantity: 500000 },
] });
write_message(`List sell value: ${result.sellTotal} ISK`, result);
result.sellTotal;"#;

/// Route length watch via the shared `route` capability; alarms if long.
pub const ROUTE_RHAI: &str = r#"// Alarm if the trip between two systems is long or blocked (shared `route`
// capability). Tweak the systems and the threshold.
let r = invoke("route", #{ from: "Jita", to: "Amarr" });
if !r.reachable || r.jumps > 10 {
    send_alarm("Long route " + r.from + " -> " + r.to + ": " + r.jumps + " jumps", r);
} else {
    write_message("Route " + r.from + " -> " + r.to + ": " + r.jumps + " jumps", r);
}
r.jumps"#;

pub const ROUTE_JS: &str = r#"// Alarm if the trip between two systems is long or blocked (shared `route`
// capability). Tweak the systems and the threshold.
const r = invoke("route", { from: "Jita", to: "Amarr" });
if (!r.reachable || r.jumps > 10) {
  send_alarm(`Long route ${r.from} -> ${r.to}: ${r.jumps} jumps`, r);
} else {
  write_message(`Route ${r.from} -> ${r.to}: ${r.jumps} jumps`, r);
}
r.jumps;"#;

/// Count corporation asset stacks and post them.
pub const CORP_RHAI: &str = r#"// Count your corporation's asset stacks and post them (count as headline, the
// stacks as detail). Needs a Director / asset-hangar role + the assets:read
// scope; empty otherwise.
let stacks = corp_assets();
write_message("Corp asset stacks: " + stacks.len(), stacks);
stacks.len()"#;

pub const CORP_JS: &str = r#"// Count your corporation's asset stacks and post them (count as headline, the
// stacks as detail). Needs a Director / asset-hangar role + the assets:read
// scope; empty otherwise.
const stacks = corp_assets();
write_message(`Corp asset stacks: ${stacks.length}`, stacks);
stacks.length;"#;

/// One selectable example template shown in the editor.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExampleScript {
    pub id: String,
    pub name: String,
    pub language: Language,
    pub code: String,
}

fn example(id: &str, name: &str, language: Language, code: &str) -> ExampleScript {
    ExampleScript {
        id: id.to_string(),
        name: name.to_string(),
        language,
        code: code.to_string(),
    }
}

/// Every bundled example, grouped as (use-case × language).
pub fn examples() -> Vec<ExampleScript> {
    vec![
        example(
            "outpriced-rhai",
            "Outpriced order alarm (Rhai)",
            Language::Rhai,
            OUTPRICED_RHAI,
        ),
        example(
            "outpriced-js",
            "Outpriced order alarm (JS)",
            Language::Js,
            OUTPRICED_JS,
        ),
        example(
            "demand-rhai",
            "Demand vs saturation (Rhai)",
            Language::Rhai,
            DEMAND_RHAI,
        ),
        example(
            "demand-js",
            "Demand vs saturation (JS)",
            Language::Js,
            DEMAND_JS,
        ),
        example(
            "appraise-rhai",
            "Appraise a list (Rhai)",
            Language::Rhai,
            APPRAISE_RHAI,
        ),
        example(
            "appraise-js",
            "Appraise a list (JS)",
            Language::Js,
            APPRAISE_JS,
        ),
        example(
            "route-rhai",
            "Route length watch (Rhai)",
            Language::Rhai,
            ROUTE_RHAI,
        ),
        example(
            "route-js",
            "Route length watch (JS)",
            Language::Js,
            ROUTE_JS,
        ),
        example(
            "corp-rhai",
            "Corp asset count (Rhai)",
            Language::Rhai,
            CORP_RHAI,
        ),
        example("corp-js", "Corp asset count (JS)", Language::Js, CORP_JS),
    ]
}
