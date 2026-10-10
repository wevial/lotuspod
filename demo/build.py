"""Build the demo site: Lotuspod's README and docs pages, published as Lotuspod pages.

    python -m demo.build [--out DIR]
    python -m demo.build --serve [--port PORT]
    python -m demo.build --serve [--port PORT] -- CMD [ARG...]

Each source in SOURCES is copied into a scratch directory with its markdown
links to another source rewritten to that source's page (`PAGE.html`,
keeping any `#anchor`), and links to any other file of the repository
rewritten to that file on GitHub; a relative link to no file fails the
build. Each copy is then published with the real `lotuspod publish --local`,
run from src/ with no operator config, so nothing can send it elsewhere.

The published directory then becomes a static site in DIR: Lotuspod's page
list moves to pages.html (and each page's topbar brand link with it), `/`
redirects to the README's page, every page gets the demo banner and its
stylesheet, and the static host's `_headers` and `_redirects` are written.
Media is copied to DIR/media/, where the pages name it.

Every page also loads the demo shim (demo/shim.js, with demo/replies.json
put in it) as lotuspod-demo.js, from its head, so before the page script: it
answers the page script's /api requests from the visitor's browser, as no
static host can.

`--serve` builds into a scratch directory and serves it on 127.0.0.1 until
ctrl-c or SIGTERM, answering `/` with the README's page. With `-- CMD`, it
runs CMD instead, with the site's URL in LOTUSPOD_URL and the file the
server logs each request to (`METHOD PATH`, one a line) in
LOTUSPOD_DEMO_LOG, then stops and exits with CMD's code.
"""

from __future__ import annotations

import argparse
import html
import json
import os
import posixpath
import re
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
from functools import partial
from http import HTTPStatus
from html.parser import HTMLParser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = REPO_ROOT / "demo" / "dist"
STYLESHEET = Path(__file__).resolve().parent / "demo.css"
SHIM = Path(__file__).resolve().parent / "shim.js"
REPLIES = Path(__file__).resolve().parent / "replies.json"
# Where shim.js holds demo/replies.json, which the build puts there.
REPLIES_SLOT = "{/* demo/replies.json, put here by the build */}"

# Each source, relative to the repository, and its page name, in build order.
SOURCES = (
    ("README.md", "readme"),
    ("docs/publishing.md", "publishing"),
    ("docs/comments.md", "comments"),
    ("docs/agents.md", "agents"),
    ("docs/operating.md", "operating"),
    ("docs/development.md", "development"),
    ("docs/architecture.md", "architecture"),
    ("demo/pages/try-it.md", "try-it"),
)
SUMMARIES = {
    "readme": "What Lotuspod is, how it is laid out, and a quick start.",
    "publishing": "Publishing pages from markdown or HTML, with images and decision forms.",
    "comments": "Comments, threads on a passage, and answers to a page's decisions.",
    "agents": "Agents that read comments and reply, and the default responder.",
    "operating": "Running serve behind Cloudflare Access, with backups.",
    "development": "Tests, captures and how a change is checked.",
    "architecture": "How serve, the socket, SQLite, Access, the responder and publish fit.",
    "try-it": "A made-up plan to comment on, quote from and decide on.",
}
LANDING_PAGE = "readme"
TRY_IT_PAGE = "try-it"
PAGES_FILE = "pages.html"
INDEX_FILE = "index.html"
DEMO_CSS = "lotuspod-demo.css"
DEMO_JS = "lotuspod-demo.js"
MEDIA_DIR = "media"
GITHUB_BLOB = "https://github.com/wevial/lotuspod/blob/main/"
# Files publish keeps beside the pages that the site does not show.
NOT_SHOWN = frozenset({"manifest.json"})

BANNER_TEXT = (
    "Demo: what you write stays in this browser. Replies are scripted; no AI model runs."
)
HEADERS = """\
/*
  Content-Security-Policy: frame-ancestors 'self'
  X-Content-Type-Options: nosniff
  Referrer-Policy: no-referrer
"""
REDIRECTS = f"""\
/ /{LANDING_PAGE}.html 302
/{INDEX_FILE} /{LANDING_PAGE}.html 302
"""
URL_ENV = "LOTUSPOD_URL"
LOG_ENV = "LOTUSPOD_DEMO_LOG"

BRAND_LINK = '<a class="artifact-topbar-brand" href="index.html">'
FENCE = re.compile(r"^\s*(`{3,}|~{3,})")
# A code span or an image, passed over whole, or a `[TEXT](TARGET)` link.
LINK = re.compile(
    r"(?P<tick>`+)[^\n]*?[^`\n](?P=tick)(?!`)|!\[[^\]]*\]\([^\s()]+\)"
    r"|(?P<text>\[(?:`[^`\n]+`|[^\]`])+?\]\()(?P<target>[^\s()]+)\)"
)
SCHEME = re.compile(r"^[a-z][a-z0-9+.-]*:", re.IGNORECASE)
HEADING_TAGS = ("h3", "h4", "h5", "h6")


