"""Headless PYFA (eos) oracle: build canonical fits and emit the stats the Rust
engine's golden suite (#176) asserts against, as JSON on stdout.

Setup (one-time), from the Pyfa repo root:
    python3 -m venv venv && . venv/bin/activate
    pip install 'sqlalchemy==1.4.50' logbook python-dateutil pyyaml cryptography
    # config.py imports wx only for wx.Colour - stub it:
    #   echo 'class Colour:\n  def __init__(self,*a,**k): pass\ndef __getattr__(n): return Colour' > wxstub/wx.py
    PYTHONPATH=wxstub python db_update.py            # builds eve.db (~100 MB)
    PYTHONPATH=wxstub python oracle.py > golden.json

Numbers are PYFA v2.67.0 against its bundled SDE, all-V character.
"""
import json
import eos.config
eos.config.saveddata_connectionstring = "sqlite:///:memory:"
import eos.db  # noqa: E402
from eos.saveddata.fit import Fit  # noqa: E402
from eos.saveddata.ship import Ship  # noqa: E402
from eos.saveddata.module import Module  # noqa: E402
from eos.saveddata.drone import Drone  # noqa: E402
from eos.saveddata.character import Character  # noqa: E402
from eos.const import FittingModuleState  # noqa: E402


def item(name):
    it = eos.db.getItem(name)
    if it is None:
        raise SystemExit(f"unknown item: {name}")
    return it


def build(ship_name, mods, drones=()):
    fit = Fit()
    fit.ship = Ship(item(ship_name))
    fit.character = Character.getAll5()
    for spec in mods:
        name, charge = (spec if isinstance(spec, tuple) else (spec, None))
        m = Module(item(name))
        if charge:
            m.charge = item(charge)
        try:
            m.state = FittingModuleState.ACTIVE
        except Exception:
            pass
        fit.modules.append(m)
        m.owner = fit  # back-populate (no DB session in headless mode)
    for dname, qty in drones:
        d = Drone(item(dname))
        d.amount = d.amountActive = qty
        fit.drones.append(d)
        d.owner = fit
    fit.calculateModifiedAttributes()
    return fit


def stats(label, fit):
    wdps = fit.getWeaponDps().total
    ddps = fit.getDroneDps().total
    ehp = fit.ehp
    return {
        "label": label,
        "weaponDps": round(wdps, 2),
        "droneDps": round(ddps, 2),
        "totalDps": round(wdps + ddps, 2),
        "ehp": round(sum(ehp.values()) if isinstance(ehp, dict) else ehp, 1),
        "capStable": bool(fit.capStable),
        "capStatePct": round(fit.capState, 2),
        "maxVelocity": round(fit.ship.getModifiedItemAttr("maxVelocity"), 2),
        "alignTime": round(fit.alignTime, 3),
    }


# Canonical fits - turrets+ammo+drones, missiles+ammo, and a cap/tank boat.
FITS = [
    ("Rifter - 3x 200mm AC II / Barrage S + 2x Warrior II",
     lambda: build("Rifter",
                   [("200mm AutoCannon II", "Barrage S")] * 3,
                   drones=[("Warrior II", 2)])),
    ("Caracal - 5x Heavy Missile Launcher II / Scourge Heavy Missile",
     lambda: build("Caracal",
                   [("Heavy Missile Launcher II", "Scourge Heavy Missile")] * 5)),
    ("Vexor - 5x Hammerhead II drones",
     lambda: build("Vexor", [], drones=[("Hammerhead II", 5)])),
]

if __name__ == "__main__":
    out = []
    for label, mk in FITS:
        try:
            out.append(stats(label, mk()))
        except Exception as e:  # keep going; report the failure inline
            out.append({"label": label, "error": f"{type(e).__name__}: {e}"})
    print(json.dumps(out, indent=2))
