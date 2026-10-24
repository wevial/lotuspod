"""Minimal CLI for rendering Lotuspod artifacts from the template + theme."""

from __future__ import annotations


import argparse
import json
import sys

from lotuspod.features.agents import commands as agents_commands
from lotuspod.features.backup import commands as backup_commands
from lotuspod.features.decisions import commands as decisions_commands
from lotuspod.features.history import commands as history_commands
from lotuspod.features.index import commands as index_commands
from lotuspod.features.publish import commands as publish_commands
from lotuspod.features.serve import commands as serve_commands


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="lotuspod", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    publish_commands.add_render_parsers(sub)
    index_commands.add_parser(sub)
    publish_commands.add_publish_parser(sub)

    serve_commands.add_parser(sub)

    agents_commands.add_credential_parser(sub)

    decisions_commands.add_parser(sub)

    agents_commands.add_audit_parsers(sub)
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
