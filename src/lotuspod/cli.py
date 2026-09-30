"""Minimal CLI for rendering Lotuspod artifacts from the template + theme."""

from __future__ import annotations

import argparse
import base64
import configparser
import datetime as _dt
import fcntl
import hashlib
import html
import ipaddress
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import urllib.parse
from contextlib import contextmanager
from functools import partial
from html.parser import HTMLParser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import importlib.resources as _res

from lotuspod import access, markdown

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
_SECTION = re.compile(
    r"\{\{#([a-zA-Z_][a-zA-Z0-9_]*)\}\}(.*?)\{\{/([a-zA-Z_][a-zA-Z0-9_]*)\}\}", re.DOTALL
)

_EPISODE_KICKER = re.compile(r"^Lotuspod · Episode (.+)$")
_TITLE_RE = re.compile(r'<h1 class="artifact-title">(.*?)</h1>', re.DOTALL)
_KICKER_RE = re.compile(r'<p class="artifact-kicker">(.*?)</p>', re.DOTALL)
_DATE_RE = re.compile(r'<time datetime="([^"]*)">')
_SUMMARY_RE = re.compile(r'<p class="artifact-summary">(.*?)</p>', re.DOTALL)
_VISIBLE_TAG_RE = re.compile(
    r"<meta\s[^>]*name=[\"']lotuspod:visible[\"'][^>]*>", re.IGNORECASE
)
_META_CONTENT_RE = re.compile(r"content=[\"']([^\"']*)[\"']", re.IGNORECASE)

# Render variants. Each is one ruleset in lotuspod.css keyed off a class on
# the main element, never a second stylesheet: the one file serve allow-lists
# is the whole theme. The default variant stamps nothing, so a page rendered
# without --variant is byte-identical to one rendered before variants existed.
DEFAULT_VARIANT = "article"
VARIANTS = (DEFAULT_VARIANT, "report")


def load_tokens() -> dict:
    tokens_path = THEME_DIR / "tokens.json"
    with tokens_path.open(encoding="utf-8") as fh:
        return json.load(fh)


# A diagram block: a `pre` whose class list carries `mermaid`. Mermaid reads the
# element's text verbatim, so render leaves it alone and only decides from its
# presence whether the page needs the drawing script at all.
_MERMAID_BLOCK = re.compile(r'<pre\b[^>]*\bclass="[^"]*\bmermaid\b')


def has_mermaid_block(body: str) -> bool:
    return _MERMAID_BLOCK.search(body) is not None


def mermaid_theme_variables(tokens: dict) -> str:
    """Mermaid `themeVariables` for its `base` theme, serialised from the tokens.

    One source for the palette: the diagram takes the same surface, lavender
    and night the stylesheet does, instead of Mermaid's default white.
    """
    colors, fonts = tokens["colors"], tokens["fonts"]
    variables = {
        "background": colors["night"],
        "fontFamily": fonts["mono"],
        "lineColor": colors["lavender"],
        "primaryBorderColor": colors["lavender"],
        "primaryColor": colors["surface"],
        "primaryTextColor": colors["pale_lavender"],
        "secondaryBorderColor": colors["lavender"],
        "secondaryColor": colors["glow"],
        "secondaryTextColor": colors["pale_lavender"],
        "tertiaryBorderColor": colors["lavender"],
        "tertiaryColor": colors["deep_night"],
        "tertiaryTextColor": colors["pale_lavender"],
        "textColor": colors["pale_lavender"],
    }
    return json.dumps(variables, sort_keys=True)


def _resolve_sections(template: str, context: dict) -> str:
    """Drop `{{#key}}...{{/key}}` blocks whose context value is empty.

    Markup only some pages carry can then sit in the template beside the markup
    every page carries, instead of being assembled in Python where a reader of
    the theme would not think to look for it.
    """

    def _sub(match: re.Match) -> str:
        key, body, closing = match.groups()
        if key != closing:
            raise KeyError(f"template section {key!r} closed by {closing!r}")
        if key not in context:
            raise KeyError(f"template section {key!r} missing from context")
        return body if context[key] else ""

    return _SECTION.sub(_sub, template)


def render_template(context: dict, template_path: Path = TEMPLATE_PATH) -> str:
    template = _resolve_sections(template_path.read_text(encoding="utf-8"), context)

    def _sub(match: re.Match) -> str:
        key = match.group(1)
        if key not in context:
            raise KeyError(f"template placeholder {key!r} missing from context")
        return str(context[key])

    missing = set(_PLACEHOLDER.findall(template)) - set(context)
    if missing:
        raise KeyError(f"missing context keys: {sorted(missing)}")
    return _PLACEHOLDER.sub(_sub, template)


# The pinned Mermaid's directory on jsDelivr. The page template's start-up
# module imports the library from here, and the library its chunks.
MERMAID_DIR = "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/"

# Context values an author supplies. None of them is part of a script the
# template writes, so a page rendered with them blank holds exactly the
# template's own inline scripts.
_AUTHORED_KEYS = ("title", "kicker", "date", "summary_block", "body", "outline_items", "revision")


