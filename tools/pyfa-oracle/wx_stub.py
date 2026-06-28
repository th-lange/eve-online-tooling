# Minimal wx stub: Pyfa's config.py only constructs wx.Colour(...) at import.
class Colour:
    def __init__(self, *a, **k): pass
def __getattr__(name):  # tolerate any other attribute access
    return Colour
