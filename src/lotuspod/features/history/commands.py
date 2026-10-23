"""The history slice's commands: `lotuspod archive` and `lotuspod unarchive`
(lotuspod.features.history.archive)."""

from __future__ import annotations

import argparse

from lotuspod.features.history.archive import cmd_archive, cmd_unarchive


def add_parser(sub: argparse._SubParsersAction) -> None:
    """Register `lotuspod archive` and `lotuspod unarchive`."""
    archive = sub.add_parser(
        "archive",
        help="take a page off the index's default list and Recent activity, keeping "
        "its URL, versions and threads",
        description="Mark a visible page archived: a record NAME.archived.json beside "
        "it, then the manifest and the index rebuilt and one commit, 'archive NAME'. "
        "The index lists it only behind its Archived toggle, and Recent activity leaves "
        "it out. Archiving it again keeps the time it was archived.",
    )
    unarchive = sub.add_parser(
        "unarchive",
        help="put an archived page back on the index's default list",
        description="Remove a page's archive record, then rebuild the manifest and the "
        "index and commit once, 'unarchive NAME'. A page that is not archived is left "
        "as it is.",
    )
    for parser, func in ((archive, cmd_archive), (unarchive, cmd_unarchive)):
        parser.add_argument("name", metavar="NAME", help="the page's name")
        if parser is archive:
            parser.add_argument(
                "--superseded-by", default=None, metavar="NAME",
                help="the visible page that replaces it (default: the successor it "
                "already has, else none)",
            )
        parser.add_argument("--out-dir", default="",
                            help="artifacts directory (default: artifacts/)")
        parser.add_argument(
            "--local", action="store_true",
            help="change the page on this machine even when the config names a host",
        )
        parser.set_defaults(func=func)
