"""Lotuspod's feature slices, one package each (tests/test_import_graph.py)."""

from __future__ import annotations

from importlib import import_module
from typing import Any, Callable


def public_edge(package: str, names: dict[str, str]) -> Callable[[str], Any]:
    """The module __getattr__ a slice's __init__.py exports names with: each
    of names, by the module of package that defines it, is read from that
    module when asked for. Importing a slice so loads none of its modules,
    leaving no cycle between the slice packages for two threads importing
    at once to deadlock on."""
    def __getattr__(name: str) -> Any:
        if name not in names:
            raise AttributeError(f"module {package!r} has no attribute {name!r}")
        return getattr(import_module(f"{package}.{names[name]}"), name)
    return __getattr__
