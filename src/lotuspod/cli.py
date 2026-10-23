"""Minimal CLI for rendering Lotuspod artifacts from the template + theme."""

from __future__ import annotations


import argparse
import io
import json
import queue
import re
import secrets
import select
import signal
import socket
import sys
import threading
import time
import urllib.parse
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Callable

from lotuspod import (access, agents, api, archive, backup, comments, decisions, machine,
                      media, responder, routing, serve_files, versions, widgets)
from lotuspod import events as event_streams
from lotuspod.agents import configured_socket
from lotuspod.core import (DEFAULT_OUTPUT_DIR, EXIT_REVISION_CONFLICT, INDEX_FILE,
                           _KEPT_SOURCE_SUFFIX, NO_REVISION, OLD_VERSION_SCRIPT, WIDGET_NAME,
                           ConfigError, config_path, config_section, extract_meta,
                           extract_visibility, is_page_name, page_revision, source_revision,
                           sync_theme_css, theme_hash)
from lotuspod.publish import _PAGE_NAME, LABEL_MAX, PUBLISH_FORMATS, PUBLISH_VARIANT, cmd_publish
from lotuspod.publish_sources import media_cap
from lotuspod.render import (_H2Collector, DEFAULT_VARIANT, VARIANTS, cmd_render,
                             kept_block_hashes, page_owner, version_stamp)
from lotuspod.serve_files import _SERVE_NEVER_FILES, serve_database, serve_db_path
from lotuspod.site_index import cmd_index, cmd_manifest
from lotuspod.store import db


DEFAULT_SERVE_PORT = 8000
DEFAULT_SERVE_HOST = "127.0.0.1"


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


_DENY_PATH_NAME = ".lotuspod-not-found"


def served_page_names(out_dir: Path, allowed: frozenset[str] | None = None) -> list[str]:
    """The names of the pages serve answers, archived ones left out, in order.
    allowed is serve_files.serve_allow_list(out_dir) when the caller has read it already."""
    if allowed is None:
        allowed = serve_files.serve_allow_list(out_dir)
    return sorted(file[:-len(".html")] for file in allowed
                  if file.endswith(".html") and is_page_name(file)
                  and not archive.is_archived(out_dir, file[:-len(".html")]))


def api_page(out_dir: Path, name: str,
             allowed: frozenset[str] | None = None) -> api.Page | None:
    """The page serve answers as NAME.html, as /api records it; None when
    serve would not answer it. allowed is serve_files.serve_allow_list(out_dir) when
    the caller has read it already."""
    if allowed is None:
        allowed = serve_files.serve_allow_list(out_dir)
    # The allow-list holds bare file names only, so no name reaches past it.
    file = f"{name}.html"
    if not is_page_name(file) or file not in allowed:
        return None
    try:
        # The allow-list may have been read before the page was replaced
        # by a link, which serve_allow_list never lists.
        if (out_dir / file).is_symlink():
            return None
        page_html = (out_dir / file).read_text(encoding="utf-8")
        revision = page_revision(out_dir, name)
        record = archive.read_record(out_dir, name) or {}
    except (OSError, UnicodeDecodeError, RuntimeError):
        return None
    # The allow-list may have been read before the page was published hidden.
    if not extract_visibility(page_html):
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
                          text=form.text, labels=dict(form.options), section=form.section,
                          defaults=form.defaults, checklist=form.checklist,
                          context=form.context, default=form.default)
        for key, form in decisions.read_forms(page_html).items()
    }
    owner = page_owner(page_html)
    boxes = frozenset(comments.read_boxes(page_html))
    # A block outside every section's wrapper is on the whole page, or in
    # the page's one box when that is its only box.
    outside = comments.PAGE_SECTION if boxes == {comments.PAGE_SECTION} else comments.WHOLE_PAGE
    earlier = kept_block_hashes(out_dir, name)
    page_widgets = {
        ident: api.Widget(hash=hash_, title=title, section=section or outside,
                          earlier=frozenset(earlier.get(ident, ())))
        for ident, (hash_, title, section) in widgets.PageWidgets(page_html).found.items()
    }
    return api.Page(name=name, revision=revision, sections=sections, questions=questions,
                    comment_sections=boxes, widgets=page_widgets,
                    owner=owner if machine.is_handle(owner) else "",
                    title=extract_meta(page_html, name)["title"],
                    archived=record.get("archivedAt", ""),
                    superseded_by=record.get("supersededBy") or "")


