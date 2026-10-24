"""Body blocks: reference cards (refs.py), the Nodes table under a flowchart
(node_tables.py) and calltree fences (calltree.py), with the scripts and
styles of those, diagrams, tables and the image viewer in ts/ and theme/."""

from lotuspod.features import public_edge

# The names the other slices use, by the module that defines each.
__getattr__ = public_edge(__name__, {
    "render": "calltree",
    "mark_node_tables": "node_tables",
    "check_refs": "refs",
    "mark_refs": "refs",
    "parse_refs": "refs",
})
