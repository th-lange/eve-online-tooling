# Verifying the app via MCP (golden-expectation suite)

This is a live regression check an agent can run end-to-end through the MCP
bridge's [dev tier](./mcp.md#dev-tier-compute-engines-off-by-default): a small
set of facts computed independently of the app (from public EVE data and the
formulas documented below), diffed against what the running app's tools
return. Run it after changes to `sde/`, `market/`, or any exposed capability —
it's the fastest way to catch a silent regression in the deterministic
engines without a human at the keyboard.

## Setup

1. Enable **Start MCP bridge on launch** and **Expose compute engines to
   MCP** on the Plugins page's MCP bridge card (or start the bridge and flip
   both toggles for the session).
2. Poll `<app data dir>/mcp.json` for `{url, token}` (see
   [`mcp.md`](./mcp.md#hands-free-startup-for-agent-driven-testing)) and
   configure your MCP client.
3. Call `tools/list` and confirm `production_profit`, `fitting_stats`, and
   `reprocessing_yield` are present — if they're missing, the dev-tier toggle
   didn't take effect (re-check step 1).

## Golden facts

### 1. SDE lookup

`sde_type_info` for typeId `34` (Tritanium) returns `name: "Tritanium"`,
group `"Mineral"`. This is a fixed SDE fact (Tritanium's typeID has been `34`
since EVE's launch) — any other name/group means the SDE bootstrap or query
path is broken.

### 2. Route jump count

`route` from `"Jita"` to `"Amarr"` returns a `jumps` count that should be a
small integer > 0 and `reachable: true` (both are empire hubs on the
stargate network — always connected). `route` from a system to itself is
always `jumps: 0`.

### 3. Appraise arithmetic

`appraise` with `items: [{ name: "Tritanium", quantity: 1000 }]` must return
a sell value `== 1000 × (per-unit sell price from market_price for typeId
34)` and a cargo volume `== 1000 × 0.01` (Tritanium's packaged volume is
0.01 m³/unit, an SDE fact) — the appraisal is a pure multiply-and-sum over
`market_price`/`sde_type_info`, so any drift there is a bug in the
aggregation, not the price feed.

### 4. Production profit — required material quantities

Formula (from `CLAUDE.md`'s "Profit / EIV" section):

```
required_qty(mat) = max(runs, ceil(base_qty * runs * (1 - ME/100)))
material_cost     = Σ required_qty * price(mat)
job_fee           = (Σ base_qty * adjusted_price) * system_cost_index * (1 + facility_tax)
profit            = product_qty * product_price − material_cost − job_fee
```

Pinned golden case — Rifter blueprint (typeId `691`), base (ME 0) materials
per run: 32 000 Tritanium (34), 6 000 Pyerite (35), 2 500 Mexallon (36), 500
Isogen (37). At **ME 10, 1 run**, `required_qty = ceil(base * 0.9)`:
28 800 / 5 400 / 2 250 / 450. Call `production_profit` with
`{ blueprintTypeId: 691, runs: 1, me: 10 }` and diff its per-material
required quantities against these numbers — a Rust regression test
(`golden_production_profit_required_quantities` in `capabilities.rs`, gated
on `EVE_SDE_PATH`) pins the same values against the live SDE.

### 5. Fitting stats — hull layout

An empty `[Rifter, Golden Test]` EFT string (no modules fitted) still
resolves at the all-V skill basis `fitting_stats` always uses: 3 high slots,
3 mid slots, 4 low slots, 162.5 CPU output (130 base × 1.25, CPU Management
V), 51.25 PG output (41 base × 1.25, Power Grid Management V) — those two
skills bonus the hull unconditionally, no module needed to "trigger" them.
Call `fitting_stats` with that EFT text and diff `layout.{high,mid,low}Slots`
and `layout.{cpu,powergrid}Output` against these — pinned by
`golden_fitting_stats_rifter_layout` in `capabilities.rs`.

## Auth boundary (must always fail to reach)

`assets`, `corp_assets`, and `my_orders` must **not** appear in `tools/list`
under either tier, and a direct `tools/call` for any of them must return a
"method not found"/unknown-tool error, never data. This is pinned
structurally by the `mcp_never_reaches_auth_gated_data` Rust test
(`capabilities.rs`), which fails at compile-test time if any auth-gated
capability is ever flipped onto `mcp`/`mcp_dev` — an agent verifying the app
doesn't need to check this live, but may as a smoke test.