class _Catalog:
    """api_page and served_page_names over one read of the allow-list, made
    at the first lookup, keeping each page it builds."""

    def __init__(self, out_dir: Path) -> None:
        self.out_dir = out_dir
        self._allowed: frozenset[str] | None = None
        self._found: dict[str, api.Page | None] = {}

    def _allow_list(self) -> frozenset[str]:
        if self._allowed is None:
            self._allowed = serve_files.serve_allow_list(self.out_dir)
        return self._allowed

    def __call__(self, name: str) -> api.Page | None:
        if name not in self._found:
            self._found[name] = api_page(self.out_dir, name, self._allow_list())
        return self._found[name]

    def names(self) -> list[str]:
        return served_page_names(self.out_dir, self._allow_list())


def api_catalog(out_dir: Path) -> Callable[[str], api.Page | None]:
    """A lookup like api_page for one /api request that looks up many names:
    it reads the allow-list once, and only when a name is looked up. Its
    names() is served_page_names over the same read."""
    return _Catalog(out_dir)


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


# Headers on every page response. A meta tag cannot limit framing: only this
# site may frame a page, as the index's tabs do (lotuspod-index.js). nosniff
# keeps a browser from reading a file as a type it was not served as.
_PAGE_HEADERS = (
    ("Content-Security-Policy", "frame-ancestors 'self'"),
    ("X-Content-Type-Options", "nosniff"),
)


