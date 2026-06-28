# PYFA oracle (for the fitting golden suite, #176)

The fitting engine's acceptance gate (#176) asserts a handful of canonical fits
against **PYFA's** numbers. PYFA's `eos` engine is the reference; this harness
runs it **headless** to capture those numbers as [`golden.json`](./golden.json),
so the Rust engine can be locked to them.

PYFA is a wx GUI app pinned to old deps, but `eos` (the calc engine) only needs
the gamedata DB plus SQLAlchemy — no wx, numpy or matplotlib for DPS/EHP/cap/
speed. The recipe below stands it up with a minimal venv.

## One-time setup

From a checkout of [pyfa-org/Pyfa](https://github.com/pyfa-org/Pyfa) (tested at
**v2.67.0**), with this directory's files copied alongside:

```sh
cd /path/to/Pyfa
python3 -m venv venv
./venv/bin/pip install 'sqlalchemy==1.4.50' logbook python-dateutil pyyaml cryptography
mkdir -p wxstub && cp /path/to/tools/pyfa-oracle/wx_stub.py wxstub/wx.py

# Build the gamedata DB (eve.db, ~100 MB) from Pyfa's bundled staticdata:
PYTHONPATH=wxstub ./venv/bin/python db_update.py

# Run the oracle -> golden.json
cp /path/to/tools/pyfa-oracle/oracle.py .
PYTHONPATH=wxstub ./venv/bin/python oracle.py > golden.json
```

### Why each piece

- **`sqlalchemy==1.4.50`** — `eos` uses the legacy ORM API (`relation`, `mapper`)
  removed in SQLAlchemy 2.x.
- **`wx_stub.py`** — Pyfa's root `config.py` imports `wx` only to build a few
  `wx.Colour(...)` constants; the stub satisfies the import with no GUI.
- **in-memory saveddata** — the oracle points `saveddata` at `sqlite:///:memory:`
  so no user save DB is touched; only the gamedata `eve.db` is read.
- **headless owner wiring** — without a DB session, fitted modules/drones don't
  get their `owner` back-populated, so the oracle sets `item.owner = fit`.

## Output

`golden.json` is a list of `{ label, weaponDps, droneDps, totalDps, ehp,
capStable, capStatePct, maxVelocity, alignTime }`, all-V character, PYFA v2.67.0
against its bundled SDE. Tolerances for the Rust golden suite: DPS/EHP ~0.5%,
cap-stable% ~1pp, velocity/align tight.

Add fits by extending the `FITS` list in `oracle.py` and re-running.
