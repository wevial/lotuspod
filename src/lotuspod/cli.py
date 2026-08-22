"""Minimal CLI for rendering Lotuspod artifacts from the template + theme."""

from __future__ import annotations

import argparse
import datetime as _dt
import html
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
INDEX_TEMPLATE_PATH = _pkg_path("_templates", "index.html")
THEME_DIR = _pkg_path("_theme")
DEFAULT_OUTPUT_DIR = Path.cwd() / "artifacts"
INDEX_FILE = "index.html"

_PLACEHOLDER = re.compile(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}")

_EPISODE_KICKER = re.compile(r"^Lotuspod · Episode (.+)$")
_TITLE_RE = re.compile(r'<h1 class="artifact-title">(.*?)</h1>', re.DOTALL)
_KICKER_RE = re.compile(r'<p class="artifact-kicker">(.*?)</p>', re.DOTALL)
_DATE_RE = re.compile(r'<time datetime="([^"]*)">')
_SUMMARY_RE = re.compile(r'<p class="artifact-summary">(.*?)</p>', re.DOTALL)


def load_tokens() -> dict:
    tokens_path = THEME_DIR / "tokens.json"
    with tokens_path.open(encoding="utf-8") as fh:
        return json.load(fh)


def render_template(context: dict, template_path: Path = TEMPLATE_PATH) -> str:
    template = template_path.read_text(encoding="utf-8")

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


def extract_meta(html: str, stem: str) -> dict:
    title = _TITLE_RE.search(html)
    kicker = _KICKER_RE.search(html)
    date = _DATE_RE.search(html)
    summary = _SUMMARY_RE.search(html)

    episode = None
    if kicker:
        ep = _EPISODE_KICKER.match(kicker.group(1).strip())
        if ep:
            episode = ep.group(1).strip()

    return {
        "file": f"{stem}.html",
        "title": title.group(1) if title else stem,
        "episode": episode,
        "date": date.group(1) if date else None,
        "summary": summary.group(1) if summary else None,
    }


def cmd_manifest(args: argparse.Namespace) -> int:
    out_dir = Path(args.out_dir) if args.out_dir else DEFAULT_OUTPUT_DIR
    if not out_dir.is_dir():
        raise FileNotFoundError(f"artifacts directory not found: {out_dir}")

    pages = sorted(p for p in out_dir.glob("*.html") if p.name != INDEX_FILE)
    artifacts = [extract_meta(p.read_text(encoding="utf-8"), p.stem) for p in pages]

    manifest_path = out_dir / "manifest.json"
    manifest_path.write_text(
        json.dumps({"artifacts": artifacts}, indent=2) + "\n", encoding="utf-8"
    )
    print(f"wrote {manifest_path} ({len(artifacts)} artifacts)")
    return 0


_INDEX_EMPTY_BLOCK = (
    '<p class="index-empty">Nothing in the pond yet. Render one with '
    "<code>lotuspod render</code>.</p>"
)


def index_entries_html(artifacts: list[dict]) -> str:
    """Render manifest-style metadata into the index page's list block."""
    if not artifacts:
        return _INDEX_EMPTY_BLOCK
    esc = html.escape
    items = []
    for meta in artifacts:
        inner = []
        if meta["episode"]:
            ep = esc(str(meta["episode"]))
            inner.append(f'<p class="episode-kicker">Episode {ep}</p>')
        title = esc(str(meta["title"]))
        inner.append(f'<h2 class="episode-title">{title}</h2>')
        if meta["date"]:
            date = esc(str(meta["date"]))
            inner.append(
                f'<p class="episode-date"><time datetime="{date}">{date}</time></p>'
            )
        if meta["summary"]:
            summary = esc(str(meta["summary"]))
            inner.append(f'<p class="episode-summary">{summary}</p>')
        body = "".join(f"\n          {part}" for part in inner)
        href = esc(str(meta["file"]))
        items.append(
            "      <li>\n"
            f'        <a class="episode-card" href="{href}">'
            f"{body}\n"
            "        </a>\n"
            "      </li>"
        )
    return '<ul class="episode-list">\n' + "\n".join(items) + "\n    </ul>"


def cmd_index(args: argparse.Namespace) -> int:
    out_dir = Path(args.out_dir) if args.out_dir else DEFAULT_OUTPUT_DIR
    if not out_dir.is_dir():
        raise FileNotFoundError(f"artifacts directory not found: {out_dir}")

    pages = sorted(p for p in out_dir.glob("*.html") if p.name != INDEX_FILE)
    artifacts = [extract_meta(p.read_text(encoding="utf-8"), p.stem) for p in pages]

    tokens = load_tokens()
    context = {
        "generated": _dt.date.today().isoformat(),
        "entries_block": index_entries_html(artifacts),
        "theme_name": tokens["name"],
        "theme_version": tokens["version"],
    }

    theme_copy = out_dir / "lotuspod.css"
    packaged_css = (THEME_DIR / "lotuspod.css").read_bytes()
    if not theme_copy.exists() or theme_copy.read_bytes() != packaged_css:
        shutil.copyfile(THEME_DIR / "lotuspod.css", theme_copy)

    out_path = out_dir / INDEX_FILE
    out_path.write_text(
        render_template(context, INDEX_TEMPLATE_PATH), encoding="utf-8"
    )
    print(f"wrote {out_path} ({len(artifacts)} artifacts)")
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

    manifest = sub.add_parser(
        "manifest", help="generate manifest.json indexing rendered artifacts"
    )
    manifest.add_argument("--out-dir", default="", help="artifacts directory (default: artifacts/)")
    manifest.set_defaults(func=cmd_manifest)

    index = sub.add_parser("index", help="build index.html listing rendered artifacts")
    index.add_argument("--out-dir", default="", help="artifacts directory (default: artifacts/)")
    index.set_defaults(func=cmd_index)

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
