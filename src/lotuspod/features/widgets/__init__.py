"""Live blocks: a page's widgets and their frames (widgets.py) and the pinned
browser libraries they may load (libraries.py)."""

from lotuspod.features import public_edge

# The names the other slices use, by the module that defines each.
__getattr__ = public_edge(__name__, {
    "ALONE_HEADERS": "widgets",
    "ALONE_QUERY": "widgets",
    "HEADERS": "widgets",
    "VARY": "widgets",
    "alone_page": "widgets",
    "Frames": "widgets",
    "PageWidgets": "widgets",
    "block_source": "widgets",
    "fence": "widgets",
    "link_decisions": "widgets",
    "render": "widgets",
})
