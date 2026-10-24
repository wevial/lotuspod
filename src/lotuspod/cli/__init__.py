"""Minimal CLI for rendering Lotuspod artifacts from the template + theme."""

from __future__ import annotations


import argparse
import importlib
import json
import sys
from pathlib import Path
from typing import Callable

# Each slice under it whose folder holds a commands module registers its
# subcommands there: a COMMANDS tuple of (slot, register) pairs, register
# taking the subparsers. The parser calls them in slot order, so a new
# slice's command is a new file, not a line here; slots leave gaps for one.
FEATURES_DIR = Path(__file__).resolve().parent.parent / "features"

Register = Callable[[argparse._SubParsersAction], None]


def registrations() -> list[tuple[int, Register]]:
    """Every slice's (slot, register) pair, in slot order; two at one slot
    are refused."""
    found: dict[int, tuple[str, Register]] = {}
    for commands in sorted(FEATURES_DIR.glob("*/commands.py")):
        module = f"lotuspod.features.{commands.parent.name}.commands"
        for slot, register in importlib.import_module(module).COMMANDS:
            if slot in found:
                raise RuntimeError(f"{module} registers a command at slot {slot}, "
                                   f"which {found[slot][0]} holds")
            found[slot] = (module, register)
    return [(slot, found[slot][1]) for slot in sorted(found)]


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="lotuspod", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for _, register in registrations():
        register(sub)
    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (KeyError, FileNotFoundError, json.JSONDecodeError, RuntimeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