# Headers on an earlier version of a page, in place of _PAGE_HEADERS: its
# policy adds to the page's own meta policy, so no form runs, no page frames
# it, and it is never kept. _serve_version adds the policy's script source:
# a nonce made for each answer, which allows the one script old_page() adds,
# the old-version script. None of the page's own scripts carries it, so none
# of them runs; and no base element in the page may move that script's
# address to another site, as a page published before its own meta policy
# (page_policy) could.
_OLD_VERSION_HEADERS = (
    ("Content-Security-Policy", "frame-ancestors 'none'; form-action 'none'; base-uri 'none'"),
    ("X-Content-Type-Options", "nosniff"),
    ("Cache-Control", "private, no-store"),
)
_VERSION_QUERY = "version"
# Headers on an archived page, answered from memory: never answered 304 from
# a copy kept before it was archived or unarchived.
_ARCHIVED_HEADERS = (*_PAGE_HEADERS, ("Cache-Control", "no-cache"))


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
    verifies (see parse_request and _serve_api). The answers, comments,
    media, revision, seen and versions routes are lotuspod.api's.

    NAME.html?version=COMMIT answers an earlier version of an allow-listed
    page, read-only (see _serve_version), after the same Access check; any
    other query on a page is served as the page. A page with an archive
    record is answered marked archived (see _serve_archived).
    """

    # Whether the response being written is a page's, and the type of the
    # stored image it is ("" when none; see end_headers and guess_type).
    _page_response = False
    _media_type = ""

    def __init__(self, *args, root: Path, verifier: access.Verifier | None = None,
                 api: api.Api | None = None, history: versions.History | None = None,
                 events: event_streams.Hub | None = None,
                 **kwargs):
        self.root = Path(root)
        self.verifier = verifier
        self.events = events
        self.api = api
        self.history = history
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

    def _reader(self) -> str | None:
        """The reader's address from the request's verified Access assertion;
        None once the refusal is answered."""
        # The reader is known only from a verified assertion; the plain
        # Cf-Access-Authenticated-User-Email header is never read.
        if self.verifier is None:
            self._api_answer(HTTPStatus.SERVICE_UNAVAILABLE, {"error": "access_unconfigured"})
            return None
        assertions = self.headers.get_all(access.ASSERTION_HEADER) or []
        try:
            if len(assertions) > 1:
                raise access.InvalidAssertion("more than one assertion")
            return self.verifier.reader(assertions[0] if assertions else None)
        except access.AccessError as exc:
            self._api_answer(exc.status, {"error": exc.error})
            return None

    def _serve_api(self, path: str, body: api.Body) -> None:
        email = self._reader()
        if email is None:
            return
        actor = {"kind": "human", "email": email}
        if self.api is not None and path == event_streams.PATH:
            self._serve_events()
        elif self.api is not None and path in api.ROUTES:
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

    def _serve_events(self) -> None:
        if self.command != "GET":
            self._api_answer(405, {"error": "method_not_allowed"}, (("Allow", "GET"),))
            return
        hub = self.events

        def disconnect():
            try:
                self.connection.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

        subscription = hub.open(disconnect)
        if subscription is None:
            self._api_answer(503, {"error": "too_many_streams"}, (("Retry-After", "60"),))
            return
        self.close_connection = True
        self.connection.settimeout(min(hub.heartbeat, hub.max_age))
        try:
            self.send_response(200)
            for name, value in (("Content-Type", "text/event-stream"),
                                ("Cache-Control", "no-store"),
                                ("X-Content-Type-Options", "nosniff"),
                                ("X-Accel-Buffering", "no")):
                self.send_header(name, value)
            self.end_headers()
            self.wfile.write(b"retry: 3000\n\n")
            self.wfile.flush()
            deadline = time.monotonic() + hub.max_age
            heartbeat = time.monotonic() + hub.heartbeat
            while not subscription.ended.is_set():
                now = time.monotonic()
                if now >= deadline:
                    break
                # EOF on the request side can be a legitimate half-close.
                # Probe with a comment instead: only a failed response write
                # proves the reader is gone, and releases its slot promptly.
                if select.select([self.connection], [], [], 0)[0]:
                    if not self.connection.recv(1, socket.MSG_PEEK):
                        heartbeat = min(heartbeat, now + .2)
                try:
                    data = subscription.get(timeout=max(0, min(.2, deadline-now, heartbeat-now)))
                except queue.Empty:
                    if time.monotonic() < heartbeat:
                        continue
                    data = b": keepalive\n\n"
                self.connection.settimeout(max(.001, min(hub.heartbeat, deadline - time.monotonic())))
                self.wfile.write(data)
                self.wfile.flush()
                heartbeat = time.monotonic() + hub.heartbeat
        except (BrokenPipeError, ConnectionResetError, TimeoutError):
            pass
        finally:
            hub.remove(subscription)

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
            and rel.name in serve_files.serve_allow_list(self.root)
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

    def _version_asked(self, name: str) -> str | None:
        """The commit a request for the allow-listed file name asks for as
        ?version=COMMIT, checked later; None when it asks for none."""
        query = self.path.split("#", 1)[0].partition("?")[2]
        if (not query or not name.endswith(".html")
                or not (is_page_name(name) or WIDGET_NAME.fullmatch(name))):
            return None
        fields = urllib.parse.parse_qs(query, keep_blank_values=True)
        if list(fields) != [_VERSION_QUERY] or len(fields[_VERSION_QUERY]) != 1:
            return None
        return fields[_VERSION_QUERY][0]

    def _serve_version(self, name: str, commit: str):
        """The page NAME.html as it was at commit, read-only; 404 unless it
        is one of the page's listed versions."""
        if self._reader() is None:
            return None
        stem = name[:-len(".html")]
        found = self.history.version(stem, commit) if self.history is not None else None
        if found is None:
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return None
        version, behind, page_html = found
        nonce = secrets.token_urlsafe(18)
        script = f"{OLD_VERSION_SCRIPT}?v={theme_hash()}"
        data = versions.old_page(page_html, stem, version, behind, nonce, script).encode("utf-8")
        self._page_response, self._media_type = False, ""
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        for header, value in _OLD_VERSION_HEADERS:
            if header == "Content-Security-Policy":
                value += f"; script-src 'nonce-{nonce}'"
            self.send_header(header, value)
        self.end_headers()
        return io.BytesIO(data)

    def _serve_widget_version(self, name: str, commit: str):
        """A listed version's widget, sandboxed and never stored."""
        if self._reader() is None:
            return None
        data = (self.history.widget_version(name.rsplit(".w-", 1)[0], commit, name)
                if self.history is not None else None)
        if data is None:
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return None
        self._page_response, self._media_type = False, ""
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        for header, value in widgets.HEADERS:
            self.send_header(header, value)
        self.send_header("Cache-Control", "private, no-store")
        self.end_headers()
        return io.BytesIO(data)

    def _serve_archived(self, stored: Path):
        """The page at stored as archived_page() marks it, always a 200;
        None when it has no archive record, or one that cannot be read, so
        it is answered from its file."""
        stem = stored.name[:-len(".html")]
        try:
            record = archive.read_record(self.root, stem)
            if record is None:
                return None
            page_html = stored.read_text(encoding="utf-8")
        except (OSError, UnicodeDecodeError, RuntimeError):
            return None
        data = archive.archived_page(
            page_html, record, archive.successor_title(self.root, record)).encode("utf-8")
        self._page_response, self._media_type = False, ""
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        for header, value in _ARCHIVED_HEADERS:
            self.send_header(header, value)
        self.end_headers()
        return io.BytesIO(data)

    def send_head(self):
        # Denial never reaches the file system: were a file ever to sit at
        # the sentinel's name, it would still not be served.
        self._widget_response = False
        # Historical files may have been deleted. Validate the owning page
        # through the ordinary allow list before consulting its history.
        path = urllib.parse.unquote(self.path.split("?", 1)[0].split("#", 1)[0])
        name = path.removeprefix("/")
        if "/" not in name and WIDGET_NAME.fullmatch(name):
            commit = self._version_asked(name)
            owner = name.rsplit(".w-", 1)[0] + ".html"
            if (commit is not None and is_page_name(owner)
                    and self.translate_path("/" + owner) != str(self.root / _DENY_PATH_NAME)):
                return self._serve_widget_version(name, commit)
        target = self.translate_path(self.path)
        if target == str(self.root / _DENY_PATH_NAME):
            self.send_error(HTTPStatus.NOT_FOUND, "File not found")
            return None
        stored = Path(target)
        if stored.parent == self.root:
            commit = self._version_asked(stored.name)
            if commit is not None:
                return self._serve_version(stored.name, commit)
            if stored.name.endswith(".html") and is_page_name(stored.name):
                answer = self._serve_archived(stored)
                if answer is not None:
                    return answer
        if stored.parent == media.media_dir(self.root):
            self._page_response = False
            self._media_type = media.CONTENT_TYPES[stored.suffix[1:]]
        else:
            self._page_response, self._media_type = target.endswith(".html"), ""
        self._widget_response = bool(WIDGET_NAME.fullmatch(stored.name))
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
            for header, value in (widgets.HEADERS if getattr(self, "_widget_response", False) else _PAGE_HEADERS):
                self.send_header(header, value)
        if self._media_type:
            for header, value in _MEDIA_HEADERS:
                self.send_header(header, value)
        super().end_headers()

    def list_directory(self, path: str):
        self.send_error(HTTPStatus.NOT_FOUND, "File not found")
        return None