class BuildError(Exception):
    pass


def split_fences(text: str) -> list[tuple[bool, str]]:
    """The text in runs, each (True, prose) or (False, a fenced block), in order."""
    runs: list[tuple[bool, str]] = []
    fence = ""
    for line in text.splitlines(keepends=True):
        prose = not fence
        if fence:
            stripped = line.strip()
            if stripped.startswith(fence) and stripped.strip(fence[0]) == "":
                fence = ""
        else:
            match = FENCE.match(line)
            if match:
                fence = match.group(1)
                prose = False
        if runs and runs[-1][0] == prose:
            runs[-1] = (prose, runs[-1][1] + line)
        else:
            runs.append((prose, line))
    return runs


def link_target(target: str, source: str, root: Path, pages: dict[str, str]) -> str:
    """Where a link in source (a path relative to root) points on the site."""
    if SCHEME.match(target) or target.startswith(("#", "//")):
        return target
    path, hash_, anchor = target.partition("#")
    joined = path.lstrip("/") if path.startswith("/") else \
        posixpath.join(posixpath.dirname(source), path)
    name = posixpath.normpath(joined)
    if name in pages:
        return f"{pages[name]}.html{hash_}{anchor}"
    if name != ".." and not name.startswith("../") and (root / name).exists():
        return f"{GITHUB_BLOB}{name}{hash_}{anchor}"
    raise BuildError(f"{source} links {target}: no such file in the repository")


def rewrite_links(text: str, source: str, root: Path, pages: dict[str, str]) -> str:
    """text with each link outside code pointed where link_target says."""
    def sub(match: re.Match) -> str:
        if match.group("text") is None:  # a code span or an image
            return match.group(0)
        return f"{match.group('text')}{link_target(match.group('target'), source, root, pages)})"

    return "".join(LINK.sub(sub, run) if prose else run for prose, run in split_fences(text))


def short_commit(root: Path) -> str:
    done = subprocess.run(["git", "-C", str(root), "rev-parse", "--short", "HEAD"],
                          capture_output=True, text=True)
    if done.returncode != 0 or not done.stdout.strip():
        raise BuildError(f"cannot read the commit of {root}: {done.stderr.strip()}")
    return done.stdout.strip()


def publish(copy: Path, base: Path, page: str, site: Path, scratch: Path) -> None:
    """Publish copy as page into site with the real CLI, from src/, with no config."""
    home = scratch / "home"
    home.mkdir(exist_ok=True)
    env = {
        **os.environ,
        "PYTHONPATH": str(REPO_ROOT / "src"),
        "LOTUSPOD_CONFIG": str(scratch / "no-such-config.ini"),
        "XDG_CONFIG_HOME": str(home / ".config"),
        "HOME": str(home),
    }
    done = subprocess.run(
        [sys.executable, "-m", "lotuspod", "publish", str(copy), "--local",
         "--out-dir", str(site), "--name", page, "--summary", SUMMARIES.get(page, ""),
         "--base", str(base)],
        capture_output=True, text=True, env=env, cwd=scratch,
    )
    if done.returncode != 0:
        raise BuildError(f"lotuspod publish of {page} failed:\n{done.stderr.strip()}")


class _Headings(HTMLParser):
    """The ids a page holds, and each h3 to h6 with none: its start tag's
    offset and text, and the heading's text."""

    def __init__(self, page: str) -> None:
        super().__init__(convert_charrefs=True)
        self._line_starts = [0] + [m.end() for m in re.finditer("\n", page)]
        self.ids: set[str] = set()
        self.headings: list[dict] = []
        self._open: dict | None = None

    def handle_starttag(self, tag: str, attrs: list) -> None:
        values = dict(attrs)
        if values.get("id"):
            self.ids.add(values["id"])
        elif tag in HEADING_TAGS and self._open is None:
            line, column = self.getpos()
            self._open = {"tag": tag, "start": self._line_starts[line - 1] + column,
                          "source": self.get_starttag_text(), "text": ""}

    def handle_data(self, data: str) -> None:
        if self._open is not None:
            self._open["text"] += data

    def handle_endtag(self, tag: str) -> None:
        if self._open is not None and tag == self._open["tag"]:
            self.headings.append(self._open)
            self._open = None


