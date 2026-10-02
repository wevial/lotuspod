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
import io
import json
import os
import re
import shlex
import shutil
import signal
import sqlite3
import subprocess
import sys
import tarfile
import threading
import urllib.parse
from contextlib import contextmanager
from dataclasses import dataclass
from functools import partial
from html.parser import HTMLParser
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable

import importlib.resources as _res

from lotuspod import (access, agents, api, backup, comments, db, decisions, machine,
                      markdown, media, responder, routing, sections)

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


# The page script answers decision forms (lotuspod.decisions), shows and
# posts comments (lotuspod.comments) and folds sections (lotuspod.sections);
# only a page with any of them loads it.
PAGE_SCRIPT = "lotuspod-page.js"
THEME_FILES = ("lotuspod.css", "favicon.svg", PAGE_SCRIPT)
# The served files written as one source per feature, relative to THEME_DIR:
# each is its sources joined in this order, byte for byte. A theme file not
# named here is served as it is. A new feature's file takes one line here.
THEME_SOURCES = {
    "lotuspod.css": (
        "css/base.css",
        "css/forms.css",
        "css/decisions.css",
        "css/comments.css",
        "css/prose.css",
        "css/report.css",
        "css/index.css",
    ),
    PAGE_SCRIPT: (
        "js/page-open.js",
        "js/decisions.js",
        "js/comments.js",
        "js/page-close.js",
    ),
}


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


def theme_files() -> list[tuple[str, bytes]]:
    """Each served theme file (THEME_FILES, in order) with the bytes serve answers.

    The one source for those bytes: sync_theme_css writes them and theme_hash
    names them, so the ?v= address always follows what serve answers.
    THEME_DIR is read at call time, never at import.
    """
    return [(filename, theme_file_bytes(filename)) for filename in THEME_FILES]


def theme_file_bytes(filename: str) -> bytes:
    """The bytes of one served theme file: its sources (THEME_SOURCES) joined
    in their declared order, or the file itself when it has none."""
    sources = THEME_SOURCES.get(filename)
    if sources is None:
        return (THEME_DIR / filename).read_bytes()
    return b"".join((THEME_DIR / source).read_bytes() for source in sources)


def theme_hash() -> str:
    """The theme's address: 12 hex digits of a SHA-256 over each served file's
    name and bytes. A theme edit changes it with nothing to bump."""
    digest = hashlib.sha256()
    for filename, data in theme_files():
        for part in (filename.encode("utf-8"), data):
            digest.update(len(part).to_bytes(8, "big"))
            digest.update(part)
    return digest.hexdigest()[:12]


def sync_theme_css(out_dir: Path) -> None:
    """Keep the artifact dir's theme files identical to the packaged theme.

    Covers the stylesheet, the favicon and the page script (THEME_FILES).
    Rewriting only on a content difference means a theme upgrade reaches
    already-rendered directories while untouched ones keep their mtime.
    """
    for filename, data in theme_files():
        theme_copy = out_dir / filename
        if not theme_copy.exists() or theme_copy.read_bytes() != data:
            write_atomic(theme_copy, data)


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


_OWNER_TAG_RE = re.compile(
    r"<meta\s[^>]*name=[\"']lotuspod:owner[\"'][^>]*>", re.IGNORECASE
)


def page_owner(page_html: str) -> str:
    """The handle a page's lotuspod:owner meta tag names ("" when none)."""
    tag = _OWNER_TAG_RE.search(page_html)
    content = _META_CONTENT_RE.search(tag.group(0)) if tag else None
    return content.group(1).strip() if content else ""


def check_owner(args: argparse.Namespace, out_dir: Path) -> None:
    """Refuse (RuntimeError) args.owner unless the credential of --credential,
    else $LOTUSPOD_CREDENTIAL, may publish as it, in serve's database."""
    handle = args.owner
    if not machine.is_handle(handle):
        raise RuntimeError(
            f"--owner {handle!r} is not a handle: 1 to 63 lower-case letters, digits "
            "and hyphens, starting with a letter or digit; nothing written"
        )
    path = args.credential or os.environ.get(machine.CREDENTIAL_ENV, "")
    if not path:
        raise RuntimeError(
            f"--owner {handle} needs --credential FILE for a credential that may publish "
            f"as {handle}; nothing written"
        )
    try:
        token = machine.read_token(path)
        db_path = serve_db_path(out_dir, args.db)
        if not db_path.is_file():
            raise RuntimeError(f"no credentials at {db_path}; nothing written")
        machine.check_owner(db.Database(db_path), token, handle)
    except (ValueError, sqlite3.Error, OSError) as exc:
        raise RuntimeError(f"--owner {handle}: {exc}; nothing written") from None


