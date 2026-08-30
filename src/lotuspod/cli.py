"""Minimal CLI for rendering Lotuspod artifacts from the template + theme."""

from __future__ import annotations

import argparse
import datetime as _dt
import html
import ipaddress
import json
import re
import shutil
import subprocess
import sys
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
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
MANIFEST_FILE = "manifest.json"
MANIFEST_VERSION = 2
DEFAULT_SERVE_PORT = 8000
_TAILNET_V4 = ipaddress.ip_network("100.64.0.0/10")

_PLACEHOLDER = re.compile(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}")

_EPISODE_KICKER = re.compile(r"^Lotuspod · Episode (.+)$")
_TITLE_RE = re.compile(r'<h1 class="artifact-title">(.*?)</h1>', re.DOTALL)
_KICKER_RE = re.compile(r'<p class="artifact-kicker">(.*?)</p>', re.DOTALL)
_DATE_RE = re.compile(r'<time datetime="([^"]*)">')
_SUMMARY_RE = re.compile(r'<p class="artifact-summary">(.*?)</p>', re.DOTALL)
_VISIBLE_TAG_RE = re.compile(
    r"<meta\s[^>]*name=[\"']lotuspod:visible[\"'][^>]*>", re.IGNORECASE
)
_META_CONTENT_RE = re.compile(r"content=[\"']([^\"']*)[\"']", re.IGNORECASE)


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


def sync_theme_css(out_dir: Path) -> None:
    """Keep the artifact dir's stylesheet identical to the packaged theme.

    Rewriting only on a content difference means a theme upgrade reaches
    already-rendered directories while untouched ones keep their mtime.
    """
    packaged = THEME_DIR / "lotuspod.css"
    theme_copy = out_dir / "lotuspod.css"
    if not theme_copy.exists() or theme_copy.read_bytes() != packaged.read_bytes():
        shutil.copyfile(packaged, theme_copy)


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
        "visible": "false" if args.hidden else "true",
    }
    html = render_template(context)

    out_dir = Path(args.out_dir) if args.out_dir else DEFAULT_OUTPUT_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{args.name}.html"

    sync_theme_css(out_dir)

    out_path.write_text(html, encoding="utf-8")
    print(f"rendered {out_path}")
    return 0


def extract_visibility(page_html: str) -> bool:
    """Fail closed: visible only when the flag is present and exactly 'true'."""
    tag = _VISIBLE_TAG_RE.search(page_html)
    if not tag:
        return False
    content = _META_CONTENT_RE.search(tag.group(0))
    return content is not None and content.group(1).strip().lower() == "true"


def extract_meta(page_html: str, stem: str) -> dict:
    title = _TITLE_RE.search(page_html)
    kicker = _KICKER_RE.search(page_html)
    date = _DATE_RE.search(page_html)
    summary = _SUMMARY_RE.search(page_html)

    episode = ""
    if kicker:
        ep = _EPISODE_KICKER.match(kicker.group(1).strip())
        if ep:
            episode = ep.group(1).strip()

    return {
        "file": f"{stem}.html",
        "title": title.group(1) if title else stem,
        "episode": episode,
        "date": date.group(1) if date else "",
        "summary": summary.group(1) if summary else "",
        "visible": extract_visibility(page_html),
    }


def collect_artifacts(out_dir: Path) -> tuple[list[dict], int]:
    """Parse every artifact page; return (visible entries, hidden count)."""
    pages = sorted(p for p in out_dir.glob("*.html") if p.name != INDEX_FILE)
    metas = [extract_meta(p.read_text(encoding="utf-8"), p.stem) for p in pages]
    visible = [m for m in metas if m["visible"]]
    return visible, len(metas) - len(visible)


def _hidden_note(hidden: int) -> str:
    return f", {hidden} not visible" if hidden else ""


def cmd_manifest(args: argparse.Namespace) -> int:
    out_dir = Path(args.out_dir) if args.out_dir else DEFAULT_OUTPUT_DIR
    if not out_dir.is_dir():
        raise FileNotFoundError(f"artifacts directory not found: {out_dir}")

    artifacts, hidden = collect_artifacts(out_dir)

    manifest_path = out_dir / MANIFEST_FILE
    manifest_path.write_text(
        json.dumps({"version": MANIFEST_VERSION, "artifacts": artifacts}, indent=2)
        + "\n",
        encoding="utf-8",
    )
    print(f"wrote {manifest_path} ({len(artifacts)} artifacts{_hidden_note(hidden)})")
    return 0


