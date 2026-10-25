"""`lotuspod pages stale`, registered under `pages` by the publish slice's
add_pages_parser(); this slice adds no command of its own."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from lotuspod.core import DEFAULT_OUTPUT_DIR
from lotuspod.features import serve
from lotuspod.features.stale.stale import (API_ENV, DEFAULT_EVERY, STATES_FILE, TOKEN_ENV,
                                           stale)
from lotuspod.store import db


def _minutes(value: str) -> int:
    try:
        minutes = int(value)
    except ValueError:
        raise argparse.ArgumentTypeError(f"not a whole number of minutes: {value!r}") from None
    if minutes < 0:
        raise argparse.ArgumentTypeError(f"minutes cannot be negative: {value!r}")
    return minutes


def add_stale_parser(actions: argparse._SubParsersAction) -> None:
    """Register `stale` among the `pages` actions."""
    parser = actions.add_parser(
        "stale",
        help="list each page linking a GitHub pull request that merged or closed after "
        "the page was last published, from the states kept beside the database",
    )
    parser.add_argument(
        "--check", action="store_true",
        help=f"look up the linked pull requests first (${API_ENV}, default the GitHub API; "
        f"${TOKEN_ENV} when set) and keep their states in {STATES_FILE}",
    )
    parser.add_argument("--json", action="store_true", help="print the list as one JSON object")
    parser.add_argument(
        "--every", type=_minutes, default=DEFAULT_EVERY, metavar="MIN",
        help="with --check, look up again a pull request not merged only when it was "
        f"checked MIN minutes ago or more (default: {DEFAULT_EVERY})",
    )
    parser.add_argument("--out-dir", default="", help="output directory (default: artifacts/)")
    parser.add_argument(
        "--db", default="", metavar="PATH",
        help=f"serve's database, beside which {STATES_FILE} is kept (default: "
        f"{db.DEFAULT_NAME} beside the artifacts directory; never inside it)",
    )
    parser.set_defaults(func=cmd_pages_stale)


def cmd_pages_stale(args: argparse.Namespace) -> int:
    out_dir = (Path(args.out_dir) if args.out_dir else DEFAULT_OUTPUT_DIR).resolve()
    if not out_dir.is_dir():
        print(f"error: no output directory {out_dir}", file=sys.stderr)
        return 1
    try:
        db_path = serve.serve_db_path(out_dir, args.db)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    return stale(out_dir, db_path, args.check, args.every, args.json)


# Registered under `pages`, not at the top level.
COMMANDS = ()