def cmd_render(args: argparse.Namespace) -> int:
    with_comments = getattr(args, "comments", False)
    if with_comments and args.no_outline:
        print("error: --comments needs the heading ids --no-outline leaves out; "
              "nothing written", file=sys.stderr)
        return 1
    owner = getattr(args, "owner", "")
    if owner and not getattr(args, "owner_checked", False):
        check_owner(args, Path(args.out_dir) if args.out_dir else DEFAULT_OUTPUT_DIR)
    tokens = load_tokens()
    kicker = "Lotuspod"
    if args.episode:
        kicker = f"Lotuspod · Episode {args.episode}"
    summary_block = f'<p class="artifact-summary">{args.summary}</p>' if args.summary else ""
    body = args.body
    out_dir = Path(args.out_dir) if args.out_dir else DEFAULT_OUTPUT_DIR
    markdown_path = getattr(args, "markdown", None)
    if markdown_path:
        # Read here rather than passed on the command line, so a body of any
        # size gets through; `-` reads standard input.
        if markdown_path == "-":
            text = sys.stdin.read()
        else:
            text = Path(markdown_path).read_text(encoding="utf-8")
        label = "standard input" if markdown_path == "-" else markdown_path
        store_dir = media.media_dir(out_dir)
        sizes = {}
        for line in markdown.images(text):
            if not line.src.startswith(media.URL_PREFIX):
                why = "render draws only /media/ URLs; publish stores a local image"
            else:
                image = media.load_stored(store_dir, line.src[len(media.URL_PREFIX):])
                if image is not None:
                    sizes[image.url] = (image.width, image.height)
                    continue
                why = f"names no image stored in {store_dir}"
            raise RuntimeError(f"image {line.src} in {label}: {why}; nothing written")
        body = markdown.to_body(text, sizes)
    # Before the outline, so the forms sit inside their section.
    body, has_decisions = decisions.render_decisions(body, args.name)
    body, outline = (body, []) if args.no_outline else outline_body(body)
    # After the outline, so each box names its heading's id.
    if with_comments:
        body = comments.render_comments(body, args.name)
    # Last, so each section's box and forms fall inside its wrapper.
    body, wrapped = sections.wrap_sections(body) if outline else (body, False)
    context = {
        "title": args.title,
        "kicker": kicker,
        "date": args.date or _dt.date.today().isoformat(),
        "summary_block": summary_block,
        "body": body,
        "outline": outline,
        "outline_items": outline_html(outline),
        "theme_name": tokens["name"],
        "theme_hash": theme_hash(),
        "visible": "false" if args.hidden else "true",
        "revision": getattr(args, "revision", ""),
        # A handle (check_owner, or a kept one publish checked): no markup.
        "owner": owner,
        "variant_class": variant_class(args.variant),
        "mermaid": has_mermaid_block(body),
        "page_script_needed": has_decisions or with_comments or wrapped,
        "page_script": PAGE_SCRIPT,
        "mermaid_theme_variables": mermaid_theme_variables(tokens),
        "mermaid_dir": MERMAID_DIR,
    }
    html = render_page(context)

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
        "theme_hash": theme_hash(),
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


def configured_socket() -> Path | None:
    """The socket the config's [agents] section names; None when it names none."""
    value = (config_section("agents") or {}).get("socket", "")
    return Path(value).expanduser() if value else None


def agent_socket(args: argparse.Namespace) -> Path:
    """The socket an agent command talks to: --socket, else the config's
    [agents] socket, else lotuspod.sock beside the default database."""
    if args.socket:
        return Path(args.socket)
    return configured_socket() or DEFAULT_OUTPUT_DIR.parent / machine.SOCKET_NAME


def agent_token(args: argparse.Namespace) -> str:
    """The token of --credential, else of $LOTUSPOD_CREDENTIAL's file."""
    path = args.credential or os.environ.get(machine.CREDENTIAL_ENV, "")
    if not path:
        raise ConfigError(f"no credential: pass --credential FILE or set {machine.CREDENTIAL_ENV}")
    try:
        return machine.read_token(path)
    except machine.CredentialError as exc:
        raise ConfigError(str(exc)) from None


def add_agent_options(parser: argparse.ArgumentParser) -> None:
    """--socket and --credential, which every agent command takes."""
    parser.add_argument(
        "--socket", default="", metavar="PATH",
        help="serve's agent socket (default: the config's [agents] socket, else "
        f"{machine.SOCKET_NAME} beside the default database)",
    )
    parser.add_argument(
        "--credential", default="", metavar="FILE",
        help=f"the agent's credential file (default: ${machine.CREDENTIAL_ENV})",
    )


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
                           args: argparse.Namespace, archive: bool = False) -> str:
    """The command line ssh hands the writer host's shell.

    ssh joins its arguments into one string for the far shell, so every
    argument after COMMAND is quoted; COMMAND is the config owner's own
    shell text and is used as written. Each value rides as --option=value,
    so one beginning with '-' is never taken for an option on the far side.
    archive adds --source-archive: standard input is a source archive.
    """
    argv = ["publish", "--local", "-", f"--out-dir={out_dir}", f"--format={fmt}",
            f"--name={name}"]
    for option, value in (
        ("--title", args.title),
        ("--summary", args.summary),
        ("--variant", args.variant),
        ("--date", args.date or None),
        ("--expect-revision", args.expect_revision),
        # The credential and the database are the writer host's.
        ("--owner", args.owner or None),
        ("--credential", args.credential or None),
        ("--db", args.db or None),
    ):
        if value is not None:
            argv.append(f"{option}={value}")
    if not args.comments:
        argv.append("--no-comments")
    if archive:
        argv.append("--source-archive")
    return " ".join([command, *(shlex.quote(arg) for arg in argv)])