_INDEX_EMPTY_BLOCK = (
    '<p class="index-empty">Nothing in the pond yet. Render one with '
    "<code>lotuspod render</code>.</p>"
)


def index_entries_html(artifacts: list[dict]) -> str:
    """Render manifest-style metadata into the index page's table.

    Episodes are uniform records, so they are listed as rows: one column per
    field lets a reader scan a single field down the page, and gives the index
    script a grid to sort and filter. The markup is a complete listing on its
    own - the script only adds sorting and the search filter on top.
    """
    if not artifacts:
        return _INDEX_EMPTY_BLOCK
    esc = html.escape
    rows = []
    for meta in artifacts:
        href = esc(str(meta["file"]))
        title = esc(str(meta["title"]))
        episode = esc(str(meta["episode"]))
        date = esc(str(meta["date"]))
        summary = esc(str(meta["summary"]))
        date_cell = f'<time datetime="{date}">{date}</time>' if date else ""
        rows.append(
            "          <tr>\n"
            f'            <td class="episode-number">{episode}</td>\n'
            f'            <td class="episode-title"><a href="{href}">{title}</a></td>\n'
            f'            <td class="episode-date">{date_cell}</td>\n'
            f'            <td class="episode-summary">{summary}</td>\n'
            "          </tr>"
        )
    return (
        '<table class="index-table">\n'
        "        <thead>\n"
        "          <tr>\n"
        '            <th scope="col" data-sort-type="number">Episode</th>\n'
        '            <th scope="col">Title</th>\n'
        '            <th scope="col">Date</th>\n'
        '            <th scope="col">Summary</th>\n'
        "          </tr>\n"
        "        </thead>\n"
        "        <tbody>\n"
        + "\n".join(rows)
        + "\n        </tbody>\n      </table>"
    )


def cmd_index(args: argparse.Namespace) -> int:
    out_dir = Path(args.out_dir) if args.out_dir else DEFAULT_OUTPUT_DIR
    if not out_dir.is_dir():
        raise FileNotFoundError(f"artifacts directory not found: {out_dir}")

    artifacts, hidden = collect_artifacts(out_dir)

    tokens = load_tokens()
    context = {
        "generated": _dt.date.today().isoformat(),
        "entries_block": index_entries_html(artifacts),
        "theme_name": tokens["name"],
        "theme_version": tokens["version"],
    }

    sync_theme_css(out_dir)

    out_path = out_dir / INDEX_FILE
    out_path.write_text(
        render_template(context, INDEX_TEMPLATE_PATH), encoding="utf-8"
    )
    print(
        f"wrote {out_path} ({len(artifacts)} artifacts{_hidden_note(hidden)})"
    )
    return 0


