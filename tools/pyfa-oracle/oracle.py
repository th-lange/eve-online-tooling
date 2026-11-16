"""Headless PYFA (eos) oracle: build canonical fits and emit the stats the Rust
engine's golden suite (#176, #1272) asserts against, as JSON on stdout.

Run it from a Pyfa checkout, with `PYFA_EVE_DB` pointing at a prebuilt
`eve.db` (see README.md):

    PYFA_EVE_DB=/path/to/eve.db /path/to/venv/bin/python oracle.py > golden.json

Nothing here touches a user save DB: saveddata lives in memory, gamedata is
read-only.
"""
import json
import os
import sys
import types

import eos.config

eos.config.gamedataCache = False
eos.config.saveddata_connectionstring = "sqlite:///:memory:"
_game_db = os.environ.get("PYFA_EVE_DB")
if _game_db:
    eos.config.gamedata_connectionstring = (
        f"sqlite:///{_game_db}?check_same_thread=False")
# The settings dict pyfa's GUI settings service normally fills. The RAH must
# simulate rather than read a static profile, which is what #1272 compares.
eos.config.settings = {
    "useStaticAdaptiveArmorHardener": False,
    "strictSkillLevels": True,
    "globalDefaultSpoolupPercentage": 1.0,
}

# `eos.db` imports Pyfa's root `config`, which imports wx. Stand in for it with
# the handful of attributes eos actually reads - no GUI, no wx stub module.
_stub = types.ModuleType("config")
_stub.savePath = os.environ.get("PYFA_ORACLE_SAVE", "/tmp/pyfa-oracle-save")
os.makedirs(_stub.savePath, exist_ok=True)
_stub.saveDB = os.path.join(_stub.savePath, "saveddata.db")
_stub.debug = False
_stub.gamedata_connectionstring = eos.config.gamedata_connectionstring
_stub.saveddata_connectionstring = eos.config.saveddata_connectionstring
_stub.gamedata_version = None
_stub.gamedata_date = None
sys.modules["config"] = _stub

import eos.db  # noqa: E402
from eos.const import FittingModuleState  # noqa: E402
from eos.saveddata.character import Character  # noqa: E402
from eos.saveddata.drone import Drone  # noqa: E402
from eos.saveddata.fit import Fit  # noqa: E402
from eos.saveddata.module import Module  # noqa: E402
from eos.saveddata.ship import Ship  # noqa: E402


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


def armor_resonance(fit, profile):
    """Armour resonance under a damage profile - the RAH's whole output (#1272).

    `profile` is (em, thermal, kinetic, explosive); eos normalises it itself.
    """
    from eos.saveddata.damagePattern import DamagePattern

    em, th, kin, ex = profile
    fit.damagePattern = DamagePattern(
        emAmount=em, thermalAmount=th, kineticAmount=kin, explosiveAmount=ex)
    fit.calculateModifiedAttributes()
    get = fit.ship.getModifiedItemAttr
    return [round(get(a), 6) for a in (
        "armorEmDamageResonance",
        "armorThermalDamageResonance",
        "armorKineticDamageResonance",
        "armorExplosiveDamageResonance",
    )]


def comparison_rows():
    """Fits recorded for the #1272 engine comparison: the RAH's cycle ordering
    under mixed profiles, and the cap sim's staggering of identical modules (an
    unstable fit reports seconds-to-empty in `capState`, not a percentage)."""
    rows = []
    for profile in [(30, 15, 15, 40), (25, 25, 25, 25), (100, 0, 0, 0)]:
        rows.append({
            "label": f"Rifter + Reactive Armor Hardener, profile {profile}",
            "profile": list(profile),
            "armorResonance": armor_resonance(
                build("Rifter", ["Reactive Armor Hardener"]), profile),
        })
    for count in (1, 2, 3):
        fit = build("Rifter", ["Small Armor Repairer II"] * count)
        rows.append({
            "label": f"Rifter + {count}x Small Armor Repairer II",
            "capStable": bool(fit.capStable),
            "capState": round(fit.capState, 3),
        })
    return rows


if __name__ == "__main__":
    out = []
    for label, mk in FITS:
        try:
            out.append(stats(label, mk()))
        except Exception as e:  # keep going; report the failure inline
            out.append({"label": label, "error": f"{type(e).__name__}: {e}"})
    out.extend(comparison_rows())
    print(json.dumps(out, indent=2))