def publish_over_ssh(args: argparse.Namespace, config: dict[str, str]) -> int:
    """Run publish on the config's host with the source on standard input.

    The images the source names are read and checked here, and its local
    references rewritten to their media URLs; when there is at least one,
    standard input is a source archive of the rewritten source and the
    images, else the source's bytes as read. The far side's output passes
    through and its exit status is returned as it is, so a revision
    conflict still exits 3.
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
    if args.source_archive:
        raise RuntimeError("--source-archive is what the writer host reads; pass --local")
    label, fmt, name = publish_target(args)
    data = read_source(args, label)
    raw, images = send_images(fmt, decoded(data, label), label, source_base(args), media_cap)
    if images:
        data = source_archive(raw.encode("utf-8"), images)
    command = config.get("command") or DEFAULT_REMOTE_COMMAND
    remote = remote_publish_command(command, out_dir, fmt, name, args, archive=bool(images))
    try:
        done = subprocess.run(["ssh", host, remote], input=data)
    except OSError as exc:
        raise RuntimeError(f"cannot run ssh: {exc.strerror}") from None
    return done.returncode


def decoded(data: bytes, label: str) -> str:
    """A source's bytes as text; RuntimeError when they are not UTF-8."""
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        raise RuntimeError(f"{label} is not UTF-8") from None


def normalized(raw: str) -> str:
    """raw with every line ending a newline."""
    return raw.replace("\r\n", "\n").replace("\r", "\n")


def source_base(args: argparse.Namespace) -> Path | None:
    """The directory a source's local image references resolve against:
    --base, else the source file's directory; None for standard input."""
    if args.base:
        return Path(args.base)
    return None if args.source == "-" else Path(args.source).parent


# A source archive: an uncompressed POSIX tar of the member `source` and one
# member `media/NAME` per image, NAME being its stored name.
SOURCE_MEMBER = "source"
MEDIA_MEMBER = "media/"


def source_archive(data: bytes, images: dict[str, media.Image]) -> bytes:
    """The source archive of source bytes data and images."""
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w", format=tarfile.USTAR_FORMAT) as archive:
        members = [(SOURCE_MEMBER, data)]
        members += [(MEDIA_MEMBER + name, image.data) for name, image in images.items()]
        for member, content in members:
            info = tarfile.TarInfo(member)
            info.size = len(content)
            info.mode = 0o644
            archive.addfile(info, io.BytesIO(content))
    return out.getvalue()


class _KeptTail:
    """A stream that keeps what is read from it from floor on, so the bytes a
    tarfile reads past its last member can be looked at again."""

    def __init__(self, stream) -> None:
        self._stream = stream
        self._kept = bytearray()
        self._start = 0  # where in the stream _kept begins
        self.floor = 0

    def read(self, size: int = -1) -> bytes:
        data = self._stream.read(size)
        self._kept += data
        cut = min(self.floor, self._start + len(self._kept)) - self._start
        if cut > 0:
            del self._kept[:cut]
            self._start += cut
        return data

    def kept(self, position: int, size: int) -> bytes:
        """The size bytes at position already read and kept, reading no more."""
        return bytes(self._kept[position - self._start:position + size - self._start])

    def at(self, position: int, size: int) -> bytes:
        """The size bytes at position (fewer where the stream ends first)."""
        while self._start + len(self._kept) < position + size:
            more = self._stream.read(position + size - self._start - len(self._kept))
            if not more:
                break
            self._kept += more
        return bytes(self._kept[position - self._start:position + size - self._start])


_END_OF_ARCHIVE = bytes(2 * tarfile.BLOCKSIZE)


def read_source_archive(stream, cap: int) -> tuple[bytes, dict[str, media.Image]]:
    """The source and the images of the source archive on stream, each image
    checked again within cap; RuntimeError naming the first refused member.

    The archive is read as a stream and nothing is extracted by its member
    names: only regular files named `source` (once) or `media/` and a stored
    name are taken, and an image's size is checked before its bytes are read.
    A stream tarfile stops reading at a header cut short or malformed, as
    at the end, so the archive must end with its end-of-archive marker
    where tarfile stopped. It also takes PAX and GNU extension headers in
    before the member they rename or resize, which a source archive never
    has, so each member's header must start where the one before it ends.
    """
    source: bytes | None = None
    images: dict[str, media.Image] = {}
    seen: set[str] = set()
    member: tarfile.TarInfo | None = None
    tail = _KeptTail(stream)
    header = 0  # where the next member's header should start

    def refused(reason: object) -> RuntimeError:
        return RuntimeError(f"archive member {member.name}: {reason}; nothing published")

    try:
        with tarfile.open(fileobj=tail, mode="r|") as archive:
            for member in archive:
                if member.offset_data != header + tarfile.BLOCKSIZE:
                    hidden = tail.kept(header, tarfile.BLOCKSIZE)
                    name = hidden[:100].split(b"\0", 1)[0].decode("utf-8", "replace")
                    flag = hidden[156:157].decode("ascii", "replace")
                    raise RuntimeError(
                        f"archive member {name}: an extension header (type {flag!r}), which "
                        "a source archive never has; nothing published"
                    )
                header = tail.floor = archive.offset  # where the next header starts
                name = member.name
                if name in seen:
                    raise refused("named twice")
                seen.add(name)
                stored = name[len(MEDIA_MEMBER):] if name.startswith(MEDIA_MEMBER) else ""
                if name != SOURCE_MEMBER and not media.STORED_NAME.fullmatch(stored):
                    raise refused(f"neither {SOURCE_MEMBER} nor {MEDIA_MEMBER} and a "
                                  "stored image name")
                if member.type not in (tarfile.REGTYPE, tarfile.AREGTYPE):
                    raise refused("not a regular file")
                if name == SOURCE_MEMBER:
                    source = archive.extractfile(member).read()
                    continue
                try:
                    media.check_size(member.size, cap)
                    image = media.check(archive.extractfile(member).read(), stored, cap)
                except media.MediaError as exc:
                    raise refused(exc) from None
                if image.name != stored:
                    raise refused("the SHA-256 of its bytes is not its name")
                images[stored] = image
            end = archive.offset
    except tarfile.TarError as exc:
        where = f"archive member {member.name}" if member else "the source archive"
        raise RuntimeError(f"{where}: cut short or malformed ({exc}); nothing published") \
            from None
    if tail.at(end, len(_END_OF_ARCHIVE)) != _END_OF_ARCHIVE:
        where = f"after archive member {member.name}" if member else "at its start"
        raise RuntimeError(f"the source archive is cut short or malformed {where}: no "
                           "end-of-archive marker follows; nothing published")
    if source is None:
        raise RuntimeError(f"the source archive has no {SOURCE_MEMBER} member; "
                           "nothing published")
    return source, images