def tailnet_ipv4() -> str:
    """Return this node's tailnet IPv4 (100.64.0.0/10), or raise RuntimeError."""
    try:
        proc = subprocess.run(
            ["tailscale", "ip", "-4"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError) as exc:
        raise RuntimeError(f"cannot run 'tailscale' CLI: {exc}") from exc
    if proc.returncode != 0:
        raise RuntimeError(
            f"'tailscale ip -4' failed: {(proc.stderr or '').strip() or 'is tailscaled running?'}"
        )
    for line in proc.stdout.splitlines():
        line = line.strip()
        try:
            addr = ipaddress.ip_address(line)
        except ValueError:
            continue
        if addr.version == 4 and addr in _TAILNET_V4:
            return str(addr)
    raise RuntimeError("no tailnet IPv4 found; is this node joined to a tailnet?")


def _tailnet_dns_name() -> str:
    """Best-effort MagicDNS name for this node (empty string if unavailable)."""
    try:
        proc = subprocess.run(
            ["tailscale", "status", "--json"],
            capture_output=True,
            text=True,
            timeout=5,
            check=False,
        )
        data = json.loads(proc.stdout)
        return str(data.get("Self", {}).get("DNSName", "")).rstrip(".")
    except Exception:
        return ""


_SERVE_CSS_FILE = "lotuspod.css"
_SERVE_NEVER_FILES = frozenset({MANIFEST_FILE, "FINDINGS.md"})
_DENY_PATH_NAME = ".lotuspod-not-found"


def serve_allow_list(out_dir: Path) -> frozenset[str]:
    """Names serve v2 may answer with: visible pages + support files.

    Same fail-closed rule as manifest/index: an artifact page is servable
    only when its lotuspod:visible meta flag parses to exactly true.
    manifest.json and FINDINGS.md are never served (_SERVE_NEVER_FILES):
    the manifest lists private artifact ids, so it must stay unreachable
    over HTTP even though it lives in the served directory.
    """
    allowed = {INDEX_FILE, _SERVE_CSS_FILE}
    try:
        pages = sorted(out_dir.glob("*.html"))
    except OSError:
        return allowed
    for page in pages:
        if page.name == INDEX_FILE:
            continue
        try:
            visible = extract_visibility(page.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError):
            continue
        if visible:
            allowed.add(page.name)
    return frozenset(allowed)


class _AllowListHandler(SimpleHTTPRequestHandler):
    """Serve v2: answer only allow-listed names; everything else is a 404."""

    def __init__(self, *args, root: Path, **kwargs):
        self.root = Path(root)
        super().__init__(*args, **kwargs)

    def translate_path(self, path: str) -> str:
        fs_path = Path(super().translate_path(path))
        try:
            rel = fs_path.relative_to(self.root)
        except ValueError:
            rel = None
        if rel is not None:
            if not rel.parts:
                return str(self.root / INDEX_FILE)
            if (
                len(rel.parts) == 1
                and rel.name not in _SERVE_NEVER_FILES
                and rel.name in serve_allow_list(self.root)
            ):
                return str(fs_path)
        return str(self.root / _DENY_PATH_NAME)

    def list_directory(self, path: str):
        self.send_error(HTTPStatus.NOT_FOUND, "File not found")
        return None


def resolve_serve_host(host_override: str) -> str:
    """Explicit --host wins; otherwise auto-detect the tailnet IPv4."""
    return host_override if host_override else tailnet_ipv4()


def _make_server(out_dir: Path, host: str, port: int) -> ThreadingHTTPServer:
    handler = partial(_AllowListHandler, directory=str(out_dir), root=out_dir)
    return ThreadingHTTPServer((host, port), handler)


def cmd_serve(args: argparse.Namespace) -> int:
    out_dir = Path(args.out_dir) if args.out_dir else DEFAULT_OUTPUT_DIR
    if not out_dir.is_dir():
        raise FileNotFoundError(f"artifacts directory not found: {out_dir}")

    host = resolve_serve_host(args.host)

    try:
        server = _make_server(out_dir, host, args.port)
    except OSError as exc:
        print(f"error: cannot bind {host}:{args.port}: {exc}", file=sys.stderr)
        return 1

    if not (out_dir / INDEX_FILE).exists():
        print(f"note: no {INDEX_FILE} yet; run `lotuspod index` to build one")
    if args.host:
        print(f"serving {out_dir} on {args.host} (v2 allow-list):")
    else:
        print(f"serving {out_dir} on the tailnet (v2 allow-list):")
    print(f"  http://{host}:{args.port}/")
    if not args.host:
        dns_name = _tailnet_dns_name()
        if dns_name:
            print(f"  http://{dns_name}:{args.port}/")
    print("ctrl-c to stop")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
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
    render.add_argument(
        "--hidden",
        action="store_true",
        help="mark the artifact not visible (excluded from manifest/index)",
    )
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

    serve = sub.add_parser(
        "serve",
        help="serve the artifacts directory over the tailnet (v2: allow-list enforced)",
    )
    serve.add_argument("--out-dir", default="", help="artifacts directory (default: artifacts/)")
    serve.add_argument(
        "--port", type=int, default=DEFAULT_SERVE_PORT, help=f"TCP port (default: {DEFAULT_SERVE_PORT})"
    )
    serve.add_argument(
        "--host",
        default="",
        help="bind address override (default: auto-detected tailnet IPv4); "
        "use 127.0.0.1 when a local Cloudflare Tunnel fronts the server",
    )
    serve.set_defaults(func=cmd_serve)

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