class _ScriptCollector(HTMLParser):
    """Count a page's script elements and keep the text of the inline ones."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.count = 0
        self.inline: list[str] = []
        self._text: list[str] | None = None

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag == "script":
            self.count += 1
            if not any(name == "src" for name, _ in attrs):
                self._text = []

    def handle_data(self, data: str) -> None:
        if self._text is not None:
            self._text.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "script" and self._text is not None:
            self.inline.append("".join(self._text))
            self._text = None


def collect_scripts(page_html: str) -> _ScriptCollector:
    parser = _ScriptCollector()
    parser.feed(page_html)
    parser.close()
    return parser


def script_hash(text: str) -> str:
    """A CSP hash source for an inline script's text as written."""
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    return "'sha256-" + base64.b64encode(digest).decode("ascii") + "'"


def page_policy(page_html: str, own_scripts: set[str]) -> str:
    """The Content-Security-Policy for a finished page.

    Scripts run from the site itself, and inline only when the template
    wrote them (own_scripts): each such script in the page is allowed by its
    hash, and the Mermaid directory only when one of them loads from it. A
    script in the body is never hashed, so it never runs, and neither does
    an inline event handler.
    """
    script_src = ["'self'"]
    hashes: list[str] = []
    for text in collect_scripts(page_html).inline:
        if text not in own_scripts:
            continue
        if MERMAID_DIR in text and MERMAID_DIR not in script_src:
            script_src.append(MERMAID_DIR)
        source = script_hash(text)
        if source not in hashes:
            hashes.append(source)
    directives = (
        "default-src 'self'",
        "script-src " + " ".join(script_src + hashes),
        # Mermaid sets its styles inline.
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
    )
    return "; ".join(directives)


def render_page(context: dict) -> str:
    """Render an artifact page with its policy meta tag in the head.

    The policy is computed from the finished page, so it never allows more
    than the page holds.
    """
    blank = {**context, **dict.fromkeys(_AUTHORED_KEYS, ""), "outline": []}
    own_scripts = set(collect_scripts(render_template({**blank, "policy": ""})).inline)
    page = render_template({**context, "policy": ""})
    return render_template({**context, "policy": page_policy(page, own_scripts)})


def script_warning(name: str, body: str) -> str:
    """The line render prints for a body holding scripts ("" when none)."""
    count = collect_scripts(body).count
    if not count:
        return ""
    noun = "script" if count == 1 else "scripts"
    return (
        f"warning: {name}: {count} {noun} will not run; "
        "a page runs only the site's own scripts"
    )


THEME_FILES = ("lotuspod.css", "favicon.svg")


def write_atomic(path: Path, data: bytes) -> None:
    """Write to a temporary file beside path, then rename it into place.

    A reader - serve, or a publish running beside this one - sees the old
    file or the new one, never half of either. The temporary name starts
    with a dot and ends in .tmp, so no page glob and no serve request ever
    matches it.
    """
    tmp = path.with_name(f".{path.name}.{os.getpid()}.{os.urandom(4).hex()}.tmp")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o666)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def sync_theme_css(out_dir: Path) -> None:
    """Keep the artifact dir's theme files identical to the packaged theme.

    Covers the stylesheet and the favicon (THEME_FILES). Rewriting only on a
    content difference means a theme upgrade reaches already-rendered
    directories while untouched ones keep their mtime.
    """
    for filename in THEME_FILES:
        packaged = THEME_DIR / filename
        theme_copy = out_dir / filename
        if not theme_copy.exists() or theme_copy.read_bytes() != packaged.read_bytes():
            write_atomic(theme_copy, packaged.read_bytes())


_OUTLINE_MIN_HEADINGS = 2
_SLUG_STRIP = re.compile(r"[^a-z0-9]+")
_SLUG_FALLBACK = "section"


class _H2Collector(HTMLParser):
    """Locate the body's h2 elements: source span, explicit id, and text.

    Spans are recorded against the source string rather than re-serialized,
    so injecting an id can splice the original bytes back untouched - the
    parser never gets to normalize markup the author wrote by hand.
    """

    def __init__(self, body: str) -> None:
        super().__init__(convert_charrefs=True)
        self._line_starts = [0]
        for index, char in enumerate(body):
            if char == "\n":
                self._line_starts.append(index + 1)
        self._open: dict | None = None
        # Depth of `pre` nesting while inside a `pre.mermaid`, 0 outside one.
        # Mermaid reads a diagram block's text verbatim and allows HTML in
        # node labels, so an h2 spelled out there is diagram source, not a
        # heading - it gets no id and no outline entry.
        self._mermaid_depth = 0
        self.headings: list[dict] = []
        self.ids: set[str] = set()

    def _offset(self) -> int:
        line, column = self.getpos()
        return self._line_starts[line - 1] + column

    def handle_starttag(self, tag: str, attrs: list) -> None:
        explicit = next((v for k, v in attrs if k == "id" and v), "")
        if explicit:
            # Every element's id is reserved, not just the headings' - an
            # anchor that lands on some other element is a broken anchor.
            self.ids.add(explicit)
        if tag == "pre":
            classes = next((v for k, v in attrs if k == "class" and v), "").split()
            if self._mermaid_depth or "mermaid" in classes:
                self._mermaid_depth += 1
        if tag != "h2" or self._mermaid_depth:
            return
        self._finish()
        start = self._offset()
        source = self.get_starttag_text() or ""
        self._open = {
            "start": start,
            "end": start + len(source),
            "source": source,
            "id": explicit,
            "text": [],
        }

    def handle_data(self, data: str) -> None:
        if self._open is not None:
            self._open["text"].append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "pre" and self._mermaid_depth:
            self._mermaid_depth -= 1
        elif tag == "h2" and not self._mermaid_depth:
            self._finish()

    def _finish(self) -> None:
        """Close the open heading, collapsing its text to a single line."""
        if self._open is None:
            return
        self._open["text"] = " ".join("".join(self._open["text"]).split())
        self.headings.append(self._open)
        self._open = None

    def close(self) -> None:
        super().close()
        self._finish()


