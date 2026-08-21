"""Minimal CLI for rendering Lotuspod artifacts from the template + theme."""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import re
import shutil
import sys
from pathlib import Path

import importlib.resources as _res

_PKG = "lotuspod"


def _pkg_path(*parts: str) -> Path:
    """Resolve packaged assets (templates/theme) for any install mode."""
    with _res.as_file(_res.files(_PKG).joinpath(*parts)) as p:
        return p


TEMPLATE_PATH = _pkg_path("_templates", "artifact.html")
THEME_DIR = _pkg_path("_theme")
DEFAULT_OUTPUT_DIR = Path.cwd() / "artifacts"

_PLACEHOLDER = re.compile(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}")


def load_tokens() -> dict:
    tokens_path = THEME_DIR / "tokens.json"
    with tokens_path.open(encoding="utf-8") as fh:
        return json.load(fh)


def render_template(context: dict) -> str:
    template = TEMPLATE_PATH.read_text(encoding="utf-8")

    def _sub(match: re.Match) -> str:
        key = match.group(1)
        if key not in context:
            raise KeyError(f"template placeholder {key!r} missing from context")
        return str(context[key])

    missing = set(_PLACEHOLDER.findall(template)) - set(context)
    if missing:
        raise KeyError(f"missing context keys: {sorted(missing)}")
    return _PLACEHOLDER.sub(_sub, template)


def cmd_render(args: argparse.Namespace) -> int:
    tokens = load_tokens()
    kicker = "Lotuspod"
    if args.episode:
        kicker = f"Lotuspod · Episode {args.episode}"
    summary_block = f'<p class="artifact-summary">{args.summary}</p>' if args.summary else ""
    context = {
        "title": args.title,
        "kicker": kicker,
        "date": args.date or _dt.date.today().isoformat(),
        "summary_block": summary_block,
        "body": args.body,
        "theme_name": tokens["name"],
        "theme_version": tokens["version"],
    }
    html = render_template(context)

    out_dir = Path(args.out_dir) if args.out_dir else DEFAULT_OUTPUT_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{args.name}.html"

    theme_copy = out_dir / "lotuspod.css"
    if not theme_copy.exists():
        shutil.copyfile(THEME_DIR / "lotuspod.css", theme_copy)

    out_path.write_text(html, encoding="utf-8")
    print(f"rendered {out_path}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="lotuspod", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    render = sub.add_parser("render", help="render an artifact from the template")
    render.add_argument("--name", required=True, help="output file name (no extension)")
    render.add_argument("--title", required=True, help="artifact title")
    render.add_argument("--episode", default="", help="episode number/label")
    render.add_argument("--date", default="", help="publication date (ISO, defaults to today)")
    render.add_argument("--summary", default="", help="short summary line")
    render.add_argument("--body", default="", help="artifact body (HTML or plain text)")
    render.add_argument("--out-dir", default="", help="output directory (default: artifacts/)")
    render.set_defaults(func=cmd_render)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    try:
        return args.func(args)
    except (KeyError, FileNotFoundError, json.JSONDecodeError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
