"""The backup slice's commands: `lotuspod backup` and `lotuspod restore`
(lotuspod.features.backup.backup)."""

from __future__ import annotations

import argparse

from lotuspod.features.publish import media
from lotuspod.features.backup.backup import (DEFAULT_BACKUPS, DEFAULT_KEEP, LATEST, cmd_backup,
                                             cmd_restore)
from lotuspod.store import db


def _keep(value: str) -> int:
    if not value.isdigit() or int(value) < 1:
        raise argparse.ArgumentTypeError(f"not a whole number, 1 or more: {value!r}")
    return int(value)


def add_parser(sub: argparse._SubParsersAction) -> None:
    """Register `lotuspod backup` and `lotuspod restore`."""
    backup = sub.add_parser(
        "backup",
        help="back up serve's database, the artifacts repository and its images "
        "together, or verify a backup set",
        description="Write one backup set of serve's database, the artifacts "
        "repository and its media directory into BACKUPS/UTC-TIMESTAMP under the publish "
        "lock, while serve keeps serving: a copy of the database, a git bundle of every "
        "ref, media/ with every stored image (hard-linked from the newest earlier set "
        "when it holds one), and manifest.json with their SHA-256s, the images' names, "
        "the schema version and HEAD. Keeps the newest --keep sets. "
        "With --verify, restore a set into scratch space and check it instead.",
    )
    backup.add_argument("--out-dir", default="",
                        help="artifacts directory, its own git repository (default: artifacts/)")
    backup.add_argument(
        "--db", default="", metavar="PATH",
        help=f"serve's database (default: {db.DEFAULT_NAME} beside the artifacts directory)",
    )
    backup.add_argument(
        "--to", default="", metavar="BACKUPS",
        help=f"directory of backup sets (default: {DEFAULT_BACKUPS} beside the artifacts "
        "directory; never inside it)",
    )
    backup.add_argument("--keep", type=_keep, default=DEFAULT_KEEP, metavar="N",
                        help=f"sets to keep, newest first (default: {DEFAULT_KEEP})")
    backup.add_argument("--json", action="store_true", help='print {"backup": PATH}')
    backup.add_argument(
        "--verify", default=None, metavar="SET",
        help=f"restore SET ('{LATEST}': the newest in BACKUPS) into scratch space, check "
        "the database's integrity, git fsck, HEAD and every image's hash, and exit 1 "
        "naming the first failure",
    )
    backup.set_defaults(func=cmd_backup)

    restore_parser = sub.add_parser(
        "restore",
        help="rebuild the database, the artifacts repository and its images from a "
        "backup set",
        description="Check every checksum in SET, then copy its database to --db, "
        "clone its bundle into --out-dir with main checked out at the recorded HEAD, "
        f"and copy its images into {media.MEDIA_DIR_NAME} beside --out-dir, adding to "
        "it when it exists. Refuses, changing nothing, when either path exists or a "
        "file already there under an image's name holds other bytes. Never pushes.",
    )
    restore_parser.add_argument("set", metavar="SET", help="a backup set directory")
    restore_parser.add_argument("--db", required=True, metavar="PATH",
                                help="where the database goes; must not exist")
    restore_parser.add_argument("--out-dir", required=True, metavar="DIR",
                                help="where the artifacts repository goes; must not exist")
    restore_parser.set_defaults(func=cmd_restore)
