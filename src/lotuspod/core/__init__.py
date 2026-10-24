"""What the rest of Lotuspod shares, borrowed from no other part of it.

The config and its sections, atomic writes and the publish lock, git in the
output directory, which files are pages and what their meta tags say, the
text helpers (slugs, digests, titles, scripts and live block templates), the
theme join and the page template. Its scripts are in core/ts/, its
stylesheet, tokens and icon in core/theme/ and its page template in
core/templates/.

core imports nothing else in Lotuspod (tests/test_import_graph.py), so any
module may import it.
"""

from __future__ import annotations

import base64
import configparser
import datetime as _dt
import fcntl
import hashlib
import html
import importlib.resources as _res
import json
import os
import re
import subprocess
import sys
from contextlib import contextmanager
from html.parser import HTMLParser
from pathlib import Path


DEFAULT_OUTPUT_DIR = Path.cwd() / "artifacts"


EXIT_REVISION_CONFLICT = 3
EXIT_CONFIG = 2
CONFIG_ENV = "LOTUSPOD_CONFIG"
DEFAULT_REMOTE_COMMAND = "lotuspod"


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


@contextmanager
def publish_lock(out_dir: Path, *, blocking: bool = True):
    """Hold the output directory's publish lock for the block.

    The lock file sits beside the directory, never inside it, so it is
    never a file of the site and never reaches the artifacts repository.
    With blocking=False, raise BlockingIOError if a publisher holds it.
    """
    lock_path = out_dir.parent / f".{out_dir.name}.publish.lock"
    with open(lock_path, "a") as fh:
        fcntl.flock(fh.fileno(), fcntl.LOCK_EX | (0 if blocking else fcntl.LOCK_NB))
        yield


def git_environment() -> dict[str, str]:
    """The environment every git process runs in: never asking for a password."""
    return {**os.environ, "GIT_TERMINAL_PROMPT": "0"}


