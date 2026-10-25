"""serve's HTTP handler, which answers only allow-listed names, and the
server _make_server builds around it."""

from __future__ import annotations

import hashlib
import io
import json
import queue
import re
import secrets
import select
import socket
import time
import urllib.parse
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from lotuspod.features import agents
from lotuspod.core import INDEX_FILE, OLD_VERSION_SCRIPT, WIDGET_NAME, is_page_name, theme_hash
from lotuspod.features.history import (History, archived_page, old_page, read_record, set_archived,
                                        successor_title)
from lotuspod.features import live
from lotuspod.features import publish
from lotuspod.features.publish import version_stamp
from lotuspod.features.serve import access, api, serve_files
from lotuspod.features.serve.pages import (api_catalog, api_page, render_version, rendered_index,
                                           rendered_page, served_page_names)
from lotuspod.features.serve.serve_files import _SERVE_NEVER_FILES
from lotuspod.features import widgets
from lotuspod.store import db


_DENY_PATH_NAME = ".lotuspod-not-found"


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
# Headers on an archived page, answered from memory under an ETag over its
# bytes: a copy kept before it was archived or unarchived is never answered 304.
_ARCHIVED_HEADERS = (*_PAGE_HEADERS, ("Cache-Control", "no-cache"))
# Headers on a page and a live-block frame rendered when asked for: each
# answer is checked against its ETag, which follows the page's inputs and
# the render version, so a publish or a deploy reaches the reader at once.
_RENDERED_HEADERS = (*_PAGE_HEADERS, ("Cache-Control", "no-cache"))
_FRAME_HEADERS = (*widgets.HEADERS, widgets.VARY, ("Cache-Control", "no-cache"))


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
_MEDIA_PATH = re.compile(re.escape(publish.URL_PREFIX) + f"({publish.STORED_NAME.pattern})")


