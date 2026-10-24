"""Minimal CLI for rendering Lotuspod artifacts from the template + theme."""

from __future__ import annotations


import argparse
import json
import sys
from pathlib import Path

from lotuspod import agents, machine, responder
from lotuspod.features.backup import commands as backup_commands
from lotuspod.features.decisions import commands as decisions_commands
from lotuspod.features.history import commands as history_commands
from lotuspod.features.index import commands as index_commands
from lotuspod.features.publish import commands as publish_commands
from lotuspod.features.publish.publish import _PAGE_NAME
from lotuspod.features.serve import commands as serve_commands
from lotuspod.features.serve.serve_files import serve_database
from lotuspod.store import db


def cmd_credential_create(args: argparse.Namespace) -> int:
    try:
        database = serve_database(args)
        row = machine.create_credential(database, args.name, args.handle, args.op,
                                        Path(args.out))
    except (ValueError, machine.CredentialError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(f"credential {row['name']}: handles {', '.join(row['handles'])}; "
          f"operations {', '.join(row['operations'])}")
    print(f"token in {args.out} (mode 0600); the database keeps only its hash")
    return 0


def cmd_credential_list(args: argparse.Namespace) -> int:
    try:
        rows = [machine.public(row) for row in serve_database(args).credentials()]
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps({"credentials": rows}, indent=2))
        return 0
    if not rows:
        print("no credentials")
    for row in rows:
        state = f"revoked {row['revokedAt']}" if row["revokedAt"] else "active"
        print(f"{row['name']}\thandles {','.join(row['handles'])}"
              f"\toperations {','.join(row['operations'])}"
              f"\tcreated {row['createdAt']}\t{state}")
    return 0


def cmd_credential_revoke(args: argparse.Namespace) -> int:
    try:
        row = serve_database(args).revoke_credential(args.name)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    if row is None:
        print(f"error: no credential named {args.name!r}", file=sys.stderr)
        return 1
    print(f"credential {row['name']} revoked {row['revokedAt']}")
    return 0


def cmd_audit(args: argparse.Namespace) -> int:
    if args.page is not None and not _PAGE_NAME.fullmatch(args.page):
        print(f"error: not a page name: {args.page!r}", file=sys.stderr)
        return 1
    try:
        rows = serve_database(args).audit(args.page)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps(rows, indent=2))
        return 0
    if not rows:
        print("no actions yet")
    for row in rows:
        key = f"\tkey {row['key']}" if row["key"] is not None else ""
        if row["revision"] is not None:
            key += f"\trevision {row['revision']}"
        print(f"{row['at']}\t{row['action']}\tcomment {row['comment']} on {row['page']}"
              f"\tcredential {row['credential']}\thandle {row['handle']}{key}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="lotuspod", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    publish_commands.add_render_parsers(sub)
    index_commands.add_parser(sub)
    publish_commands.add_publish_parser(sub)

    serve_commands.add_parser(sub)

    credential = sub.add_parser(
        "credential",
        help="make, list and revoke the machine credentials agents use on serve's socket",
    )
    actions = credential.add_subparsers(dest="action", required=True)

    def database_options(parser: argparse.ArgumentParser) -> None:
        parser.add_argument(
            "--out-dir", default="", help="artifacts directory (default: artifacts/)"
        )
        parser.add_argument(
            "--db", default="", metavar="PATH",
            help=f"serve's database (default: {db.DEFAULT_NAME} beside the artifacts directory)",
        )

    create = actions.add_parser(
        "create", help="make a credential and write its token to a new file"
    )
    create.add_argument("name", metavar="NAME", help="the credential's name")
    create.add_argument(
        "--handle", action="append", default=[], metavar="HANDLE", required=True,
        help="an owner handle it may act as (repeatable)",
    )
    create.add_argument(
        "--op", action="append", default=[], metavar="OP", required=True,
        help=f"an operation it may do, one of {', '.join(machine.OPERATIONS)} (repeatable)",
    )
    create.add_argument(
        "--out", required=True, metavar="FILE",
        help="new file for the token, made with mode 0600 (never overwritten)",
    )
    database_options(create)
    create.set_defaults(func=cmd_credential_create)

    listing = actions.add_parser("list", help="show credentials, never their tokens")
    listing.add_argument("--json", action="store_true", help="print JSON")
    database_options(listing)
    listing.set_defaults(func=cmd_credential_list)

    revoke = actions.add_parser("revoke", help="end a credential at once")
    revoke.add_argument("name", metavar="NAME", help="the credential's name")
    database_options(revoke)
    revoke.set_defaults(func=cmd_credential_revoke)

    decisions_commands.add_parser(sub)

    audit = sub.add_parser(
        "audit",
        help="list every claim, reply, release, failure, resolve and reopen by an agent, "
        "and every republish by the responder, oldest first",
        description="List every claim, reply, release, failure, resolve and reopen agents "
        "made on serve's socket, and every page the responder republished, oldest first: "
        "when, which comment (a thread's first, for a resolve or reopen) on which page, the credential and handle that acted, and the idempotency "
        "key of a reply or of the reply a republish was for. Reads serve's database directly.",
    )
    audit.add_argument("--page", default=None, metavar="NAME", help="only this page's")
    audit.add_argument("--json", action="store_true", help="print a JSON list of the actions")
    database_options(audit)
    audit.set_defaults(func=cmd_audit)

    agents.add_parser(sub)
    agents.add_inbox_parser(sub)
    responder.add_parser(sub)
    backup_commands.add_parser(sub)
    history_commands.add_parser(sub)

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