def resolve_serve_host(host_override: str) -> str:
    """Explicit --host wins; otherwise loopback, reachable from this machine only."""
    return host_override if host_override else DEFAULT_SERVE_HOST


def serve_socket_path(db_path: Path, socket_arg: str) -> Path:
    """The agent socket serve listens on: --socket, else the config's
    [agents] socket, else lotuspod.sock beside the database."""
    if socket_arg:
        return Path(socket_arg)
    return configured_socket() or db_path.parent / machine.SOCKET_NAME


def _make_server(out_dir: Path, host: str, port: int,
                 verifier: access.Verifier | None = None,
                 db_path: Path | None = None,
                 window: int = routing.DEFAULT_WINDOW,
                 max_image_bytes: int = media.DEFAULT_MAX_BYTES,
                 events: event_streams.Hub | None = None) -> ThreadingHTTPServer:
    """The allow-list server; /api answers 503 access_unconfigured without a
    verifier, and has no answers, comments, media, revision, seen, versions and
    archive routes without a database. Uploads go to the media store beside out_dir,
    within max_image_bytes. The pages' versions are read from out_dir's repository.
    The verifier's owners may archive a page, which the route writes as
    `lotuspod archive` does."""
    history = versions.History(out_dir, version_stamp)
    routes = None
    if db_path is not None:
        events = events or event_streams.Hub(out_dir)
        routes = api.Api(db.Database(db_path), partial(api_page, out_dir), window,
                         media_dir=media.media_dir(out_dir), max_image_bytes=max_image_bytes,
                         history=history, names=partial(served_page_names, out_dir),
                         catalog=partial(api_catalog, out_dir),
                         archive=partial(archive.set_archived, out_dir),
                         owners=verifier.config.owners if verifier is not None else frozenset(),
                         changed=events.changed)
    handler = partial(
        _AllowListHandler, directory=str(out_dir), root=out_dir, verifier=verifier,
        api=routes, history=history, events=events,
    )
    server = ThreadingHTTPServer((host, port), handler)
    server.events = events
    return server


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
    image_cap = media_cap()
    host = resolve_serve_host(args.host)
    verifier = access_verifier()

    try:
        server = _make_server(out_dir, host, args.port, verifier=verifier, db_path=db_path,
                              window=window, max_image_bytes=image_cap)
    except OSError as exc:
        print(f"error: cannot bind {host}:{args.port}: {exc}", file=sys.stderr)
        return 1
    try:
        sockets = machine.SocketServer(
            socket_path, db.Database(db_path), pages=partial(api_page, out_dir),
            catalog=partial(api_catalog, out_dir),
            describe=partial(agent_page, out_dir), window=window, claim_sec=claim_sec,
            media_dir=media.media_dir(out_dir), max_image_bytes=image_cap,
            changed=server.events.changed,
        )
    except (OSError, machine.SocketInUse) as exc:
        server.server_close()
        print(f"error: cannot listen on {socket_path}: {exc}", file=sys.stderr)
        return 1

    if not (out_dir / INDEX_FILE).exists():
        print(f"note: no {INDEX_FILE} yet; run `lotuspod index` to build one")
    print(f"serving {out_dir} on {host} (v2 allow-list):")
    print(f"  http://{host}:{args.port}/")
    print(f"answers and comments in {db_path}")
    print(f"agents on {socket_path}")
    if verifier is None:
        print("note: no [access] section in the config; /api answers 503")
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
        server.events.close()
        sockets.shutdown()
        socket_thread.join()
        sockets.server_close()
        server.server_close()
        if on_main:
            signal.signal(signal.SIGTERM, previous)
    return 0


