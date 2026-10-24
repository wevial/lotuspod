"""Live updates: serve's change stream (events.py), with the page's live
scripts (its revision checks and banner, the swap of a page published again
and the index's refresh) in ts/ and theme/."""

from lotuspod.features import public_edge

# The names the other slices use, by the module that defines each.
__getattr__ = public_edge(__name__, {
    "PATH": "events",
    "Hub": "events",
})
