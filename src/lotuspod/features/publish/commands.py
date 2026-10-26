"""The publish slice's commands: `lotuspod render` (render.py), `lotuspod
manifest` (manifest.py), `lotuspod publish` (publish.py) and `lotuspod pages`
(kept.py, and `pages stale` from the stale slice). `lotuspod index` sits
between manifest and publish, so each run is registered on its own."""

from __future__ import annotations

import argparse

from lotuspod.features import agents, stale
from lotuspod.core import EXIT_REVISION_CONFLICT, NO_REVISION
from lotuspod.features.publish.kept import cmd_pages_diff, cmd_pages_migrate
from lotuspod.features.publish.manifest import cmd_manifest
from lotuspod.features.publish.publish import (LABEL_MAX, PUBLISH_FORMATS, PUBLISH_VARIANT,
                                               cmd_publish)
from lotuspod.features.publish.render import DEFAULT_VARIANT, VARIANTS, cmd_render
from lotuspod.store import db


def owner_options(parser: argparse.ArgumentParser, comments_default: bool) -> None:
    """--comments, --owner, --credential and --db, which render and publish take."""
    parser.add_argument(
        "--comments", action=argparse.BooleanOptionalAction, default=comments_default,
        help="end every h2 section with a comment box (needs the outline; "
        f"default: {'on' if comments_default else 'off'})",
    )
    parser.add_argument(
        "--owner", default="", metavar="HANDLE",
        help="stamp the page with the handle of the agent or seat that published it; "
        "needs a credential that may publish as HANDLE"
        + (" (default: the page's current owner)" if comments_default else ""),
    )
    parser.add_argument(
        "--credential", default="", metavar="FILE",
        help=f"the credential --owner is checked against (default: ${agents.CREDENTIAL_ENV})",
    )
    parser.add_argument(
        "--db", default="", metavar="PATH",
        help=f"serve's database the credential is checked in (default: {db.DEFAULT_NAME} "
        "beside the artifacts directory)",
    )


def add_render_parsers(sub: argparse._SubParsersAction) -> None:
    """Register `lotuspod render` and `lotuspod manifest`."""
    render = sub.add_parser("render", help="render an artifact from the template")
    render.add_argument("--name", required=True, help="output file name (no extension)")
    render.add_argument("--title", required=True, help="artifact title")
    render.add_argument("--episode", default="", help="episode number/label")
    render.add_argument("--date", default="", help="publication date (ISO, defaults to today)")
    render.add_argument("--summary", default="", help="short summary line")
    body_source = render.add_mutually_exclusive_group()
    body_source.add_argument("--body", default="", help="artifact body (HTML or plain text)")
    body_source.add_argument(
        "--markdown",
        default="",
        metavar="PATH",
        help="markdown file to convert into the body ('-' reads standard input)",
    )
    render.add_argument(
        "--hidden",
        action="store_true",
        help="mark the artifact not visible (excluded from manifest/index)",
    )
    render.add_argument(
        "--no-outline",
        action="store_true",
        help="skip heading ids and the section outline",
    )
    render.add_argument(
        "--variant",
        choices=VARIANTS,
        default=DEFAULT_VARIANT,
        help="page treatment: article (default) or report - a denser reading "
        "surface for long technical reports, outline as a left rail",
    )
    render.add_argument("--out-dir", default="", help="output directory (default: artifacts/)")
    owner_options(render, comments_default=False)
    render.add_argument(
        "--source",
        default="",
        help="markdown source of the page, copied to NAME.md beside it",
    )
    render.set_defaults(func=cmd_render)

    manifest = sub.add_parser(
        "manifest", help="generate manifest.json indexing rendered artifacts"
    )
    manifest.add_argument("--out-dir", default="", help="artifacts directory (default: artifacts/)")
    manifest.set_defaults(func=cmd_manifest)


