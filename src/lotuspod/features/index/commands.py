"""The index slice's command: `lotuspod index`, the site's listing of its
visible pages (lotuspod.features.index.listing)."""

from __future__ import annotations

import argparse
from pathlib import Path

from lotuspod.core import (DEFAULT_OUTPUT_DIR, INDEX_FILE, commit_output, sync_theme_css,
                           write_atomic)
# The listing imports the archive, which imports this module: only names used
# at call time are read from it.
from lotuspod.features.index import listing


def _hidden_note(hidden: int) -> str:
    return f", {hidden} not visible" if hidden else ""


def cmd_index(args: argparse.Namespace) -> int:
    out_dir = Path(args.out_dir) if args.out_dir else DEFAULT_OUTPUT_DIR
    if not out_dir.is_dir():
        raise FileNotFoundError(f"artifacts directory not found: {out_dir}")

    artifacts, hidden = listing.collect_artifacts(out_dir)

    sync_theme_css(out_dir)

    out_path = out_dir / INDEX_FILE
    write_atomic(out_path, listing.render_index(artifacts).encode("utf-8"))
    print(
        f"wrote {out_path} ({len(artifacts)} artifacts{_hidden_note(hidden)})"
    )
    if getattr(args, "commit", True):
        commit_output(out_dir, "index")
    return 0


def add_parser(sub: argparse._SubParsersAction) -> None:
    """Register `lotuspod index`."""
    index = sub.add_parser("index", help="build index.html listing rendered artifacts")
    index.add_argument("--out-dir", default="", help="artifacts directory (default: artifacts/)")
    index.set_defaults(func=cmd_index)


# This slice's subcommands, each by the slot `lotuspod --help` lists it at
# (lotuspod.cli.build_parser).
COMMANDS = (
    (20, add_parser),
)