def _git(out_dir: Path, *argv: str) -> subprocess.CompletedProcess:
    return subprocess.run(
        ["git", "-C", str(out_dir), *argv],
        capture_output=True,
        text=True,
        env=git_environment(),
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
    if not is_repository_top(out_dir):
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


def is_repository_top(out_dir: Path) -> bool:
    """Whether out_dir is the top of its own git repository."""
    try:
        top = _git(out_dir, "rev-parse", "--show-toplevel")
    except OSError:
        return False
    if top.returncode != 0 or not top.stdout.strip():
        return False
    return Path(top.stdout.strip()).resolve() == Path(out_dir).resolve()


# A live block's widget file, served beside its page.
WIDGET_NAME = re.compile(r'.+\.w-[0-9a-f]{12}\.html\Z')
# Where serve answers the media store's images (lotuspod.features.publish.media).
URL_PREFIX = "/media/"
INDEX_FILE = "index.html"
MANIFEST_FILE = "manifest.json"


_EPISODE_KICKER = re.compile(r"^Lotuspod · Episode (.+)$")
_TITLE_RE = re.compile(r'<h1 class="artifact-title">(.*?)</h1>', re.DOTALL)
_KICKER_RE = re.compile(r'<p class="artifact-kicker">(.*?)</p>', re.DOTALL)
_DATE_RE = re.compile(r'<time datetime="([^"]*)">')
_SUMMARY_RE = re.compile(r'<p class="artifact-summary">(.*?)</p>', re.DOTALL)
_VISIBLE_TAG_RE = re.compile(
    r"<meta\s[^>]*name=[\"']lotuspod:visible[\"'][^>]*>", re.IGNORECASE
)
_META_CONTENT_RE = re.compile(r"content=[\"']([^\"']*)[\"']", re.IGNORECASE)
_UPDATED_TAG_RE = re.compile(
    r"<meta\s[^>]*name=[\"']lotuspod:updated[\"'][^>]*>", re.IGNORECASE
)
_LABELS_TAG_RE = re.compile(
    r"<meta\s[^>]*name=[\"']lotuspod:labels[\"'][^>]*>", re.IGNORECASE
)


def extract_visibility(page_html: str) -> bool:
    """Fail closed: visible only when the flag is present and exactly 'true'."""
    tag = _VISIBLE_TAG_RE.search(page_html)
    if not tag:
        return False
    content = _META_CONTENT_RE.search(tag.group(0))
    return content is not None and content.group(1).strip().lower() == "true"


def extract_labels(page_html: str) -> list[str]:
    """The names a page's lotuspod:labels meta tag lists, in its order
    ([] when it has none)."""
    tag = _LABELS_TAG_RE.search(page_html)
    content = _META_CONTENT_RE.search(tag.group(0)) if tag else None
    if not content:
        return []
    return [label for label in (part.strip() for part in content.group(1).split(",")) if label]


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
    # A page published before publish stamped it has no updated time: "" here,
    # which collect_artifacts fills in.
    updated_tag = _UPDATED_TAG_RE.search(page_html)
    updated = _META_CONTENT_RE.search(updated_tag.group(0)) if updated_tag else None
    created = date.group(1) if date else ""
    return {
        "file": f"{stem}.html",
        "title": html.unescape(title.group(1)) if title else stem,
        "episode": episode,
        "date": created,
        "created": created,
        "updated": updated.group(1).strip() if updated else "",
        "summary": html.unescape(summary.group(1)) if summary else "",
        "visible": extract_visibility(page_html),
        "labels": extract_labels(page_html),
        # The page's archive record, beside it; collect_artifacts fills them.
        "archived": "",
        "supersededBy": "",
    }


# A page's kept HTML source, NAME.body.html, sits beside NAME.html as NAME.md
# does for a markdown page: a source, never a page.
BODY_SOURCE_SUFFIX = ".body.html"


def is_page_name(name: str) -> bool:
    """Whether a *.html name in the output directory is an artifact page."""
    return (
        name != INDEX_FILE
        and not WIDGET_NAME.fullmatch(name)
        and not name.startswith(".")
        and not name.endswith(BODY_SOURCE_SUFFIX)
    )


def _utc_stamp(moment: _dt.datetime) -> str:
    return moment.astimezone(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# Where each kind of source is kept beside its page, byte for byte as read.
_KEPT_SOURCE_SUFFIX = {"markdown": ".md", "html": BODY_SOURCE_SUFFIX}


REVISION_LENGTH = 12
NO_REVISION = "none"


_REVISION_TAG_RE = re.compile(
    r"<meta\s[^>]*name=[\"']lotuspod:revision[\"'][^>]*>", re.IGNORECASE
)


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


def unit_digest(*parts: str) -> str:
    """A content stamp with length framing to distinguish part boundaries."""
    digest = hashlib.sha256()
    for part in parts:
        data = part.encode("utf-8")
        digest.update(len(data).to_bytes(8, "big"))
        digest.update(data)
    return digest.hexdigest()[:16]


_SLUG_STRIP = re.compile(r"[^a-z0-9]+")
_SLUG_FALLBACK = "section"


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
    """Locate the body's first h1: source span and text (see render._H2Collector)."""

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
    parser.feed(without_templates(body))
    parser.close()
    if parser.start is None or parser.end is None:
        return "", body
    title = " ".join("".join(parser.text).split())
    # Widget diagnostics use source lines even when the title spans lines.
    gap = ("\n" * body[parser.start:parser.end].count("\n")
           if Templates(body).blocks else "")
    return title, body[:parser.start] + gap + body[parser.end:]


def normalized(raw: str) -> str:
    """raw with every line ending a newline."""
    return raw.replace("\r\n", "\n").replace("\r", "\n")


class Templates(HTMLParser):
    # Widgets enable scripts, so noscript contents are raw text. Extending the
    # raw-text tags also supports Python versions without scripting=True.
    CDATA_CONTENT_ELEMENTS = (*HTMLParser.CDATA_CONTENT_ELEMENTS, 'noscript')

    def __init__(self, text: str):
        super().__init__(convert_charrefs=False)
        self.text = text
        self.offsets = [0, *(match.end() for match in re.finditer('\n', text))]
        self.blocks = []
        self.active = None
        self.depth = 0
        self.feed(text)
        if self.active:
            raise RuntimeError(f'widget at line {self.active[3]}: unclosed template')

    def position(self):
        line, col = self.getpos()
        return self.offsets[line - 1] + col

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == 'template':
            if self.active:
                self.depth += 1
            elif 'lotuspod-live' in (attrs.get('class') or '').split():
                start = self.position()
                self.active = (start, start + len(self.get_starttag_text()), attrs, self.getpos()[0])
                self.depth = 1

    def handle_endtag(self, tag):
        if tag == 'template' and self.active:
            self.depth -= 1
            if not self.depth:
                start, content, attrs, line = self.active
                end = self.text.index('>', self.position()) + 1
                self.blocks.append((start, end, attrs, self.text[content:self.position()], line))
                self.active = None


def without_templates(text: str) -> str:
    """Hide widget markup from source readers, preserving offsets and lines."""
    for start, end, _, _, _ in reversed(Templates(text).blocks):
        text = text[:start] + re.sub(r'[^\n]', ' ', text[start:end]) + text[end:]
    return text


_PKG = "lotuspod"


def package_path(*parts: str) -> Path:
    """Resolve packaged assets (templates/theme) for any install mode."""
    with _res.as_file(_res.files(_PKG).joinpath(*parts)) as p:
        return p


# The directory every theme source is named relative to: the package's own,
# whose core/theme/ and core/ts/ hold the shared sources, each slice's
# features/SLICE/theme/ and features/SLICE/ts/ its own, and _theme/ the rest.
THEME_ROOT = package_path()
# The palette, relative to THEME_ROOT.
TOKENS_SOURCE = "core/theme/tokens.json"


def load_tokens() -> dict:
    tokens_path = THEME_ROOT / TOKENS_SOURCE
    with tokens_path.open(encoding="utf-8") as fh:
        return json.load(fh)


# The page script answers decision forms (lotuspod.features.decisions), shows and
# posts comments (lotuspod.features.comments) and folds sections
# (lotuspod.features.publish.sections), and offers a reload once its page is
# published again. Every listed page loads it: loaded on its own at the top
# level, a listed page first goes to the index, opened there in a tab
# (features/publish/ts/open-in-tabs.js), and runs none of the rest. A page not
# listed loads it only with any of those, a revision or a link.
PAGE_SCRIPT = "lotuspod-page.js"
# The index script opens pods in tabs over the index's listing; the index
# loads it deferred, beside its own inline script.
INDEX_SCRIPT = "lotuspod-index.js"
# The old-version script draws the version menu in an earlier version's
# banner (lotuspod.features.history.versions.old_page); serve allows it there, and only it, by
# a nonce of its own answer (_OLD_VERSION_HEADERS). It draws nothing else: no
# comment, no answer, and nothing posted.
OLD_VERSION_SCRIPT = "lotuspod-old-version.js"
THEME_FILES = ("lotuspod.css", "favicon.svg", PAGE_SCRIPT, INDEX_SCRIPT, OLD_VERSION_SCRIPT)
# The served files written as one source per feature are joined from parts,
# each declared in THEME_PARTS at the root of core/ or of a slice
# (features/SLICE/), from its own ts/ and theme/: a JSON list of
# {"file": SERVED, "part": PATH, "slot": N}, PATH relative to that folder, and
# an optional "why" saying why the part sits at its slot. Each served file is
# its parts joined in slot order, byte for byte (theme_sources), so a new
# feature's part is a line in its own folder's declaration; slots leave gaps
# for one. A theme file no part names is served as it is, from
# THEME_FILE_SOURCES.
THEME_PARTS = "theme_parts.json"
# The served scripts that run as one strict function, so their sources share
# its helpers and objects (features/publish/ts/page-open.js, core/ts/shared.js) while each source
# stays a complete script: the join puts THEME_CLOSURE_OPEN before the source
# at the index named here and THEME_CLOSURE_CLOSE after the last.
#
# The page script's first source, features/publish/ts/open-in-tabs.js, evaluates to a function
# that is handed the closure and runs it only when the page stays, so the
# opening follows it with nothing between. The close ends the closure and
# calls the result.
THEME_CLOSURES = {
    PAGE_SCRIPT: 1,
    OLD_VERSION_SCRIPT: 0,
}
THEME_CLOSURE_OPEN = b'(function () {\n  "use strict";\n'
THEME_CLOSURE_CLOSE = b"})();\n"
# Each served theme file not joined from sources, relative to THEME_ROOT; a
# name no part joins and not in this table is read from _theme/.
THEME_FILE_SOURCES = {
    "favicon.svg": "core/theme/favicon.svg",
}


def theme_sources() -> dict[str, tuple[str, ...]]:
    """Each joined served file's sources, relative to THEME_ROOT, in slot
    order: the parts core's THEME_PARTS declares, then each slice's, by
    folder name. Two parts of one served file at one slot are refused.
    THEME_ROOT is read at call time, never at import."""
    folders = [THEME_ROOT / "core",
               *sorted(path for path in (THEME_ROOT / "features").glob("*") if path.is_dir())]
    slotted: dict[str, dict[int, str]] = {}
    for folder in folders:
        declared = folder / THEME_PARTS
        if not declared.is_file():
            continue
        prefix = folder.relative_to(THEME_ROOT).as_posix()
        for part in json.loads(declared.read_text(encoding="utf-8")):
            source, slots = f"{prefix}/{part['part']}", slotted.setdefault(part["file"], {})
            if part["slot"] in slots:
                raise ValueError(f"{declared}: {source} takes slot {part['slot']} of "
                                 f"{part['file']}, which {slots[part['slot']]} holds")
            slots[part["slot"]] = source
    return {filename: tuple(slots[slot] for slot in sorted(slots))
            for filename, slots in slotted.items()}


def theme_files() -> list[tuple[str, bytes]]:
    """Each served theme file (THEME_FILES, in order) with the bytes serve answers.

    The one source for those bytes: sync_theme_css writes them and theme_hash
    names them, so the ?v= address always follows what serve answers.
    THEME_ROOT is read at call time, never at import.
    """
    sources = theme_sources()
    return [(filename, theme_file_bytes(filename, sources)) for filename in THEME_FILES]


def theme_file_bytes(filename: str, declared: dict[str, tuple[str, ...]] | None = None) -> bytes:
    """The bytes of one served theme file: its sources (theme_sources, or
    declared) joined in slot order, the closure (THEME_CLOSURES) around those
    it wraps, or the file itself (THEME_FILE_SOURCES) when it has none."""
    sources = (theme_sources() if declared is None else declared).get(filename)
    if sources is None:
        return (THEME_ROOT / THEME_FILE_SOURCES.get(filename, f"_theme/{filename}")).read_bytes()
    parts = [(THEME_ROOT / source).read_bytes() for source in sources]
    start = THEME_CLOSURES.get(filename)
    if start is not None:
        parts = [*parts[:start], THEME_CLOSURE_OPEN, *parts[start:], THEME_CLOSURE_CLOSE]
    return b"".join(parts)


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

    Covers the served theme files (THEME_FILES).
    Rewriting only on a content difference means a theme upgrade reaches
    already-rendered directories while untouched ones keep their mtime.
    """
    for filename, data in theme_files():
        theme_copy = out_dir / filename
        if not theme_copy.exists() or theme_copy.read_bytes() != data:
            write_atomic(theme_copy, data)


TEMPLATE_PATH = package_path("core", "templates", "artifact.html")
_PLACEHOLDER = re.compile(r"\{\{\s*([a-zA-Z_][a-zA-Z0-9_]*)\s*\}\}")
_SECTION = re.compile(
    r"\{\{#([a-zA-Z_][a-zA-Z0-9_]*)\}\}(.*?)\{\{/([a-zA-Z_][a-zA-Z0-9_]*)\}\}", re.DOTALL
)


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