def slugify(text: str) -> str:
    """Lowercase text to a slug; every run of non-alphanumerics becomes '-'."""
    return _SLUG_STRIP.sub("-", text.lower()).strip("-") or _SLUG_FALLBACK


def _unique_id(base: str, taken: set[str]) -> str:
    """First free id in the deterministic series base, base-2, base-3, ..."""
    candidate = base
    suffix = 2
    while candidate in taken:
        candidate = f"{base}-{suffix}"
        suffix += 1
    return candidate


def outline_body(body: str) -> tuple[str, list[dict]]:
    """Give the body's h2s stable ids; return (body, outline entries).

    Ids come from the heading text alone, so the same body always yields the
    same anchors - a re-render never breaks a link someone already shared.
    Headings that carry an explicit id keep it (it may already be linked) and
    only reserve that name, so a generated id can never collide with one -
    nor with an id already spelled out anywhere else in the body.
    A body with fewer than two h2s has nothing to navigate, so it is left
    exactly as written.
    """
    parser = _H2Collector(body)
    parser.feed(body)
    parser.close()
    headings = parser.headings
    if len(headings) < _OUTLINE_MIN_HEADINGS:
        return body, []

    taken = set(parser.ids)
    outline: list[dict] = []
    pieces: list[str] = []
    cursor = 0
    for heading in headings:
        heading_id = heading["id"]
        if not heading_id:
            heading_id = _unique_id(slugify(heading["text"]), taken)
            taken.add(heading_id)
            # Splice the id in just after the "<h2" the tag opens with, so
            # the author's own attributes and spacing survive verbatim.
            source = heading["source"]
            pieces.append(body[cursor:heading["start"]])
            pieces.append(f'{source[:3]} id="{heading_id}"{source[3:]}')
            cursor = heading["end"]
        outline.append({"id": heading_id, "text": heading["text"]})
    pieces.append(body[cursor:])
    return "".join(pieces), outline


def outline_html(outline: list[dict]) -> str:
    """Render the outline's section links ("" when there is none).

    Only the `<li>` items are built here - the nav, disclosure and list that
    wrap them live in artifact.html, inside an `{{#outline}}` section the
    renderer drops when this returns nothing. One list serves both roles the
    theme draws from it - a sticky rail beside the prose where the page is wide
    enough for one, a disclosure above the prose where it is not - so there is
    never a second copy of the links to keep in step, and no script deciding
    which copy to show. It ships open: folding it away is the reader's to do,
    at either width.
    """
    esc = html.escape
    return "\n".join(
        '            <li><a href="#{id}">{text}</a></li>'.format(
            id=esc(str(entry["id"])), text=esc(str(entry["text"]))
        )
        for entry in outline
    )


def variant_class(variant: str) -> str:
    """The class the main element carries for a variant ("" for the default)."""
    if variant not in VARIANTS:
        raise KeyError(f"unknown render variant {variant!r}")
    return "" if variant == DEFAULT_VARIANT else f" artifact--{variant}"


def _git(out_dir: Path, *argv: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(out_dir), *argv],
        capture_output=True,
        text=True,
        env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
    )


class _GitFailed(Exception):
    pass


def _git_ok(out_dir: Path, *argv: str) -> str:
    done = _git(out_dir, *argv)
    if done.returncode != 0:
        lines = (done.stderr or done.stdout).strip().splitlines()
        detail = lines[-1].strip() if lines else f"exit {done.returncode}"
        raise _GitFailed(f"git {argv[0]}: {detail}")
    return done.stdout


def commit_output(out_dir: Path, message: str) -> None:
    """Commit and push out_dir when it is the top of its own git repository.

    Anywhere else (no repository, or a subdirectory of one) this does
    nothing. A git failure prints one warning line and returns: the files
    are already written, and the next render pushes the backlog.
    """
    try:
        top = _git(out_dir, "rev-parse", "--show-toplevel")
        if top.returncode != 0 or not top.stdout.strip():
            return
        if Path(top.stdout.strip()).resolve() != Path(out_dir).resolve():
            return
    except OSError:
        return

    try:
        _git_ok(out_dir, "add", "-A")
        if _git(out_dir, "diff", "--cached", "--quiet").returncode != 0:
            _git_ok(out_dir, "commit", "-q", "-m", message)
        if _git(out_dir, "rev-parse", "--verify", "--quiet", "HEAD").returncode != 0:
            return
        if _git(out_dir, "remote", "get-url", "origin").returncode != 0:
            return
        _git_ok(out_dir, "fetch", "origin")
        # A remote with no main yet (a fresh bare repository) has nothing
        # to rebase onto; the push creates the branch.
        has_main = _git(
            out_dir, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/main"
        )
        if has_main.returncode == 0:
            try:
                _git_ok(out_dir, "rebase", "origin/main")
            except _GitFailed:
                _git(out_dir, "rebase", "--abort")
                raise
        _git_ok(out_dir, "push", "origin", "HEAD:main")
    except (_GitFailed, OSError) as exc:
        print(f"warning: {out_dir} not committed and pushed: {exc}", file=sys.stderr)


