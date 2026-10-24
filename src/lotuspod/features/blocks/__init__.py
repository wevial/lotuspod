"""Body blocks: reference cards (refs.py), the Nodes table under a flowchart
(node_tables.py) and calltree fences (calltree.py), with the scripts and
styles of those, diagrams, tables and the image viewer in ts/ and theme/."""

from lotuspod.features.blocks.calltree import render
from lotuspod.features.blocks.node_tables import mark_node_tables
from lotuspod.features.blocks.refs import check_refs, mark_refs, parse_refs
