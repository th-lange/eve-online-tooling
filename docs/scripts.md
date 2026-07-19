# Scripts

The **Scripts** module lets you author small snippets of code inside the app,
store them, and run them **once** or on a **timed loop**. A snippet is written in
either **Rhai** (a small Rust-native scripting language) or **JavaScript**, and
runs against a curated host API.

Scripts are **your own code**, so — unlike [plugins](./plugins.md), which are
untrusted, precompiled WASM in a capability sandbox — they get a real, trusted
API directly. There is deliberately **no** access to the filesystem, the OS
keychain, or raw ESI tokens; every run is also resource-bounded, so a runaway
loop errors out instead of freezing the app.

## Where scripts live

Snippets are stored in the app's data directory as a single JSON document
(`scripts`), and each script gets a private key/value store under
`<app_data_dir>/scripts/<id>/kv/`. Nothing else can read another script's store.

## Languages

Pick a language per script:

- **Rhai** — the last expression is the return value.
- **JavaScript** — the completion value of the program is the return value.
  Executed by the [`boa`](https://boajs.dev/) engine (a pure-Rust JS engine).

## The host API

Both languages expose the same functions:

| Function | Description |
| --- | --- |
| `log(message)` | Append a line to the run's log (shown under the editor). |
| `notify(title, body)` | Fire a desktop notification. |
| `market_price(typeId)` / `market_price(typeId, regionId)` | The multi-vector price model for a type (defaults to Jita / The Forge). |
| `sde_type_info(typeId)` | A type's SDE info (name, group, volume), or `null` if unknown. |
| `assets()` | The active character's **personal** assets (requires a logged-in character). |
| `corp_assets()` | The character's **corporation** assets (needs a Director / asset-hangar role + `esi-assets.read_corporation_assets.v1`; empty otherwise). |
| `my_orders()` | Your open market orders, each flagged `undercut` with the best competing `bestPrice` (requires the `esi-markets.read_character_orders` scope + login). |
| `kv_get(key)` | Read a value from this script's private store (`""` when unset). |
| `kv_set(key, value)` | Write a value to this script's private store. |
| `play_sound(path)` | Play a local audio file (mp3/wav/ogg/flac/aac/webm) through the app. |
| `send_alarm(text, detail?)` | Post a high-severity alarm to the Info Panel (under Support). Optional `detail` (any value; non-strings shown as JSON) becomes the entry's body. |
| `write_message(text, detail?)` | Post a plain text message to the Info Panel. Optional `detail` becomes the entry's body — pass a value/list to show the output behind the headline. |
| `invoke(name, args)` | Call any shared **capability** by name — the generic gateway to every module read/compute op (see below). |

`market_price` / `sde_type_info` / `assets` return structured data — a map/object
in each language, so you can read fields directly (e.g. `market_price(34).sell`).

The convenience functions above are thin wrappers over a shared **capability
registry** — the same operations plugins and the MCP bridge use, so data is
fetched and cached once. `invoke(name, args)` reaches the whole registry,
including ones without a dedicated wrapper: `invoke("sde_search", { query })`,
`invoke("appraise", { items })`, `invoke("route", { from, to })`,
`invoke("pi_overview", {})`, `invoke("industry_jobs", {})`. Prefer the small
"who's idle" summaries — `invoke("pi_idle_colonies", {})`,
`invoke("industry_line_status", {})` — over the full `pi_overview`/
`industry_jobs` dumps when a script only needs to know what needs
attention: much less data crosses into the sandbox, and Rhai's data-size
cap (below) is far less likely to matter.

> Browser/DOM globals like `Audio`, `fetch`, `document` or `window` **do not
> exist** — the JS engine is a standalone ECMAScript runtime, not a webpage. To
> play a sound, use `play_sound(path)`; for HTTP or data, use the host functions.
>
> On Linux, `play_sound` needs GStreamer's system plugins. If you launched the
> app from a **snap** terminal and hear nothing (`GStreamer element appsink not
> found`), see the audio troubleshooting note in the README — the snap's env
> hides the system plugins from the WebView.

The editor autocompletes these functions (and their signatures) as you type, so
you get inline hints for the whole API. The editor's collapsible **Examples**
section offers ready-made scripts (in both languages) — an outpriced-order sound
alarm, a demand-vs-saturation scan, and an idle-production alarm (PI colonies,
manufacturing, and invention, each check independently comment-outable) — that
you can load and tweak.

## Basic libraries

On top of the host API, every script has a small standard library. Both
languages get:

| Function | Description |
| --- | --- |
| `now()` | Current time as Unix epoch seconds. |
| `json_encode(value)` | Serialize a value to a JSON string. |
| `json_decode(text)` | Parse a JSON string into a value. |

Beyond that, each language keeps its own built-ins: **Rhai** bundles
arithmetic, string, array, map and math functions; **JavaScript** has the usual
`Math`, `JSON`, `Date`, `Array` and `String` globals.

### Example (Rhai)

```rhai
// Warn once per session when Tritanium's Jita sell dips below a threshold.
let sell = market_price(34).sell;
log("Tritanium sell: " + sell);
if sell < 5.0 && kv_get("warned") == "" {
    notify("Tritanium cheap", "Jita sell is " + sell);
    kv_set("warned", "1");
}
sell
```

### Example (JavaScript)

```js
const sell = market_price(34).sell;
log("Tritanium sell: " + sell);
sell;
```

## Running

- **Run** executes the snippet in the editor once and shows its return value,
  any `log()` output, and the elapsed time.
- **Loop every (minutes)** + **Loop armed**: with an interval set and the loop
  armed (its "Run" state), the saved script runs every that-many **minutes**.
  The loop is a single background timeline **in Rust** (not the script language,
  not the browser): it wakes once a minute and re-runs every armed script whose
  interval lands on that minute, so scripts sharing an interval fire together. It
  runs whether or not the Scripts page is open, and armed scripts show a **play
  icon** in the list. Arming/disarming (a save) takes effect on the next minute;
  overlapping runs of the same script are skipped, and it always runs the
  **saved** code.

## Limits

Every run is bounded so it can't hang the app:

- a wall-clock timeout,
- Rhai: an operation-count cap; JavaScript: a loop-iteration and recursion cap,
- Rhai only: a data-size cap (8 MiB of cumulative string content, 512 Ki
  array/map entries) covering both script-built values and capability
  results returned to the script (e.g. `industry_jobs`/`pi_overview`/`assets`
  over "All characters" on a long-lived account) — sized for real personal
  ESI payloads, not just script-authored strings,
- caps on log volume.

A snippet that exceeds a limit returns an error instead of running forever.
