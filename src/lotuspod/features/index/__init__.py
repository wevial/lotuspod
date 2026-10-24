"""The site's index: the listing of its visible pages (listing.py), and
`lotuspod manifest` and `lotuspod index` (commands.py)."""

from lotuspod.features.index.commands import _hidden_note, cmd_index
from lotuspod.features.index.listing import collect_artifacts
