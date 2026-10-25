"""Stale pages: the GitHub pull requests each page links, their states kept
beside serve's database, and the pages a merge or close has overtaken
(stale.py), with `lotuspod pages stale` in commands.py, registered under
`pages` by the publish slice."""

from lotuspod.features import public_edge

# The names the other slices use, by the module that defines each.
__getattr__ = public_edge(__name__, {
    "add_stale_parser": "commands",
    "overtaken": "stale",
    "page_pulls": "stale",
    "read_states": "stale",
    "states_path": "stale",
})
