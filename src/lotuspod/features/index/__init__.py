"""The site's index: the listing of its visible pages (listing.py), and
`lotuspod manifest` and `lotuspod index` (commands.py)."""

from lotuspod.features import public_edge

# The names the other slices use, by the module that defines each.
__getattr__ = public_edge(__name__, {
    "_hidden_note": "commands",
    "cmd_index": "commands",
    "collect_artifacts": "listing",
})
