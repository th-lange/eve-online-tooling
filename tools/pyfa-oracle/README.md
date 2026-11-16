# PYFA oracle (for the fitting golden suite, #176 / #1272)

The fitting engine's acceptance gate asserts canonical fits against **PYFA's**
numbers. PYFA's `eos` engine is the reference; this harness runs it **headless**
to capture those numbers as [`golden.json`](./golden.json), so the Rust engine
can be locked to them.

PYFA is a wx GUI app, but `eos` (the calc engine) only needs the gamedata DB
plus SQLAlchemy — no wx, numpy or matplotlib for DPS/EHP/cap/tank. The recipe
below stands it up with a minimal venv.

## One-time setup

Two pieces are needed: PYFA's **source** (for `eos`) and a prebuilt
**`eve.db`**. The source alone can't build the DB — `db_update.py` needs a
Phobos dump from an installed EVE client — but every PYFA release ships the
built DB inside its bundle, so take it from there.

```sh
# 1. eos source, at the commit you want to compare against
git clone --depth 1 https://github.com/pyfa-org/pyfa /tmp/pyfa

# 2. eve.db out of the matching release's Linux AppImage
gh release download v2.70.0 --repo pyfa-org/pyfa --pattern '*linux.AppImage' -D /tmp/pyfa-rel
chmod +x /tmp/pyfa-rel/pyfa-*.AppImage
(cd /tmp/pyfa-rel && ./pyfa-*.AppImage --appimage-extract >/dev/null)
#    -> /tmp/pyfa-rel/squashfs-root/opt/pyfa/eve.db

# 3. a venv with just what eos imports
python3 -m venv /tmp/pyfa-venv
/tmp/pyfa-venv/bin/pip install 'sqlalchemy==2.0.51' logbook python-dateutil pyyaml

# 4. run the oracle from the source tree
cp tools/pyfa-oracle/oracle.py /tmp/pyfa/
cd /tmp/pyfa
PYFA_EVE_DB=/tmp/pyfa-rel/squashfs-root/opt/pyfa/eve.db \
  /tmp/pyfa-venv/bin/python oracle.py > golden.json
```

### Why each piece

- **`sqlalchemy==2.0.51`** — the version PYFA pins today (`pyproject.toml`).
  Older notes here called for 1.4.x; `eos` has since moved off the legacy ORM
  API, and 2.0.51 is what the shipped builds use.
- **no wx stub** — `eos.db` imports PYFA's root `config`, which imports wx.
  `oracle.py` installs a stand-in `config` module carrying only the attributes
  eos reads, so nothing GUI-related is ever imported.
- **in-memory saveddata** — the oracle points `saveddata` at `sqlite:///:memory:`
  so no user save DB is touched; only the gamedata `eve.db` is read.
- **headless owner wiring** — without a DB session, fitted modules/drones don't
  get their `owner` back-populated, so the oracle sets `item.owner = fit`.
- **`useStaticAdaptiveArmorHardener: False`** — makes the Reactive Armour
  Hardener *simulate* its resist shift, which is what #1272 compares against.

## Output

`golden.json` holds two kinds of row, all-V character:

- the canonical fits: `{ label, weaponDps, droneDps, totalDps, ehp, capStable,
  capStatePct, maxVelocity, alignTime }`;
- the #1272 comparison rows: a Rifter + Reactive Armour Hardener under three
  damage profiles (`armorResonance`), and a Rifter with 1/2/3 Small Armour
  Repairer IIs (`capState` — on an unstable fit PYFA reports **seconds to
  empty**, not a percentage).

Recorded with PYFA source `b79cd90` against v2.70.0's `eve.db`. The first three
rows reproduce the values captured under the older v2.67.0 recipe exactly.

Tolerances for the Rust golden suite: DPS/EHP ~0.5%, cap-stable% ~1pp,
velocity/align tight; the #1272 rows are pinned to 1e-6 (resonance) and 1 ms
(depletion) in `golden_tests.rs`, since they are exact discrete results.

Add fits by extending `FITS` (or `comparison_rows()`) in `oracle.py` and
re-running.
