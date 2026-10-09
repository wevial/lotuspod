"""`lotuspod archive` and `lotuspod unarchive`: a reversible mark that takes a
page off the index's default list and out of Recent activity.

    lotuspod archive NAME [--superseded-by NAME] [--out-dir DIR] [--local]
    lotuspod unarchive NAME [--out-dir DIR] [--local]

An archived page keeps its URL, its versions and its threads. Its state is a
record beside it, NAME.archived.json, {"archivedAt": STAMP, "supersededBy":
NAME or null}: committed with the page and never served, as its kept refs
are. The page itself is never rewritten, so archiving adds no version, and a
republish leaves the record alone.

set_archived() writes or removes the record, rebuilds the manifest and the
index and commits once, under the output directory's publish lock: the
commands call it, and so does serve's /api/archive route (lotuspod.api).
Without --local, when the config's [publish] section names a host, a command
runs there over ssh, as publish does.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import shlex
import subprocess
import sys
from pathlib import Path

from http import HTTPStatus

# cli imports this module too: only names used at call time are read from it.
from lotuspod import api, cli

class Refused(api.Refusal, RuntimeError):
    """An archive or unarchive that wrote nothing, saying why: a RuntimeError
    for the commands, and the refusal /api/archive answers with."""

    def __init__(self, status: int, error: str, message: str) -> None:
        RuntimeError.__init__(self, message)
        self.status = status
        self.error = error


def record_path(out_dir: Path, name: str) -> Path:
    return out_dir / f"{name}.archived.json"


def read_record(out_dir: Path, name: str) -> dict | None:
    """NAME's archive record, {archivedAt, supersededBy}; None when the page
    is not archived. RuntimeError when the record cannot be read."""
    path = record_path(out_dir, name)
    if not path.is_file():
        return None
    try:
        kept = json.loads(path.read_text(encoding="utf-8"))
        stamp, successor = kept["archivedAt"], kept["supersededBy"]
        if not isinstance(stamp, str) or not stamp:
            raise TypeError("archivedAt is not a time")
        if successor is not None and not isinstance(successor, str):
            raise TypeError("supersededBy is not a name")
    except (OSError, UnicodeDecodeError, ValueError, KeyError, TypeError) as exc:
        raise RuntimeError(f"cannot read the archive record {path}: {exc}") from None
    return {"archivedAt": stamp, "supersededBy": successor or None}


def is_archived(out_dir: Path, name: str) -> bool:
    """Whether NAME has an archive record, read no further."""
    return record_path(out_dir, name).is_file()


def visible_page(out_dir: Path, name: str) -> bool:
    """Whether NAME is a page serve answers: a visible page of out_dir,
    however render named it. The allow-list holds bare file names only, so
    no name reaches past it."""
    file = f"{name}.html"
    return cli.is_page_name(file) and file in cli.serve_allow_list(out_dir)


def set_archived(out_dir: Path, name: str, archived: bool,
                 superseded_by: str | None = None) -> tuple[dict | None, bool]:
    """Archive NAME (superseded by superseded_by when given) or unarchive it,
    then rebuild the manifest and the index and commit once, "archive NAME"
    or "unarchive NAME". (The record now, None when not archived; whether
    anything was written.) Refused, with nothing written, when NAME or the
    successor is not a visible page, or the successor is NAME.

    Archiving an archived page keeps its archivedAt, and its successor unless
    superseded_by is given. Unarchiving a page that is not archived writes
    nothing.
    """
    out_dir = out_dir.resolve()
    with cli.publish_lock(out_dir):
        if not visible_page(out_dir, name):
            raise Refused(HTTPStatus.NOT_FOUND, "unknown_page",
                          f"{name} is not a visible page of {out_dir}; nothing written")
        if superseded_by is not None:
            if not archived:
                raise Refused(HTTPStatus.BAD_REQUEST, "invalid_body",
                              "only an archived page is superseded; nothing written")
            if superseded_by == name:
                raise Refused(HTTPStatus.BAD_REQUEST, "unknown_successor",
                              f"{name} cannot be superseded by itself; nothing written")
            if not visible_page(out_dir, superseded_by):
                raise Refused(HTTPStatus.BAD_REQUEST, "unknown_successor",
                              f"--superseded-by {superseded_by} is not a visible page of "
                              f"{out_dir}; nothing written")
        current = read_record(out_dir, name)
        path = record_path(out_dir, name)
        if not archived and current is None:
            return None, False
        # What a failed rebuild puts back, so a refusal leaves nothing written.
        kept = {file: file.read_bytes() if file.is_file() else None
                for file in (path, out_dir / cli.MANIFEST_FILE, out_dir / cli.INDEX_FILE)}
        try:
            if not archived:
                path.unlink()
                record = None
            else:
                record = {
                    "archivedAt": current["archivedAt"] if current else
                    cli._utc_stamp(_dt.datetime.now(_dt.timezone.utc)),
                    "supersededBy": superseded_by if superseded_by is not None else
                    (current["supersededBy"] if current else None),
                }
                cli.write_atomic(path, (json.dumps(record, indent=2) + "\n").encode("utf-8"))
            steps = argparse.Namespace(out_dir=str(out_dir), commit=False)
            cli.cmd_manifest(steps)
            cli.cmd_index(steps)
        except Exception as exc:
            for file, data in kept.items():
                if data is None:
                    file.unlink(missing_ok=True)
                else:
                    cli.write_atomic(file, data)
            raise RuntimeError(f"{exc}; nothing written") from None
        cli.commit_output(out_dir, f"{'archive' if archived else 'unarchive'} {name}")
    return record, True


def over_ssh(args: argparse.Namespace, config: dict[str, str], action: str) -> int:
    """Run the command on the config's host; ssh's exit status."""
    out_dir = config.get("out_dir", "")
    if not out_dir:
        raise cli.ConfigError(f"config {cli.config_path()} sets host but no out_dir in [publish]")
    if args.out_dir:
        raise cli.ConfigError(
            f"--out-dir names a directory on this machine, but config {cli.config_path()} "
            f"{action}s on its host; pass --local to {action} here"
        )
    # Quoted as cli.remote_publish_command quotes publish's.
    argv = [action, "--local", f"--out-dir={out_dir}"]
    if getattr(args, "superseded_by", None) is not None:
        argv.append(f"--superseded-by={args.superseded_by}")
    # A NAME beginning with '-' (render takes one) would be read as an option
    # on the far side; after '--' it is NAME.
    argv += ["--", args.name] if args.name.startswith("-") else [args.name]
    command = config.get("command") or cli.DEFAULT_REMOTE_COMMAND
    remote = " ".join([command, *(shlex.quote(arg) for arg in argv)])
    # Nothing rides on standard input, so the far side never waits for it.
    try:
        done = subprocess.run(["ssh", config["host"], remote], stdin=subprocess.DEVNULL)
    except OSError as exc:
        raise RuntimeError(f"cannot run ssh: {exc.strerror}") from None
    return done.returncode


def _run(args: argparse.Namespace, archived: bool) -> int:
    action = "archive" if archived else "unarchive"
    superseded_by = getattr(args, "superseded_by", None)
    if not args.local:
        try:
            config = cli.publish_config()
            if config.get("host"):
                return over_ssh(args, config, action)
        except cli.ConfigError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return cli.EXIT_CONFIG
    out_dir = Path(args.out_dir) if args.out_dir else cli.DEFAULT_OUTPUT_DIR
    if not out_dir.is_dir():
        raise FileNotFoundError(f"artifacts directory not found: {out_dir}")
    _, written = set_archived(out_dir, args.name, archived, superseded_by)
    print(f"{action}d {args.name}" if written else f"{args.name} is not archived")
    return 0


def cmd_archive(args: argparse.Namespace) -> int:
    return _run(args, archived=True)


def cmd_unarchive(args: argparse.Namespace) -> int:
    return _run(args, archived=False)


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