def cmd_render(args: argparse.Namespace) -> int:
    tokens = load_tokens()
    kicker = "Lotuspod"
    if args.episode:
        kicker = f"Lotuspod · Episode {args.episode}"
    summary_block = f'<p class="artifact-summary">{args.summary}</p>' if args.summary else ""
    body = args.body
    markdown_path = getattr(args, "markdown", None)
    if markdown_path:
        # Read here rather than passed on the command line, so a body of any
        # size gets through; `-` reads standard input.
        if markdown_path == "-":
            text = sys.stdin.read()
        else:
            text = Path(markdown_path).read_text(encoding="utf-8")
        body = markdown.to_body(text)
    body, outline = (body, []) if args.no_outline else outline_body(body)
    context = {
        "title": args.title,
        "kicker": kicker,
        "date": args.date or _dt.date.today().isoformat(),
        "summary_block": summary_block,
        "body": body,
        "outline": outline,
        "outline_items": outline_html(outline),
        "theme_name": tokens["name"],
        "theme_version": tokens["version"],
        "visible": "false" if args.hidden else "true",
        "revision": getattr(args, "revision", ""),
        "variant_class": variant_class(args.variant),
        "mermaid": has_mermaid_block(body),
        "mermaid_theme_variables": mermaid_theme_variables(tokens),
        "mermaid_dir": MERMAID_DIR,
    }
    html = render_page(context)

    out_dir = Path(args.out_dir) if args.out_dir else DEFAULT_OUTPUT_DIR
    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{args.name}.html"

    sync_theme_css(out_dir)

    write_atomic(out_path, html.encode("utf-8"))
    warning = script_warning(args.name, body)
    if warning:
        print(warning, file=sys.stderr)
    source = getattr(args, "source", None)
    if source:
        destination = out_dir / f"{args.name}.md"
        # The source may already be the copy beside the page, edited in place.
        if not (destination.exists() and Path(source).samefile(destination)):
            shutil.copyfile(source, destination)
    print(f"rendered {out_path}")
    if getattr(args, "commit", True):
        commit_output(out_dir, f"render {args.name}")
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

    # The page holds its title and summary as markup; the metadata is their
    # text, escaped again only for wherever it is written next.
    return {
        "file": f"{stem}.html",
        "title": html.unescape(title.group(1)) if title else stem,
        "episode": episode,
        "date": date.group(1) if date else "",
        "summary": html.unescape(summary.group(1)) if summary else "",
        "visible": extract_visibility(page_html),
    }


# A page's kept HTML source, NAME.body.html, sits beside NAME.html as NAME.md
# does for a markdown page: a source, never a page.
BODY_SOURCE_SUFFIX = ".body.html"


def is_page_name(name: str) -> bool:
    """Whether a *.html name in the output directory is an artifact page."""
    return (
        name != INDEX_FILE
        and not name.startswith(".")
        and not name.endswith(BODY_SOURCE_SUFFIX)
    )


def collect_artifacts(out_dir: Path) -> tuple[list[dict], int]:
    """Parse every artifact page; return (visible entries, hidden count).

    Visible entries come back newest-first (date descending, filename as the
    tiebreaker) so the index leads with the latest work by default."""
    pages = sorted(p for p in out_dir.glob("*.html") if is_page_name(p.name))
    metas = [extract_meta(p.read_text(encoding="utf-8"), p.stem) for p in pages]
    visible = [m for m in metas if m["visible"]]
    visible.sort(key=lambda m: m.get("date") or "", reverse=True)
    return visible, len(metas) - len(visible)


def _hidden_note(hidden: int) -> str:
    return f", {hidden} not visible" if hidden else ""


def cmd_manifest(args: argparse.Namespace) -> int:
    out_dir = Path(args.out_dir) if args.out_dir else DEFAULT_OUTPUT_DIR
    if not out_dir.is_dir():
        raise FileNotFoundError(f"artifacts directory not found: {out_dir}")

    artifacts, hidden = collect_artifacts(out_dir)
    sync_theme_css(out_dir)

    manifest_path = out_dir / MANIFEST_FILE
    write_atomic(
        manifest_path,
        (
            json.dumps({"version": MANIFEST_VERSION, "artifacts": artifacts}, indent=2)
            + "\n"
        ).encode("utf-8"),
    )
    print(f"wrote {manifest_path} ({len(artifacts)} artifacts{_hidden_note(hidden)})")
    if getattr(args, "commit", True):
        commit_output(out_dir, "manifest")
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