def add_publish_parser(sub: argparse._SubParsersAction) -> None:
    """Register `lotuspod publish`."""
    publish = sub.add_parser(
        "publish",
        help="render a markdown or HTML page, keep its source, rebuild the "
        "manifest and index, and commit once",
    )
    publish.add_argument(
        "source",
        metavar="SOURCE",
        help="a .md/.markdown page, an .html/.htm page body, or '-' for standard input",
    )
    publish.add_argument(
        "--name", default="", help="page name (default: the file name up to its first dot)"
    )
    publish.add_argument(
        "--title", default=None, help="page title (default: the first '# ' line or h1)"
    )
    publish.add_argument(
        "--summary", default=None, help="short summary line (default: the page's current one)"
    )
    labelled = publish.add_mutually_exclusive_group()
    labelled.add_argument(
        "--label", dest="labels", action="append", default=None, metavar="NAME",
        help=f"file the page under NAME, lower-cased: letters, digits and '-', at most "
        f"{LABEL_MAX}; repeat for more (default: the page's current labels)",
    )
    labelled.add_argument(
        "--no-labels", action="store_true", help="clear the page's labels",
    )
    publish.add_argument(
        "--variant",
        choices=VARIANTS,
        default=None,
        help=f"page treatment (default: the page's current one, else {PUBLISH_VARIANT})",
    )
    publish.add_argument(
        "--date", default="", help="publication date (default: the page's current one, else today)"
    )
    publish.add_argument(
        "--format",
        choices=PUBLISH_FORMATS,
        default="",
        help="source format (default: from the file name; required for '-')",
    )
    publish.add_argument(
        "--expect-revision",
        default=None,
        metavar="REV",
        help=f"refuse, exit {EXIT_REVISION_CONFLICT}, unless the page is at REV "
        f"('{NO_REVISION}': the page must not exist yet)",
    )
    referenced = publish.add_mutually_exclusive_group()
    referenced.add_argument(
        "--refs", default=None, metavar="FILE",
        help='a JSON file {"refs": {KEY: ENTRY}} of the tickets and pull requests the page '
        "names, drawn as cards (default: the page's current cards)",
    )
    referenced.add_argument(
        "--no-refs", action="store_true", help="drop the page's reference cards",
    )
    publish.add_argument("--out-dir", default="", help="output directory (default: artifacts/)")
    owner_options(publish, comments_default=True)
    publish.add_argument(
        "--local",
        action="store_true",
        help="publish on this machine even when the config names a host",
    )
    publish.add_argument(
        "--base",
        default="",
        metavar="DIR",
        help="the directory the source's image files are found in (default: the source "
        "file's directory; a source on standard input has none)",
    )
    publish.add_argument(
        "--source-archive",
        action="store_true",
        help="standard input is a tar of the source and its images, as publish sends "
        "the writer host",
    )
    publish.add_argument('--live', action='store_true', help='publish a whole HTML document as a live widget')
    publish.add_argument('--notes', metavar='FILE', help='markdown notes below the --live document')
    publish.add_argument('--artifact', action='store_true', help='publish a Claude artifact\'s HTML file as --live does, its CDN scripts inlined, its font links dropped and its data-theme following the reader\'s theme')
    publish.set_defaults(func=cmd_publish)


def add_pages_parser(sub: argparse._SubParsersAction) -> None:
    """Register `lotuspod pages migrate`, `lotuspod pages diff` and `lotuspod pages stale`."""
    pages = sub.add_parser("pages", help="work on every page of the output directory at once")
    actions = pages.add_subparsers(dest="action", required=True)
    migrate = actions.add_parser(
        "migrate",
        help="keep the body of each page that has no source as NAME.body.html, once a "
        "render from it gives the page's text and anchors back, and commit once",
    )
    migrate.add_argument("--check", action="store_true",
                         help="print what migrate would keep and refuse; write nothing")
    migrate.add_argument("--out-dir", default="", help="output directory (default: artifacts/)")
    migrate.set_defaults(func=cmd_pages_migrate)
    diff = actions.add_parser(
        "diff",
        help="list each page whose body a render from its kept source now gives "
        "differently from its published file, and what changed; write nothing",
    )
    diff.add_argument("--json", action="store_true", help="print the report as one JSON object")
    diff.add_argument("--out-dir", default="", help="output directory (default: artifacts/)")
    diff.set_defaults(func=cmd_pages_diff)
    stale.add_stale_parser(actions)


# This slice's subcommands by slot, the order `lotuspod --help` lists them in.
COMMANDS = (
    (10, add_render_parsers),
    (30, add_publish_parser),
    (35, add_pages_parser),
)