# A reference with a scheme (https:, data:) or a host (//host) is remote or
# inline: the page policy's img-src 'self' would block it in the browser.
_REMOTE_IMAGE = re.compile(r"[A-Za-z][A-Za-z0-9+.-]*:|//")


def local_image(src: str, base: Path | None, cap: Callable[[], int]) -> media.Image | None:
    """The image a local reference names, a file inside base; None for a
    media URL, which the writing side looks up. MediaError says why it is
    refused."""
    if _REMOTE_IMAGE.match(src):
        raise media.MediaError(
            "remote and inline images are not published, only files beside the source"
        )
    if src.startswith(media.URL_PREFIX):
        return None
    if base is None:
        raise media.MediaError(
            "a file needs --base DIR to be found from a source on standard input"
        )
    root = base.resolve()
    path = (root / src).resolve()  # follows symbolic links
    if src.startswith("/") or root not in path.parents:
        raise media.MediaError("outside the source's directory")
    if not path.exists():
        raise media.MediaError("no such file")
    if not path.is_file():
        raise media.MediaError("not a regular file")
    media.check_size(path.stat().st_size, cap())
    return media.check(path.read_bytes(), src, cap())


@dataclass(frozen=True, eq=False)
class _Img:
    """An img element of an HTML source: its start tag's span and text, and
    the first value of each of its attributes."""

    start: int
    end: int
    tag: str
    attrs: dict

    @property
    def src(self) -> str:
        return self.attrs["src"]


class _ImgCollector(HTMLParser):
    """Locate the body's img elements that have a src (see _H2Collector),
    and the first srcset on an img or source element."""

    def __init__(self, body: str) -> None:
        super().__init__(convert_charrefs=True)
        self._line_starts = [0]
        for index, char in enumerate(body):
            if char == "\n":
                self._line_starts.append(index + 1)
        self.images: list[_Img] = []
        self.srcset: tuple[str, str] | None = None

    def _offset(self) -> int:
        line, column = self.getpos()
        return self._line_starts[line - 1] + column

    def handle_starttag(self, tag: str, attrs: list) -> None:
        first: dict[str, str | None] = {}
        for key, value in attrs:
            first.setdefault(key, value)
        if tag in ("img", "source") and "srcset" in first and self.srcset is None:
            self.srcset = tag, first["srcset"] or ""
        if tag == "img" and first.get("src") is not None:
            start = self._offset()
            source = self.get_starttag_text() or ""
            self.images.append(_Img(start, start + len(source), source, first))


def html_images(body: str) -> _ImgCollector:
    parser = _ImgCollector(body)
    parser.feed(body)
    parser.close()
    return parser


_TAG_NAME = re.compile(r"<[a-zA-Z][^\t\n\r\f />\x00]*")
_TAG_ATTR = re.compile(
    r"""[\s/]*(?P<name>[^\s/>][^\s/=>]*)(?:\s*=+\s*(?P<value>'[^']*'|"[^"]*"|(?!['"])[^>\s]*))?"""
)


def img_tag(img: _Img, src: str | None = None, extra: str = "") -> str:
    """img's start tag as written, with its src value replaced by src (when
    given) and extra attributes spliced in just after it."""
    at = _TAG_NAME.match(img.tag).end()
    while True:
        attr = _TAG_ATTR.match(img.tag, at)
        if attr is None or attr.end() == at:
            raise media.MediaError("its src attribute cannot be found in the tag as written")
        if attr.group("name").lower() == "src":
            break
        at = attr.end()
    value = attr.group("value") or ""
    if value[:1] in ("'", '"'):
        value = value[1:-1]
    if html.unescape(value) != img.src:
        raise media.MediaError("its src attribute cannot be found in the tag as written")
    start, end = attr.span("value")
    written = img.tag[start:end] if src is None else f'"{html.escape(src)}"'
    return img.tag[:start] + written + extra + img.tag[end:]


def _spliced(body: str, tags: list[tuple[_Img, str]]) -> str:
    """body with each img's start tag replaced by its new one."""
    pieces: list[str] = []
    cursor = 0
    for img, tag in tags:
        pieces += [body[cursor:img.start], tag]
        cursor = img.end
    pieces.append(body[cursor:])
    return "".join(pieces)


def stored_image(src: str, store_dir: Path, sent: dict[str, media.Image]) -> media.Image:
    """The image media URL src names, from sent or else the store;
    MediaError when it names neither."""
    name = src[len(media.URL_PREFIX):] if src.startswith(media.URL_PREFIX) else ""
    image = sent.get(name) or media.load_stored(store_dir, name)
    if image is None:
        raise media.MediaError(f"names no image stored in {store_dir}")
    return image