def render_index(artifacts: list[dict]) -> str:
    """The index page's text for a visible set."""
    tokens = load_tokens()
    context = {
        "generated": _dt.date.today().isoformat(),
        "entries_block": index_entries_html(artifacts),
        "theme_name": tokens["name"],
        "theme_version": tokens["version"],
    }
    return render_template(context, INDEX_TEMPLATE_PATH)


def cmd_index(args: argparse.Namespace) -> int:
    out_dir = Path(args.out_dir) if args.out_dir else DEFAULT_OUTPUT_DIR
    if not out_dir.is_dir():
        raise FileNotFoundError(f"artifacts directory not found: {out_dir}")

    artifacts, hidden = collect_artifacts(out_dir)

    sync_theme_css(out_dir)

    out_path = out_dir / INDEX_FILE
    write_atomic(out_path, render_index(artifacts).encode("utf-8"))
    print(
        f"wrote {out_path} ({len(artifacts)} artifacts{_hidden_note(hidden)})"
    )
    if getattr(args, "commit", True):
        commit_output(out_dir, "index")
    return 0


PUBLISH_FORMATS = ("markdown", "html")
_FORMAT_BY_SUFFIX = {".md": "markdown", ".markdown": "markdown", ".html": "html", ".htm": "html"}
# Where each kind of source is kept beside its page, byte for byte as read.
_KEPT_SOURCE_SUFFIX = {"markdown": ".md", "html": BODY_SOURCE_SUFFIX}
# No dot, so a page name can never end in .body and pass for a source.
_PAGE_NAME = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]*")
PUBLISH_VARIANT = "report"
REVISION_LENGTH = 12
NO_REVISION = "none"
EXIT_REVISION_CONFLICT = 3
EXIT_CONFIG = 2
CONFIG_ENV = "LOTUSPOD_CONFIG"
DEFAULT_REMOTE_COMMAND = "lotuspod"
_REVISION_TAG_RE = re.compile(
    r"<meta\s[^>]*name=[\"']lotuspod:revision[\"'][^>]*>", re.IGNORECASE
)
_MAIN_CLASS_RE = re.compile(r'<main class="([^"]*)"')


def source_revision(data: bytes) -> str:
    """A source's revision: the head of the SHA-256 of its bytes."""
    return hashlib.sha256(data).hexdigest()[:REVISION_LENGTH]


def page_revision(out_dir: Path, name: str) -> str:
    """The revision NAME.html is published at; "none" when there is no page.

    A page rendered before revisions were stamped takes its kept source's.
    """
    page = out_dir / f"{name}.html"
    if not page.exists():
        return NO_REVISION
    tag = _REVISION_TAG_RE.search(page.read_text(encoding="utf-8"))
    content = _META_CONTENT_RE.search(tag.group(0)) if tag else None
    if content:
        return content.group(1).strip()
    for suffix in _KEPT_SOURCE_SUFFIX.values():
        kept = out_dir / f"{name}{suffix}"
        if kept.is_file():
            return source_revision(kept.read_bytes())
    return ""


def page_variant(page_html: str) -> str:
    """The render variant a page's main element carries."""
    main = _MAIN_CLASS_RE.search(page_html)
    classes = main.group(1).split() if main else []
    for variant in VARIANTS:
        stamp = variant_class(variant).strip()
        if stamp and stamp in classes:
            return variant
    return DEFAULT_VARIANT


def markdown_title(text: str) -> str:
    """The text of the first `# ` line outside a code fence ("" when none)."""
    fenced = False
    for line in text.split("\n"):
        if line.startswith("```"):
            fenced = not fenced
        elif not fenced and line.startswith("# "):
            return line[2:].strip()
    return ""


class _H1Collector(HTMLParser):
    """Locate the body's first h1: source span and text (see _H2Collector)."""

    def __init__(self, body: str) -> None:
        super().__init__(convert_charrefs=True)
        self._body = body
        self._line_starts = [0]
        for index, char in enumerate(body):
            if char == "\n":
                self._line_starts.append(index + 1)
        self._mermaid_depth = 0
        self._open = False
        self.start: int | None = None
        self.end: int | None = None
        self.text: list[str] = []

    def _offset(self) -> int:
        line, column = self.getpos()
        return self._line_starts[line - 1] + column

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag == "pre":
            classes = next((v for k, v in attrs if k == "class" and v), "").split()
            if self._mermaid_depth or "mermaid" in classes:
                self._mermaid_depth += 1
        if tag == "h1" and self.start is None and not self._mermaid_depth:
            self.start = self._offset()
            self._open = True

    def handle_data(self, data: str) -> None:
        if self._open:
            self.text.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "pre" and self._mermaid_depth:
            self._mermaid_depth -= 1
        elif tag == "h1" and self._open:
            self._open = False
            self.end = self._body.index(">", self._offset()) + 1


def html_title(body: str) -> tuple[str, str]:
    """(the first h1's text, the body without that h1); ("", body) when none."""
    parser = _H1Collector(body)
    parser.feed(body)
    parser.close()
    if parser.start is None or parser.end is None:
        return "", body
    title = " ".join("".join(parser.text).split())
    return title, body[:parser.start] + body[parser.end:]


@contextmanager
def publish_lock(out_dir: Path):
    """Hold the output directory's publish lock for the block.

    The lock file sits beside the directory, never inside it, so it is
    never a file of the site and never reaches the artifacts repository.
    """
    lock_path = out_dir.parent / f".{out_dir.name}.publish.lock"
    with open(lock_path, "a") as fh:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX)
        yield


