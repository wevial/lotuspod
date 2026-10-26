"""Decisions: a page's "Decisions for the maintainer" tables, answered on the
page (decisions.py), with `lotuspod answers` in commands.py."""

from lotuspod.features import public_edge

# The names the other slices use, by the module that defines each.
__getattr__ = public_edge(__name__, {
    "holds": "decisions",
    "read_forms": "decisions",
    "render_decisions": "decisions",
})
