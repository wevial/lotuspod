"""Page history: a page's versions (versions.py) and the archive (archive.py,
with `lotuspod archive` and `lotuspod unarchive` in commands.py)."""

from lotuspod.features import public_edge

# The names the other slices use, by the module that defines each.
__getattr__ = public_edge(__name__, {
    "archived_page": "archive",
    "is_archived": "archive",
    "read_record": "archive",
    "set_archived": "archive",
    "successor_title": "archive",
    "History": "versions",
    "old_page": "versions",
})