class ConfigError(RuntimeError):
    pass


def config_path() -> Path | None:
    """The first of $LOTUSPOD_CONFIG, $XDG_CONFIG_HOME/lotuspod/config.ini and
    ~/.config/lotuspod/config.ini that is a file (an empty variable counts as
    unset); None when none is."""
    candidates = []
    named = os.environ.get(CONFIG_ENV, "")
    if named:
        candidates.append(Path(named))
    base = os.environ.get("XDG_CONFIG_HOME", "")
    if base:
        candidates.append(Path(base) / "lotuspod" / "config.ini")
    candidates.append(Path.home() / ".config" / "lotuspod" / "config.ini")
    return next((path for path in candidates if path.is_file()), None)


def config_section(name: str) -> dict[str, str] | None:
    """The config's [NAME] section; None when there is no config file or no
    such section."""
    path = config_path()
    if path is None:
        return None
    parser = configparser.ConfigParser(interpolation=None)
    try:
        with open(path, encoding="utf-8") as fh:
            parser.read_file(fh)
    except (OSError, UnicodeDecodeError, configparser.Error) as exc:
        raise ConfigError(f"cannot read config {path}: {exc}") from None
    if not parser.has_section(name):
        return None
    return {key: value.strip() for key, value in parser.items(name)}


def publish_config() -> dict[str, str]:
    """The config's [publish] section; {} when there is no config file."""
    return config_section("publish") or {}


def access_verifier() -> access.Verifier | None:
    """The Access verifier the config's [access] section describes; None
    when there is no such section."""
    section = config_section("access")
    if section is None:
        return None
    try:
        return access.Verifier(access.parse_config(section))
    except ValueError as exc:
        raise ConfigError(f"config {config_path()}: {exc}") from None


def publish_target(args: argparse.Namespace) -> tuple[str, str, str]:
    """(label, format, page name) of the source, or a refusal."""
    if args.source == "-":
        if not args.format or not args.name:
            raise RuntimeError("publishing standard input needs --format and --name")
        label = "standard input"
        fmt = args.format
    else:
        label = args.source
        fmt = args.format or _FORMAT_BY_SUFFIX.get(Path(args.source).suffix.lower(), "")
        if not fmt:
            raise RuntimeError(
                f"cannot tell the format of {label}: name it .md or .html, or pass --format"
            )
    name = args.name or Path(args.source).name.split(".", 1)[0]
    if not _PAGE_NAME.fullmatch(name) or f"{name}.html" == INDEX_FILE:
        raise RuntimeError(
            f"not a usable page name: {name!r} (letters, digits, '-' and '_'; pass --name)"
        )
    if args.date:
        try:
            _dt.date.fromisoformat(args.date)
        except ValueError:
            raise RuntimeError(f"not an ISO date: {args.date!r}") from None
    return label, fmt, name


def read_source(args: argparse.Namespace, label: str) -> bytes:
    if args.source == "-":
        return sys.stdin.buffer.read()
    try:
        return Path(args.source).read_bytes()
    except FileNotFoundError:
        raise FileNotFoundError(f"source not found: {label}") from None
    except OSError as exc:
        raise RuntimeError(f"cannot read {label}: {exc.strerror}") from None


def remote_publish_command(command: str, out_dir: str, fmt: str, name: str,
                           args: argparse.Namespace) -> str:
    """The command line ssh hands the writer host's shell.

    ssh joins its arguments into one string for the far shell, so every
    argument after COMMAND is quoted; COMMAND is the config owner's own
    shell text and is used as written. Each value rides as --option=value,
    so one beginning with '-' is never taken for an option on the far side.
    """
    argv = ["publish", "--local", "-", f"--out-dir={out_dir}", f"--format={fmt}",
            f"--name={name}"]
    for option, value in (
        ("--title", args.title),
        ("--summary", args.summary),
        ("--variant", args.variant),
        ("--date", args.date or None),
        ("--expect-revision", args.expect_revision),
    ):
        if value is not None:
            argv.append(f"{option}={value}")
    return " ".join([command, *(shlex.quote(arg) for arg in argv)])


def publish_over_ssh(args: argparse.Namespace, config: dict[str, str]) -> int:
    """Run publish on the config's host with the source on standard input.

    The far side's output passes through and its exit status is returned
    as it is, so a revision conflict still exits 3.
    """
    host = config["host"]
    out_dir = config.get("out_dir", "")
    if not out_dir:
        raise ConfigError(f"config {config_path()} sets host but no out_dir in [publish]")
    if args.out_dir:
        raise ConfigError(
            f"--out-dir names a directory on this machine, but config {config_path()} "
            "publishes on its host; pass --local to publish here"
        )
    label, fmt, name = publish_target(args)
    data = read_source(args, label)
    command = config.get("command") or DEFAULT_REMOTE_COMMAND
    remote = remote_publish_command(command, out_dir, fmt, name, args)
    try:
        done = subprocess.run(["ssh", host, remote], input=data)
    except OSError as exc:
        raise RuntimeError(f"cannot run ssh: {exc.strerror}") from None
    return done.returncode