def _stop_serving(signum: int, frame: object) -> None:
    raise KeyboardInterrupt


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
    current answer and, under it, the earlier ones, newest first. A
    checklist's answer is its change summary, read against the page's form
    while it asks at the answer's version, else the summary kept with it. A
    decision answered at its form's version with another option than the
    form's default says so: "LABEL, was: DEFAULT-LABEL". An answer an agent
    recorded from elsewhere names the handle that recorded it and where it
    was given. A dismissal is "Dismissed", its note its reason, and says
    when it was undone, if it was."""
    if not questions:
        return f"no answers to {name}"

    def entry(row: dict, form: decisions.Form | None, indent: str) -> list[str]:
        if row.get("dismissed"):
            label = "Dismissed"
        elif "checked" in row:
            if form is not None and row["version"] == form.version:
                label = api.summary(api.changes(dict(form.options), form.defaults,
                                                row["checked"]))
            else:
                label = row["asked"]["label"]
        else:
            label = form.label(row["choice"]) if form else row["choice"]
            if (form is not None and row["version"] == form.version and form.default
                    and row["choice"] != form.default):
                label += f", was: {form.label(form.default)}"
        head = f"{indent}{label} (answer {row['id']}"
        if row["supersedes"] is not None:
            head += f", replaces answer {row['supersedes']}"
        head += ")"
        if form is None or row["version"] != form.version:
            head += ", to an earlier wording"
        if "undoneAt" in row:
            head += f", undone at {row['undoneAt']}"
        if "source" in row:
            by = (f"recorded by {row['actor'].get('handle', '')} at {row['createdAt']}, "
                  f"answered elsewhere: {row['source']}")
        else:
            by = f"by {row['actor'].get('email', '')} at {row['createdAt']}"
        lines = [head, f"{indent}  {by}"]
        if row["note"]:
            if row.get("dismissed"):
                lines.append(f"{indent}  reason: {agents.one_line(row['note'])}")
            else:
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
        questions = serve_database(args).answers(name, asked=True)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps({"page": name, "questions": questions}, indent=2))
        return 0
    out_dir = Path(args.out_dir) if args.out_dir else DEFAULT_OUTPUT_DIR
    page = out_dir / f"{name}.html"
    forms = decisions.read_forms(page.read_text(encoding="utf-8")) if page.is_file() else {}
    print(agents.printable(answers_text(name, questions, forms)))
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
    publish.set_defaults(func=cmd_publish)

    serve = sub.add_parser(
        "serve",
        help="serve the artifacts directory (v2: allow-list enforced)",
    )
    serve.add_argument("--out-dir", default="", help="artifacts directory (default: artifacts/)")
    serve.add_argument(
        "--port", type=int, default=DEFAULT_SERVE_PORT, help=f"TCP port (default: {DEFAULT_SERVE_PORT})"
    )
    serve.add_argument(
        "--host",
        default="",
        help=f"bind address (default: {DEFAULT_SERVE_HOST}); pass a tailnet or LAN "
        "address to share beyond this machine",
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
    agents.add_inbox_parser(sub)
    responder.add_parser(sub)
    backup.add_parser(sub)
    archive.add_parser(sub)

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