def heading_ids(page: str) -> str:
    """page with an id on each h3 to h6 that has none, from its text as an
    h2's is, so a link to a subheading has somewhere to land."""
    parser = _Headings(page)
    parser.feed(page)
    parser.close()
    taken = set(parser.ids)
    pieces, cursor = [], 0
    for heading in parser.headings:
        base = re.sub(r"[^a-z0-9]+", "-", heading["text"].lower()).strip("-") or "section"
        found, suffix = base, 2
        while found in taken:
            found, suffix = f"{base}-{suffix}", suffix + 1
        taken.add(found)
        start = heading["start"]
        pieces += [page[cursor:start], f'<{heading["tag"]} id="{found}"']
        cursor = start + len(heading["tag"]) + 1
    return "".join(pieces) + page[cursor:]


def banner(commit: str) -> str:
    return (
        '<div class="demo-banner" role="note">'
        f'<p class="demo-banner-text">{html.escape(BANNER_TEXT)}</p>'
        f'<a class="demo-banner-try" href="{TRY_IT_PAGE}.html">Try it</a>'
        f'<span class="demo-banner-commit">built from <code>{html.escape(commit)}</code></span>'
        '<button type="button" class="demo-banner-reset">Reset demo</button>'
        "</div>"
    )


def dress(page: str, name: str, commit: str) -> str:
    """page as the demo shows it: its stylesheet linked, the shim loaded from
    its head, the banner first in its body, and its brand link (if any) on
    the page list."""
    def once(text: str, old: str, new: str) -> str:
        if text.count(old) != 1:
            raise BuildError(f"{name}: expected one {old!r}, found {text.count(old)}")
        return text.replace(old, new)

    page = once(page, "</head>", f'  <link rel="stylesheet" href="{DEMO_CSS}">\n'
                f'  <script src="{DEMO_JS}"></script>\n</head>')
    page = once(page, "<body>", f"<body>\n{banner(commit)}")
    if name != PAGES_FILE:
        page = once(page, BRAND_LINK, BRAND_LINK.replace(INDEX_FILE, PAGES_FILE))
    return page


def shim() -> str:
    """lotuspod-demo.js: shim.js with demo/replies.json in its slot."""
    try:
        replies = json.loads(REPLIES.read_text(encoding="utf-8"))
    except ValueError as exc:
        raise BuildError(f"{REPLIES.name} is not JSON: {exc}") from None
    if not isinstance(replies, dict) or not isinstance(replies.get("*"), str) or not all(
            isinstance(texts, dict) and all(isinstance(text, str) for text in texts.values())
            for page, texts in replies.items() if page != "*"):
        raise BuildError(f'{REPLIES.name}: expected "*" and each page\'s section texts')
    script = SHIM.read_text(encoding="utf-8")
    if script.count(REPLIES_SLOT) != 1:
        raise BuildError(f"{SHIM.name}: expected one {REPLIES_SLOT!r}")
    return script.replace(REPLIES_SLOT, json.dumps(replies, ensure_ascii=True, indent=2))


def prepare_out(out: Path) -> None:
    """An empty out, removing a previous build there; anything else is refused."""
    if out.exists():
        if not out.is_dir():
            raise BuildError(f"{out} is not a directory")
        if any(out.iterdir()) and not (out / "_redirects").is_file():
            raise BuildError(f"{out} is not empty and holds no demo build; nothing written")
        shutil.rmtree(out)
    out.mkdir(parents=True)


def build(out: Path, root: Path | None = None,
          sources: tuple[tuple[str, str], ...] | None = None) -> list[str]:
    """Build the site into out; the names of the pages it holds."""
    root = REPO_ROOT if root is None else root
    sources = SOURCES if sources is None else sources
    pages = dict(sources)
    script = shim()
    for source, _ in sources:
        if not (root / source).is_file():
            raise BuildError(f"{source}: no such source in the checkout")

    with tempfile.TemporaryDirectory(prefix="lotuspod-demo-") as tmp:
        scratch = Path(tmp)
        copies = []
        for source, page in sources:
            text = (root / source).read_text(encoding="utf-8")
            copy = scratch / "sources" / source
            copy.parent.mkdir(parents=True, exist_ok=True)
            copy.write_text(rewrite_links(text, source, root, pages), encoding="utf-8")
            copies.append((copy, (root / source).parent, page))
        commit = short_commit(root)

        site = scratch / "site"
        for copy, base, page in copies:
            publish(copy, base, page, site, scratch)

        prepare_out(out)
        shown = []
        for path in sorted(site.iterdir()):
            if path.name in NOT_SHOWN or path.suffix == ".md" or not path.is_file():
                continue
            if path.suffix != ".html":
                shutil.copy2(path, out / path.name)
                continue
            name = PAGES_FILE if path.name == INDEX_FILE else path.name
            page = dress(heading_ids(path.read_text(encoding="utf-8")), name, commit)
            (out / name).write_text(page, encoding="utf-8")
            shown.append(name)
        media = scratch / "lotuspod-media"
        if media.is_dir():
            shutil.copytree(media, out / MEDIA_DIR)

    shutil.copyfile(STYLESHEET, out / DEMO_CSS)
    (out / DEMO_JS).write_text(script, encoding="utf-8")
    (out / "_headers").write_text(HEADERS, encoding="utf-8")
    (out / "_redirects").write_text(REDIRECTS, encoding="utf-8")
    return shown