def cmd_publish(args: argparse.Namespace) -> int:
    """Render a page from its source, keep the source, rebuild the manifest
    and the index, and commit and push once.

    When the config names a host and --local is not given, publish runs
    there over ssh instead (see publish_over_ssh).

    Everything that can be refused is refused before anything is written.
    From the revision check to the commit the directory's publish lock is
    held, so two publishes of one page cannot both pass the check.
    """
    if not args.local:
        try:
            config = publish_config()
            if config.get("host"):
                return publish_over_ssh(args, config)
        except ConfigError as exc:
            print(f"error: {exc}", file=sys.stderr)
            return EXIT_CONFIG

    out_dir = (Path(args.out_dir) if args.out_dir else DEFAULT_OUTPUT_DIR).resolve()
    label, fmt, name = publish_target(args)
    data = read_source(args, label)
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise RuntimeError(f"{label} is not UTF-8") from None
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if fmt == "markdown":
        title, body = markdown_title(text), markdown.to_body(text)
    else:
        title, body = html_title(text)
    if args.title is not None:
        title = args.title.strip()
    if not title:
        raise RuntimeError(
            f"{label} has no title: give it a first '# ' line or h1, or pass --title"
        )
    revision = source_revision(data)

    out_dir.mkdir(parents=True, exist_ok=True)
    with publish_lock(out_dir):
        current = page_revision(out_dir, name)
        if args.expect_revision is not None and args.expect_revision != current:
            print(
                f"error: revision conflict: {name} is at revision {current or 'unknown'}, "
                f"not {args.expect_revision}; nothing published",
                file=sys.stderr,
            )
            return EXIT_REVISION_CONFLICT

        # A republish keeps what the page already says unless told otherwise.
        page = out_dir / f"{name}.html"
        previous = page.read_text(encoding="utf-8") if page.exists() else ""
        kept = extract_meta(previous, name) if previous else {}
        summary = args.summary if args.summary is not None else kept.get("summary", "")
        variant = args.variant or (page_variant(previous) if previous else PUBLISH_VARIANT)
        cmd_render(
            argparse.Namespace(
                name=name,
                title=html.escape(title, quote=False),
                episode="",
                date=args.date or kept.get("date") or _dt.date.today().isoformat(),
                summary=html.escape(summary, quote=False),
                body=body,
                hidden=False,
                no_outline=False,
                variant=variant,
                out_dir=str(out_dir),
                revision=revision,
                commit=False,
            )
        )
        for kind, suffix in _KEPT_SOURCE_SUFFIX.items():
            if kind == fmt:
                write_atomic(out_dir / f"{name}{suffix}", data)
            else:
                # A page republished from the other kind keeps one source.
                (out_dir / f"{name}{suffix}").unlink(missing_ok=True)
        steps = argparse.Namespace(out_dir=str(out_dir), commit=False)
        cmd_manifest(steps)
        cmd_index(steps)
        commit_output(out_dir, f"publish {name}")
    print(f"published {name} at revision {revision}")
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
_SERVE_ICON_FILE = "favicon.svg"
_SERVE_SUPPORT_FILES = (_SERVE_CSS_FILE, _SERVE_ICON_FILE)
_SERVE_NEVER_FILES = frozenset({MANIFEST_FILE, "FINDINGS.md"})
_DENY_PATH_NAME = ".lotuspod-not-found"


def serve_allow_list(out_dir: Path) -> frozenset[str]:
    """Names serve v2 may answer with: visible pages + support files.

    Same fail-closed rule as manifest/index: an artifact page is servable
    only when its lotuspod:visible meta flag parses to exactly true.
    manifest.json and FINDINGS.md are never served (_SERVE_NEVER_FILES):
    the manifest lists private artifact ids, so it must stay unreachable
    over HTTP even though it lives in the served directory. Sources
    (NAME.body.html, like NAME.md), dotfiles and symbolic links are never
    pages, so they are never listed.
    """
    allowed = {INDEX_FILE, *_SERVE_SUPPORT_FILES}
    try:
        pages = sorted(out_dir.glob("*.html"))
    except OSError:
        return allowed
    for page in pages:
        if not is_page_name(page.name):
            continue
        try:
            if page.is_symlink():
                continue
            visible = extract_visibility(page.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError):
            continue
        if visible:
            allowed.add(page.name)
    return frozenset(allowed)


# Headers on every page response. A meta tag cannot forbid framing, and
# nosniff keeps a browser from reading a file as a type it was not served as.
_PAGE_HEADERS = (
    ("Content-Security-Policy", "frame-ancestors 'none'"),
    ("X-Content-Type-Options", "nosniff"),
)


# Headers on every /api answer.
_API_HEADERS = (
    ("Content-Type", "application/json"),
    ("Cache-Control", "no-store"),
    ("X-Content-Type-Options", "nosniff"),
)
_API_READ_METHODS = ("GET", "HEAD")