def send_images(fmt: str, raw: str, label: str, base: Path | None,
                cap: Callable[[], int], stored: Callable[[str], media.Image] | None = None,
                ) -> tuple[str, dict[str, media.Image]]:
    """The sending side of publish: raw, the source, with each local image
    reference rewritten to its media URL, and the images those name by
    stored name, each read from inside base and checked; RuntimeError naming
    the first refused reference. Media URLs are left to the writing side,
    unless stored, the writing side's lookup, is given to check them in turn."""
    if fmt == "markdown":
        refs: list = markdown.images(normalized(raw))
    else:
        found = html_images(raw)
        if found.srcset is not None:
            tag, srcset = found.srcset
            raise RuntimeError(
                f"srcset {srcset} on a {tag} element in {label}: srcset names images "
                "publish never sees; give an img one src; nothing published"
            )
        refs = found.images
    images: dict[str, media.Image] = {}
    moved: list = []
    for ref in refs:
        try:
            image = local_image(ref.src, base, cap)
            if image is None and stored is not None:
                stored(ref.src)
            elif image is not None:
                moved.append((ref, image.url if fmt == "markdown" else img_tag(ref, image.url)))
                images[image.name] = image
        except (media.MediaError, OSError) as exc:
            reason = exc.strerror if isinstance(exc, OSError) and exc.strerror else exc
            raise RuntimeError(f"image {ref.src} in {label}: {reason}; nothing published") \
                from None
    if moved:
        raw = markdown.with_sources(raw, dict(moved)) if fmt == "markdown" else \
            _spliced(raw, moved)
    return raw, images


def resolve_images(fmt: str, raw: str, label: str, store_dir: Path,
                   sent: dict[str, media.Image]) -> tuple[str, dict[str, media.Image]]:
    """The writing side of publish: every image raw refers to, by stored
    name, from sent or else the store, and raw with each HTML img given
    loading="lazy" and its intrinsic width and height where it has none of
    its own. RuntimeError names a reference to no such image, or an image
    in sent that raw does not refer to."""
    if fmt == "markdown":
        refs: list = markdown.images(normalized(raw))
    else:
        refs = html_images(raw).images
    resolved = []
    for ref in refs:
        try:
            resolved.append((ref, stored_image(ref.src, store_dir, sent)))
        except media.MediaError as exc:
            raise RuntimeError(f"image {ref.src} in {label}: {exc}; nothing published") \
                from None
    images = {image.name: image for _, image in resolved}
    for name in sent:
        if name not in images:
            raise RuntimeError(f"archive member {MEDIA_MEMBER}{name}: {label} does not "
                               "refer to it; nothing published")
    if fmt == "html":
        filled = []
        for img, image in resolved:
            extra = ""
            if "loading" not in img.attrs:
                extra += ' loading="lazy"'
            if "width" not in img.attrs and "height" not in img.attrs:
                extra += f' width="{image.width}" height="{image.height}"'
            if extra:
                try:
                    filled.append((img, img_tag(img, extra=extra)))
                except media.MediaError as exc:
                    raise RuntimeError(f"image {img.src} in {label}: {exc}; "
                                       "nothing published") from None
        raw = _spliced(raw, filled)
    return raw, images


def media_cap() -> int:
    """The config's [media] max_image_bytes, else the default."""
    try:
        return media.max_bytes(config_section("media"))
    except ValueError as exc:
        raise ConfigError(f"config {config_path()}: {exc}") from None


