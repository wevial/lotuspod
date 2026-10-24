"""Lotuspod's feature slices, one package each (tests/test_import_graph.py)."""

# Each slice's __init__.py exports what the other slices use, so importing one
# loads them all. agents goes first whichever module is imported: its routing
# defaults and publish's media are bound before serve's api reads them, and
# serve is whole before anything subclasses or reads its api at import.
from lotuspod.features import agents