class _AllowListHandler(SimpleHTTPRequestHandler):
    """Serve v2: answer only allow-listed names; everything else is a 404.

    /api paths never reach the file system or method dispatch: whatever the
    method, each is answered only after the request's Access assertion
    verifies (see parse_request and _serve_api).
    """

    # Whether the response being written is a page's (see end_headers).
    _page_response = False

    def __init__(self, *args, root: Path, verifier: access.Verifier | None = None, **kwargs):
        self.root = Path(root)
        self.verifier = verifier
        super().__init__(*args, **kwargs)

    def _api_path(self) -> str | None:
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        return path if path == "/api" or path.startswith("/api/") else None

    def _api_answer(self, status: int, payload: dict, headers: tuple = ()) -> None:
        body = json.dumps(payload).encode("utf-8")
        self._page_response = False
        self.send_response(status)
        for header, value in (*_API_HEADERS, *headers):
            self.send_header(header, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _serve_api(self, path: str) -> None:
        # The reader is known only from a verified assertion; the plain
        # Cf-Access-Authenticated-User-Email header is never read.
        if self.verifier is None:
            self._api_answer(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "access_unconfigured"})
            return
        assertions = self.headers.get_all(access.ASSERTION_HEADER) or []
        try:
            if len(assertions) > 1:
                raise access.InvalidAssertion("more than one assertion")
            email = self.verifier.reader(assertions[0] if assertions else None)
        except access.AccessError as exc:
            self._api_answer(exc.status, {"error": exc.error})
            return
        if path != "/api/whoami":
            self._api_answer(HTTPStatus.NOT_FOUND, {"error": "not_found"})
        elif self.command not in _API_READ_METHODS:
            self._api_answer(
                HTTPStatus.METHOD_NOT_ALLOWED, {"error": "method_not_allowed"},
                (("Allow", ", ".join(_API_READ_METHODS)),),
            )
        else:
            self._api_answer(HTTPStatus.OK, {"actor": {"kind": "human", "email": email}})

    def parse_request(self) -> bool:
        # /api is answered here, before handle_one_request dispatches on the
        # method, so every method (OPTIONS, TRACE, any other word) meets the
        # guard. False tells handle_one_request the request is done.
        if not super().parse_request():
            return False
        path = self._api_path()
        if path is None:
            return True
        self._serve_api(path)
        self.wfile.flush()
        return False

    def translate_path(self, path: str) -> str:
        deny = str(self.root / _DENY_PATH_NAME)
        # A request that climbs, or names a dotfile, is refused as written -
        # before normalisation could fold it back inside the directory.
        words = urllib.parse.unquote(path.split("?", 1)[0].split("#", 1)[0])
        if any(word.startswith(".") for word in words.split("/")):
            return deny
        fs_path = Path(super().translate_path(path))
        try:
            rel = fs_path.relative_to(self.root)
        except ValueError:
            return deny
        if not rel.parts:
            name = INDEX_FILE
        elif (
            len(rel.parts) == 1
            and rel.name not in _SERVE_NEVER_FILES
            and rel.name in serve_allow_list(self.root)
        ):
            name = rel.name
        else:
            return deny
        # A linked page or theme file would serve whatever it points at.
        candidate = self.root / name
        try:
            if candidate.is_symlink() or candidate.resolve().parent != self.root.resolve():
                return deny
        except (OSError, RuntimeError):
            return deny
        return str(candidate)

    def send_head(self):
        # Denial never reaches the file system: were a file ever to sit at
        # the sentinel's name, it would still not be served.
        target = self.translate_path(self.path)
        if target == str(self.root / _DENY_PATH_NAME):
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return None
        self._page_response = target.endswith(".html")
        return super().send_head()

    def end_headers(self):
        if self._page_response:
            for header, value in _PAGE_HEADERS:
                self.send_header(header, value)
        super().end_headers()

    def list_directory(self, path: str):
        self.send_error(HTTPStatus.NOT_FOUND, "File not found")
        return None


def resolve_serve_host(host_override: str) -> str:
    """Explicit --host wins; otherwise auto-detect the tailnet IPv4."""
    return host_override if host_override else tailnet_ipv4()


def _make_server(out_dir: Path, host: str, port: int,
                 verifier: access.Verifier | None = None) -> ThreadingHTTPServer:
    """The allow-list server; /api answers 503 access_unconfigured without a verifier."""
    handler = partial(
        _AllowListHandler, directory=str(out_dir), root=out_dir, verifier=verifier
    )
    return ThreadingHTTPServer((host, port), handler)


def cmd_serve(args: argparse.Namespace) -> int:
    out_dir = Path(args.out_dir) if args.out_dir else DEFAULT_OUTPUT_DIR
    if not out_dir.is_dir():
        raise FileNotFoundError(f"artifacts directory not found: {out_dir}")

    host = resolve_serve_host(args.host)
    verifier = access_verifier()

    try:
        server = _make_server(out_dir, host, args.port, verifier=verifier)
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
    if verifier is None:
        print("note: no [access] section in the config; /api answers 503")
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

    index = sub.add_parser("index", help="build index.html listing rendered artifacts")
    index.add_argument("--out-dir", default="", help="artifacts directory (default: artifacts/)")
    index.set_defaults(func=cmd_index)

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
    publish.add_argument("--out-dir", default="", help="output directory (default: artifacts/)")
    publish.add_argument(
        "--local",
        action="store_true",
        help="publish on this machine even when the config names a host",
    )
    publish.set_defaults(func=cmd_publish)

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