def cmd_publish(args: argparse.Namespace) -> int:
    """Render a page from its source, keep the source, rebuild the manifest
    and the index, and commit and push once.

    When the config names a host and --local is not given, publish runs
    there over ssh instead (see publish_over_ssh).

    Publish has two sides, run here in one process or split by ssh: the
    sending side (send_images) reads each image the source names from
    beside it, checks it and rewrites its reference to its media URL; the
    writing side (resolve_images) finds every media URL's image among those
    sent or in the store. Under the lock each sent image is stored in the
    media directory, and the rewritten source is kept, so a republish of
    the kept source needs no local files. With --source-archive, standard
    input is a source archive (see read_source_archive) whose images are
    checked again here.

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
    if args.owner:
        check_owner(args, out_dir)
    if args.source_archive and args.source != "-":
        raise RuntimeError("--source-archive reads standard input: pass - as SOURCE")
    store_dir = media.media_dir(out_dir)
    try:
        sent: dict[str, media.Image] = {}
        if args.source_archive:
            data, sent = read_source_archive(sys.stdin.buffer, media_cap())
        else:
            data = read_source(args, label)
        raw, found = send_images(fmt, decoded(data, label), label, source_base(args),
                                 media_cap, partial(stored_image, store_dir=store_dir, sent=sent))
    except ConfigError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return EXIT_CONFIG
    raw, images = resolve_images(fmt, raw, label, store_dir, {**sent, **found})
    # The kept source names each image by its media URL, as the page does.
    data = raw.encode("utf-8")
    text = normalized(raw)
    if fmt == "markdown":
        sizes = {image.url: (image.width, image.height) for image in images.values()}
        title, body = markdown_title(text), markdown.to_body(text, sizes)
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

        for image in images.values():
            media.store(store_dir, image)

        # A republish keeps what the page already says unless told otherwise.
        page = out_dir / f"{name}.html"
        previous = page.read_text(encoding="utf-8") if page.exists() else ""
        kept = extract_meta(previous, name) if previous else {}
        summary = args.summary if args.summary is not None else kept.get("summary", "")
        variant = args.variant or (page_variant(previous) if previous else PUBLISH_VARIANT)
        owner = args.owner or page_owner(previous)
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
                comments=args.comments,
                # Checked above, or kept from the page when it is a handle.
                owner=owner if machine.is_handle(owner) else "",
                owner_checked=True,
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
_SERVE_SUPPORT_FILES = (_SERVE_CSS_FILE, _SERVE_ICON_FILE, PAGE_SCRIPT)
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


def api_page(out_dir: Path, name: str) -> api.Page | None:
    """The page serve answers as NAME.html, as /api records it; None when
    serve would not answer it."""
    # The allow-list holds bare file names only, so no name reaches past it.
    file = f"{name}.html"
    if not is_page_name(file) or file not in serve_allow_list(out_dir):
        return None
    try:
        page_html = (out_dir / file).read_text(encoding="utf-8")
        revision = page_revision(out_dir, name)
    except (OSError, UnicodeDecodeError):
        return None
    parser = _H2Collector(page_html)
    parser.feed(page_html)
    parser.close()
    sections: dict[str, str] = {}
    for heading in parser.headings:
        if heading["id"]:
            sections.setdefault(heading["id"], heading["text"])
    questions = {
        key: api.Question(version=form.version, choices=frozenset(v for v, _ in form.options),
                          text=form.text, labels=dict(form.options))
        for key, form in decisions.read_forms(page_html).items()
    }
    owner = page_owner(page_html)
    return api.Page(name=name, revision=revision, sections=sections, questions=questions,
                    comment_sections=frozenset(comments.read_boxes(page_html)),
                    owner=owner if machine.is_handle(owner) else "",
                    title=extract_meta(page_html, name)["title"])


def agent_page(out_dir: Path, page: api.Page) -> dict:
    """The page as an agent's pull shows it, with its kept source (NAME.md
    or NAME.body.html). A page published before sources were kept has none:
    an empty source, and the revision of the page as rendered.

    With a source, the revision is that of the very bytes given, which is
    the page's lotuspod:revision once a publish has finished. publish writes
    the page before its source, and this reads without its lock, so a
    revision read apart from the source could be newer than the source
    given; an agent expecting it would then overwrite that newer edit."""
    source_file, source, revision = "", "", page.revision
    for suffix in _KEPT_SOURCE_SUFFIX.values():
        kept = out_dir / f"{page.name}{suffix}"
        if kept.is_file() and not kept.is_symlink():
            data = kept.read_bytes()
            source_file = kept.name
            source = data.decode("utf-8", "replace")
            revision = source_revision(data)
            break
    if not source_file and not revision:
        revision = source_revision((out_dir / f"{page.name}.html").read_bytes())
    return {"name": page.name, "title": page.title, "owner": page.owner,
            "revision": revision, "sourceFile": source_file, "source": source}


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

# Headers on every /media answer. A stored name never changes its bytes, so
# the browser keeps it for a year; private keeps shared caches (Cloudflare's
# included) from holding it outside the Access gate.
_MEDIA_HEADERS = (
    ("X-Content-Type-Options", "nosniff"),
    ("Cache-Control", "private, max-age=31536000, immutable"),
)
_MEDIA_PATH = re.compile(re.escape(media.URL_PREFIX) + f"({media.STORED_NAME.pattern})")


class _AllowListHandler(SimpleHTTPRequestHandler):
    """Serve v2: answer only allow-listed names; everything else is a 404.

    /api paths never reach the file system or method dispatch: whatever the
    method, each is answered only after the request's Access assertion
    verifies (see parse_request and _serve_api). The answers and comments
    routes are lotuspod.api's.
    """

    # Whether the response being written is a page's, and the type of the
    # stored image it is ("" when none; see end_headers and guess_type).
    _page_response = False
    _media_type = ""

    def __init__(self, *args, root: Path, verifier: access.Verifier | None = None,
                 api: api.Api | None = None, **kwargs):
        self.root = Path(root)
        self.verifier = verifier
        self.api = api
        super().__init__(*args, **kwargs)

    def _api_path(self) -> str | None:
        path = self.path.split("?", 1)[0].split("#", 1)[0]
        return path if path == "/api" or path.startswith("/api/") else None

    def _api_answer(self, status: int, payload: dict, headers: tuple = ()) -> None:
        body = json.dumps(payload).encode("utf-8")
        self._page_response = False
        self._media_type = ""
        self.send_response(status)
        for header, value in (*_API_HEADERS, *headers):
            self.send_header(header, value)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _serve_api(self, path: str, body: api.Body) -> None:
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
        actor = {"kind": "human", "email": email}
        if self.api is not None and path in api.ROUTES:
            query = self.path.split("#", 1)[0].partition("?")[2]
            self._api_answer(*self.api.answer(self.command, path, query, self.headers, body, actor))
        elif path != "/api/whoami":
            self._api_answer(HTTPStatus.NOT_FOUND, {"error": "not_found"})
        elif self.command not in _API_READ_METHODS:
            self._api_answer(
                HTTPStatus.METHOD_NOT_ALLOWED, {"error": "method_not_allowed"},
                (("Allow", ", ".join(_API_READ_METHODS)),),
            )
        else:
            self._api_answer(HTTPStatus.OK, {"actor": actor})

    def parse_request(self) -> bool:
        # /api is answered here, before handle_one_request dispatches on the
        # method, so every method (OPTIONS, TRACE, any other word) meets the
        # guard. False tells handle_one_request the request is done.
        if not super().parse_request():
            return False
        path = self._api_path()
        if path is None:
            return True
        body = api.Body(self.rfile, self.connection, self.headers)
        self._serve_api(path, body)
        self.wfile.flush()
        # Only once the answer is out: a body left unread would reset it.
        body.discard()
        return False

    def translate_path(self, path: str) -> str:
        deny = str(self.root / _DENY_PATH_NAME)
        # A request that climbs, or names a dotfile, is refused as written -
        # before normalisation could fold it back inside the directory.
        words = urllib.parse.unquote(path.split("?", 1)[0].split("#", 1)[0])
        # A stored image, named exactly as stored, and nothing else there.
        if words == media.URL_PREFIX.rstrip("/") or words.startswith(media.URL_PREFIX):
            match = _MEDIA_PATH.fullmatch(words)
            stored = match and media.stored_file(media.media_dir(self.root), match.group(1))
            return str(stored) if stored else deny
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
        stored = Path(target)
        if stored.parent == media.media_dir(self.root):
            self._page_response = False
            self._media_type = media.CONTENT_TYPES[stored.suffix[1:]]
        else:
            self._page_response, self._media_type = target.endswith(".html"), ""
        return super().send_head()

    def send_error(self, *args, **kwargs):
        # An error is never kept as a stored image is.
        self._media_type = ""
        super().send_error(*args, **kwargs)

    def guess_type(self, path):
        # A fixed map: mimetypes does not know .webp on every Python.
        return self._media_type or super().guess_type(path)

    def end_headers(self):
        if self._page_response:
            for header, value in _PAGE_HEADERS:
                self.send_header(header, value)
        if self._media_type:
            for header, value in _MEDIA_HEADERS:
                self.send_header(header, value)
        super().end_headers()

    def list_directory(self, path: str):
        self.send_error(HTTPStatus.NOT_FOUND, "File not found")
        return None


def resolve_serve_host(host_override: str) -> str:
    """Explicit --host wins; otherwise auto-detect the tailnet IPv4."""
    return host_override if host_override else tailnet_ipv4()


def serve_db_path(out_dir: Path, db_arg: str) -> Path:
    """The database serve keeps: --db, else lotuspod.sqlite3 beside the
    output directory. ValueError when it would sit inside the output
    directory, which the artifacts repository commits whole."""
    out_dir = out_dir.resolve()
    path = Path(db_arg).resolve() if db_arg else out_dir.parent / db.DEFAULT_NAME
    if path == out_dir or out_dir in path.parents:
        raise ValueError(
            f"--db {db_arg or path} is inside the output directory {out_dir}; "
            "the artifacts repository would commit it"
        )
    return path


def serve_socket_path(db_path: Path, socket_arg: str) -> Path:
    """The agent socket serve listens on: --socket, else the config's
    [agents] socket, else lotuspod.sock beside the database."""
    if socket_arg:
        return Path(socket_arg)
    return configured_socket() or db_path.parent / machine.SOCKET_NAME


def _make_server(out_dir: Path, host: str, port: int,
                 verifier: access.Verifier | None = None,
                 db_path: Path | None = None,
                 window: int = routing.DEFAULT_WINDOW) -> ThreadingHTTPServer:
    """The allow-list server; /api answers 503 access_unconfigured without a
    verifier, and has no answers and comments routes without a database."""
    routes = None
    if db_path is not None:
        routes = api.Api(db.Database(db_path), partial(api_page, out_dir), window)
    handler = partial(
        _AllowListHandler, directory=str(out_dir), root=out_dir, verifier=verifier,
        api=routes,
    )
    return ThreadingHTTPServer((host, port), handler)


def owner_window(arg: int | None) -> int:
    """Routing's owner window in seconds: --owner-window, else the config's
    [comments] owner_window_sec, else the default."""
    if arg is not None:
        value, label = str(arg), "--owner-window"
    else:
        value = (config_section("comments") or {}).get("owner_window_sec", "")
        label = f"config {config_path()} [comments] owner_window_sec"
        if not value:
            return routing.DEFAULT_WINDOW
    if not value.isdigit() or int(value) < 1:
        raise ConfigError(f"{label} {value!r} is not a whole number of seconds, 1 or more")
    return int(value)


def claim_seconds() -> int:
    """How long an agent's claim lasts, in seconds: the config's [comments]
    claim_sec, else the default."""
    value = (config_section("comments") or {}).get("claim_sec", "")
    if not value:
        return routing.DEFAULT_CLAIM
    if not value.isdigit() or int(value) < 1:
        raise ConfigError(f"config {config_path()} [comments] claim_sec {value!r} is not "
                          "a whole number of seconds, 1 or more")
    return int(value)


def cmd_serve(args: argparse.Namespace) -> int:
    out_dir = Path(args.out_dir) if args.out_dir else DEFAULT_OUTPUT_DIR
    if not out_dir.is_dir():
        raise FileNotFoundError(f"artifacts directory not found: {out_dir}")
    # A deploy restarts serve, so a theme change goes live without waiting
    # for the next publish; that publish commits the rewritten files.
    sync_theme_css(out_dir)

    try:
        db_path = serve_db_path(out_dir, args.db)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    socket_path = serve_socket_path(db_path, args.socket)
    window = owner_window(args.owner_window)
    claim_sec = claim_seconds()
    host = resolve_serve_host(args.host)
    verifier = access_verifier()

    try:
        server = _make_server(out_dir, host, args.port, verifier=verifier, db_path=db_path,
                              window=window)
    except OSError as exc:
        print(f"error: cannot bind {host}:{args.port}: {exc}", file=sys.stderr)
        return 1
    try:
        sockets = machine.SocketServer(
            socket_path, db.Database(db_path), pages=partial(api_page, out_dir),
            describe=partial(agent_page, out_dir), window=window, claim_sec=claim_sec,
        )
    except (OSError, machine.SocketInUse) as exc:
        server.server_close()
        print(f"error: cannot listen on {socket_path}: {exc}", file=sys.stderr)
        return 1

    if not (out_dir / INDEX_FILE).exists():
        print(f"note: no {INDEX_FILE} yet; run `lotuspod index` to build one")
    if args.host:
        print(f"serving {out_dir} on {args.host} (v2 allow-list):")
    else:
        print(f"serving {out_dir} on the tailnet (v2 allow-list):")
    print(f"  http://{host}:{args.port}/")
    print(f"answers and comments in {db_path}")
    print(f"agents on {socket_path}")
    if verifier is None:
        print("note: no [access] section in the config; /api answers 503")
    if not args.host:
        dns_name = _tailnet_dns_name()
        if dns_name:
            print(f"  http://{dns_name}:{args.port}/")
    print("ctrl-c to stop")
    # SIGTERM (systemd's stop) ends serve as ctrl-c does, so the socket is
    # removed either way. Only the main thread may set a handler.
    on_main = threading.current_thread() is threading.main_thread()
    if on_main:
        previous = signal.signal(signal.SIGTERM, _stop_serving)
    socket_thread = threading.Thread(target=sockets.serve_forever, daemon=True)
    socket_thread.start()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        if on_main:
            # A second SIGTERM must not cut the cleanup short.
            signal.signal(signal.SIGTERM, signal.SIG_IGN)
        sockets.shutdown()
        socket_thread.join()
        sockets.server_close()
        server.server_close()
        if on_main:
            signal.signal(signal.SIGTERM, previous)
    return 0


def _stop_serving(signum: int, frame: object) -> None:
    raise KeyboardInterrupt


def serve_database(args: argparse.Namespace) -> db.Database:
    """The database serve keeps for the same --out-dir and --db."""
    out_dir = Path(args.out_dir) if args.out_dir else DEFAULT_OUTPUT_DIR
    return db.Database(serve_db_path(out_dir, args.db))


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


def answers_text(name: str, questions: dict, forms: dict[str, decisions.Form]) -> str:
    """`lotuspod answers` without --json: each answered question, its
    current answer and, under it, the earlier ones, newest first."""
    if not questions:
        return f"no answers to {name}"

    def entry(row: dict, form: decisions.Form | None, indent: str) -> list[str]:
        label = form.label(row["choice"]) if form else row["choice"]
        head = f"{indent}{label} (answer {row['id']}"
        if row["supersedes"] is not None:
            head += f", replaces answer {row['supersedes']}"
        head += ")"
        if form is None or row["version"] != form.version:
            head += ", to an earlier wording"
        lines = [head, f"{indent}  by {row['actor'].get('email', '')} at {row['createdAt']}"]
        if row["note"]:
            lines.append(f"{indent}  note: {row['note']}")
        return lines

    lines = []
    for question, answered in questions.items():
        form = forms.get(question)
        lines.append(f"{question}: {form.text}" if form else question)
        lines += entry(answered["current"], form, "  ")
        if answered["earlier"]:
            lines.append("  earlier:")
            for row in answered["earlier"]:
                lines += entry(row, form, "    ")
    return "\n".join(lines)


def cmd_answers(args: argparse.Namespace) -> int:
    name = args.page
    if not _PAGE_NAME.fullmatch(name):
        print(f"error: not a page name: {name!r}", file=sys.stderr)
        return 1
    try:
        questions = serve_database(args).answers(name)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps({"page": name, "questions": questions}, indent=2))
        return 0
    out_dir = Path(args.out_dir) if args.out_dir else DEFAULT_OUTPUT_DIR
    page = out_dir / f"{name}.html"
    forms = decisions.read_forms(page.read_text(encoding="utf-8")) if page.is_file() else {}
    print(answers_text(name, questions, forms))
    return 0


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
        help=f"the credential --owner is checked against (default: ${machine.CREDENTIAL_ENV})",
    )
    parser.add_argument(
        "--db", default="", metavar="PATH",
        help=f"serve's database the credential is checked in (default: {db.DEFAULT_NAME} "
        "beside the artifacts directory)",
    )


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
    serve.add_argument(
        "--db",
        default="",
        metavar="PATH",
        help=f"database of answers and comments (default: {db.DEFAULT_NAME} beside "
        "the artifacts directory; never inside it)",
    )
    serve.add_argument(
        "--socket",
        default="",
        metavar="PATH",
        help="Unix socket agents reach serve on (default: the config's [agents] "
        f"socket, else {machine.SOCKET_NAME} beside the database)",
    )
    serve.add_argument(
        "--owner-window",
        type=int,
        default=None,
        metavar="SECONDS",
        help="how long a pull keeps a handle listening, and a listening page owner "
        "holds a comment before the responder gets it (default: the config's "
        f"[comments] owner_window_sec, else {routing.DEFAULT_WINDOW})",
    )
    serve.set_defaults(func=cmd_serve)

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

    answers = sub.add_parser(
        "answers", help="show the answers given to a page's decisions, with their history"
    )
    answers.add_argument("page", metavar="PAGE", help="the page's name")
    answers.add_argument("--json", action="store_true", help="print JSON, as GET /api/answers")
    database_options(answers)
    answers.set_defaults(func=cmd_answers)

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
    responder.add_parser(sub)
    backup.add_parser(sub)

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