class _Handler(SimpleHTTPRequestHandler):
    """A static file server that answers / as the host's _redirects do.
    With a log, each request is written there as `METHOD PATH`, not to stderr."""

    def __init__(self, *args, log=None, **kwargs) -> None:
        self.log = log
        super().__init__(*args, **kwargs)

    def _landing(self) -> bool:
        """Answer / and /index.html with a 302 to the landing page, as the
        host does, so the page loads at its own path; whether it did."""
        if self.path.split("?")[0] not in ("/", f"/{INDEX_FILE}"):
            return False
        self.send_response(HTTPStatus.FOUND)
        self.send_header("Location", f"/{LANDING_PAGE}.html")
        self.send_header("Content-Length", "0")
        self.end_headers()
        return True

    def do_GET(self) -> None:
        if not self._landing():
            super().do_GET()

    def do_HEAD(self) -> None:
        if not self._landing():
            super().do_HEAD()

    def log_request(self, code="-", size="-") -> None:
        if self.log is None:
            super().log_request(code, size)
            return
        with self.log["lock"]:
            self.log["file"].write(f"{self.command} {self.path}\n")
            self.log["file"].flush()

    def log_message(self, format: str, *args) -> None:
        if self.log is None:
            super().log_message(format, *args)


def serve(port: int, command: list[str] | None = None) -> int:
    """Build into a scratch directory and serve it on 127.0.0.1 until stopped,
    or, given command, while command runs; command's exit code, else 0."""
    def stop(signum, frame):
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop)
    with tempfile.TemporaryDirectory(prefix="lotuspod-demo-site-") as tmp:
        out = Path(tmp) / "site"
        build(out)
        if command is None:
            server = ThreadingHTTPServer(("127.0.0.1", port),
                                         partial(_Handler, directory=str(out)))
            try:
                print(f"serving the demo at http://127.0.0.1:{server.server_address[1]}/ "
                      "(ctrl-c stops)", flush=True)
                server.serve_forever()
            except KeyboardInterrupt:
                pass
            finally:
                server.server_close()
            return 0

        log_path = Path(tmp) / "requests.log"
        with open(log_path, "w", encoding="utf-8") as log_file:
            log = {"file": log_file, "lock": threading.Lock()}
            server = ThreadingHTTPServer(("127.0.0.1", port),
                                         partial(_Handler, directory=str(out), log=log))
            worker = threading.Thread(target=server.serve_forever, daemon=True)
            worker.start()
            env = {**os.environ, URL_ENV: f"http://127.0.0.1:{server.server_address[1]}/",
                   LOG_ENV: str(log_path)}
            try:
                return subprocess.run(command, env=env, check=False).returncode
            except OSError as exc:
                raise BuildError(f"cannot run {command[0]}: {exc}") from None
            except KeyboardInterrupt:
                return 130
            finally:
                server.shutdown()
                server.server_close()


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m demo.build",
        description="Build the demo site from README.md, the docs pages and the Try it page.",
        epilog="With --serve, `-- CMD [ARG...]` runs CMD against the served site "
               f"({URL_ENV} names its URL, {LOG_ENV} its request log), then stops.",
    )
    parser.add_argument("--out", default=str(DEFAULT_OUT),
                        help="output directory (default: demo/dist)")
    parser.add_argument("--serve", action="store_true",
                        help="build into a scratch directory and serve it on 127.0.0.1")
    parser.add_argument("--port", type=int, default=0,
                        help="the port --serve listens on (default: a free one)")
    argv = sys.argv[1:] if argv is None else list(argv)
    # Everything after the first `--` is the command --serve runs.
    command = argv[argv.index("--") + 1:] if "--" in argv else None
    args = parser.parse_args(argv[:argv.index("--")] if command is not None else argv)
    if command is not None and (not args.serve or not command):
        parser.error("`-- CMD` takes --serve and a command")
    try:
        if args.serve:
            return serve(args.port, command)
        out = Path(args.out).resolve()
        shown = build(out)
    except BuildError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(f"built {len(shown)} pages in {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