class _AllowListHandler(SimpleHTTPRequestHandler):
    """Serve v2: answer only allow-listed names; everything else is a 404.

    /api paths never reach the file system or method dispatch: whatever the
    method, each is answered only after the request's Access assertion
    verifies (see parse_request and _serve_api). The answers, comments,
    media, revision, seen and versions routes are lotuspod.features.serve.api's.

    NAME.html?version=COMMIT answers an earlier version of an allow-listed
    page, read-only (see _serve_version), after the same Access check; any
    other query on a page is served as the page. A page is answered as
    rendered now from what it keeps (see _serve_rendered), never its
    published file unless that render fails; one with an archive record is
    answered marked archived (see _serve_archived). The index, at / and
    /index.html, is answered rendered from the manifest (see _serve_index).
    """

    # Whether the response being written is a page's, and the type of the
    # stored image it is ("" when none; see end_headers and guess_type).
    _page_response = False
    _media_type = ""

    def __init__(self, *args, root: Path, verifier: access.Verifier | None = None,
                 api: api.Api | None = None, history: History | None = None,
                 events: live.Hub | None = None, render_version: str = "",
                 **kwargs):
        self.root = Path(root)
        self.render_version = render_version
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
        if self.api is not None and path == live.PATH:
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
        if words == publish.URL_PREFIX.rstrip("/") or words.startswith(publish.URL_PREFIX):
            match = _MEDIA_PATH.fullmatch(words)
            stored = match and publish.stored_file(publish.media_dir(self.root), match.group(1))
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
        # The framing page's frame of an earlier version (widgets.alone_page).
        if WIDGET_NAME.fullmatch(name) and fields.get(widgets.ALONE_QUERY) == [""]:
            del fields[widgets.ALONE_QUERY]
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
        data = old_page(page_html, stem, version, behind, nonce, script).encode("utf-8")
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
        if self._opened_alone():
            return self._serve_alone(name, urllib.parse.urlencode({_VERSION_QUERY: commit}))
        self._page_response, self._media_type = False, ""
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        for header, value in (*widgets.HEADERS, widgets.VARY):
            self.send_header(header, value)
        self.send_header("Cache-Control", "private, no-store")
        self.end_headers()
        return io.BytesIO(data)

    def _opened_alone(self) -> bool:
        """Whether the browser asked for a widget file as a tab's document.
        Only a browser that says so is framed: one that sends no
        Sec-Fetch-Dest would ask for the framing page again from its frame."""
        return (self.headers.get("Sec-Fetch-Dest") or "").strip().lower() == "document"

    def _serve_alone(self, name: str, query: str = ""):
        """The widget file name, opened in a tab, as a page framing it under
        frame-src 'self' (widgets.alone_page)."""
        data = widgets.alone_page(name, query)
        self._page_response, self._media_type = False, ""
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        for header, value in widgets.ALONE_HEADERS:
            self.send_header(header, value)
        self.end_headers()
        return io.BytesIO(data)

    def _serve_archived(self, stored: Path):
        """The page at stored as archived_page() marks it, under an ETag;
        None when it has no archive record, or one that cannot be read, so
        it is answered from its file."""
        stem = stored.name[:-len(".html")]
        try:
            record = read_record(self.root, stem)
            if record is None:
                return None
            rendered = rendered_page(self.root, stem)
            page_html = (rendered.html if rendered is not None
                         else stored.read_text(encoding="utf-8"))
        except (OSError, UnicodeDecodeError, RuntimeError):
            return None
        data = archived_page(
            page_html, record, successor_title(self.root, record)).encode("utf-8")
        # Tagged by the page's inputs and the render version, as a page
        # that is not archived is, and by what it answers, which follows its
        # record and its successor's title.
        inputs = rendered.inputs if rendered is not None else "unread"
        tag = f'"a-{inputs}-{self.render_version}-{hashlib.sha256(data).hexdigest()[:16]}"'
        return self._answer_rendered(data, tag, _ARCHIVED_HEADERS)

    def _answer_rendered(self, data: bytes, tag: str, headers: tuple):
        """data under ETag tag, or 304 when the request already holds it."""
        self._page_response, self._media_type = False, ""
        held = self.headers.get("If-None-Match") or ""
        if tag in (word.strip().removeprefix("W/") for word in held.split(",")):
            self.send_response(HTTPStatus.NOT_MODIFIED)
            self.send_header("ETag", tag)
            for header, value in headers:
                self.send_header(header, value)
            self.end_headers()
            return io.BytesIO(b"")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.send_header("ETag", tag)
        for header, value in headers:
            self.send_header(header, value)
        self.end_headers()
        return io.BytesIO(data)

    def _serve_rendered(self, stored: Path):
        """The page at stored rendered from what it keeps; None when its
        render failed, so it is answered from its file."""
        rendered = rendered_page(self.root, stored.name[:-len(".html")])
        if rendered is None or not rendered.rendered:
            return None
        return self._answer_rendered(rendered.html.encode("utf-8"),
                                     f'"{rendered.inputs}-{self.render_version}"',
                                     _RENDERED_HEADERS)

    def _serve_index(self):
        """The index rendered from the manifest; None when the manifest
        cannot be read, so it is answered from its file."""
        rendered = rendered_index(self.root)
        if rendered is None:
            return None
        return self._answer_rendered(rendered[0].encode("utf-8"),
                                     f'"i-{rendered[1]}-{self.render_version}"', _RENDERED_HEADERS)

    def _serve_frame(self, stored: Path):
        """The live-block frame at stored as its page's render draws it
        today; None when no allow-listed page's render names it."""
        owner = stored.name.rsplit(".w-", 1)[0] + ".html"
        if not is_page_name(owner) or self.translate_path("/" + owner) != str(self.root / owner):
            return None
        rendered = rendered_page(self.root, owner[:-len(".html")])
        data = rendered.frames.get(stored.name) if rendered is not None else None
        if data is None:
            return None
        return self._answer_rendered(data, f'"{rendered.inputs}-{self.render_version}"',
                                     _FRAME_HEADERS)

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
                if answer is None:
                    answer = self._serve_rendered(stored)
                if answer is not None:
                    return answer
            if stored.name == INDEX_FILE:
                answer = self._serve_index()
                if answer is not None:
                    return answer
        if stored.parent == publish.media_dir(self.root):
            self._page_response = False
            self._media_type = publish.CONTENT_TYPES[stored.suffix[1:]]
        else:
            self._page_response, self._media_type = target.endswith(".html"), ""
        self._widget_response = bool(WIDGET_NAME.fullmatch(stored.name))
        if self._widget_response and self._opened_alone() and stored.is_file():
            self._widget_response = False
            return self._serve_alone(stored.name)
        if self._widget_response and stored.parent == self.root:
            answer = self._serve_frame(stored)
            if answer is not None:
                self._widget_response = False
                return answer
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
            for header, value in ((*widgets.HEADERS, widgets.VARY)
                                  if getattr(self, "_widget_response", False) else _PAGE_HEADERS):
                self.send_header(header, value)
        if self._media_type:
            for header, value in _MEDIA_HEADERS:
                self.send_header(header, value)
        super().end_headers()

    def list_directory(self, path: str):
        self.send_error(HTTPStatus.NOT_FOUND, "File not found")
        return None


def _make_server(out_dir: Path, host: str, port: int,
                 verifier: access.Verifier | None = None,
                 db_path: Path | None = None,
                 window: int = agents.DEFAULT_WINDOW,
                 max_image_bytes: int = publish.DEFAULT_MAX_BYTES,
                 events: live.Hub | None = None) -> ThreadingHTTPServer:
    """The allow-list server; /api answers 503 access_unconfigured without a
    verifier, and has no answers, comments, media, revision, seen, versions and
    archive routes without a database. Uploads go to the media store beside out_dir,
    within max_image_bytes. The pages' versions are read from out_dir's repository.
    The verifier's owners may archive a page, which the route writes as
    `lotuspod archive` does."""
    history = History(out_dir, version_stamp)
    routes = None
    if db_path is not None:
        events = events or live.Hub(out_dir)
        routes = api.Api(db.Database(db_path), partial(api_page, out_dir), window,
                         media_dir=publish.media_dir(out_dir), max_image_bytes=max_image_bytes,
                         history=history, names=partial(served_page_names, out_dir),
                         catalog=partial(api_catalog, out_dir),
                         archive=partial(set_archived, out_dir),
                         owners=verifier.config.owners if verifier is not None else frozenset(),
                         changed=events.changed)
    handler = partial(
        _AllowListHandler, directory=str(out_dir), root=out_dir, verifier=verifier,
        api=routes, history=history, events=events, render_version=render_version(),
    )
    server = ThreadingHTTPServer((host, port), handler)
    server.events = events
    return server
