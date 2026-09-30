"""The reader's answers and comments over /api, for the verified reader only.

serve hands a request here only after its Access assertion verifies, with
the reader as actor. Four routes:

    POST /api/answers     {page, question, version, choice, note}
    GET  /api/answers?page=NAME
    POST /api/comments    {page, section, text[, quote]} or {page, parent, text}
    GET  /api/comments?page=NAME

A POST is refused before anything is stored: 403 cross_origin when a browser
sent it from another site, 415 when it is not JSON, 411 without a length,
413 over MAX_BODY bytes, 400 invalid_body for a body that is not the one
described, 404 unknown_page for a page serve would not answer, and 404
unknown_parent for a reply to no comment on its page. An answer is checked
against the page's own decision forms: 400 unknown_question for a question
the page does not ask, 409 stale for a version other than the page's, and
400 invalid_choice for a choice its form does not offer. A new thread is
checked against the page's comment boxes: 400 unknown_section for a section
the page has no box for.

Every reader's comment a route answers carries its routing state (see
lotuspod.routing): `state` is `pending` or `unavailable` until an agent takes
it up, and `owner` is the handle it is routed to (null on an agent's reply).
"""

from __future__ import annotations

import json
import socket
import sqlite3
import time
import urllib.parse
from dataclasses import dataclass, field
from email.message import Message
from http import HTTPStatus
from typing import BinaryIO, Callable, Mapping

from lotuspod import db, routing

ANSWERS = "/api/answers"
COMMENTS = "/api/comments"
ROUTES = (ANSWERS, COMMENTS)
METHODS = ("GET", "HEAD", "POST")

MAX_BODY = 16 << 10
MAX_NAME = 100
MAX_TEXT = 4000
MAX_EXACT = 500
MAX_CONTEXT = 32
# Seconds a request body may take to arrive.
BODY_TIMEOUT = 10
# A refused body up to this size is still read, and dropped: closing a
# connection with unread data resets it, and the reset can overtake the answer.
DRAIN_LIMIT = 64 << 10
# SQLite's largest integer.
_MAX_ID = (1 << 63) - 1

# (status, JSON payload, extra headers)
Answer = tuple[int, dict, tuple]


@dataclass(frozen=True)
class Question:
    """A decision form's question as the page asks it."""

    version: str
    choices: frozenset[str]
    text: str = ""
    # Option values to their labels.
    labels: Mapping[str, str] = field(default_factory=dict)


@dataclass(frozen=True)
class Page:
    """What a row records of the page it was written against."""

    name: str
    revision: str
    # Section ids to their titles.
    sections: Mapping[str, str]
    # Question ids of the page's decision forms to their questions.
    questions: Mapping[str, Question] = field(default_factory=dict)
    # The sections of the page's comment boxes, which take new threads.
    comment_sections: frozenset[str] = frozenset()
    # The handle its lotuspod:owner names; "" when none does.
    owner: str = ""
    title: str = ""


class Refusal(Exception):
    def __init__(self, status: int, error: str) -> None:
        super().__init__(error)
        self.status = status
        self.error = error


def _invalid() -> Refusal:
    return Refusal(HTTPStatus.BAD_REQUEST, "invalid_body")


class Body:
    """A request's body, read at most once."""

    def __init__(self, rfile: BinaryIO, connection: socket.socket | None,
                 headers: Message) -> None:
        self._rfile = rfile
        self._connection = connection
        self._headers = headers
        self._read = False

    def length(self) -> int | None:
        """The declared length; None when there is none; Refusal when it is
        not one number."""
        values = self._headers.get_all("Content-Length") or []
        if not values:
            return None
        if len(values) > 1 or not values[0].strip().isdigit():
            raise _invalid()
        return int(values[0].strip())

    def read(self, limit: int) -> bytes:
        """The body; Refusal when it has no length or is over limit bytes."""
        length = self.length()
        if length is None:
            raise Refusal(HTTPStatus.LENGTH_REQUIRED, "length_required")
        if length > limit:
            raise Refusal(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, "body_too_large")
        self._read = True
        data = self._take(length)
        if len(data) != length:
            raise _invalid()
        return data

    def discard(self) -> None:
        """Read and drop a body left unread, when it is small enough."""
        if self._read:
            return
        self._read = True
        try:
            length = self.length()
        except Refusal:
            return
        if length and length <= DRAIN_LIMIT:
            self._take(length)

    def _take(self, length: int) -> bytes:
        if self._connection is not None:
            self._connection.settimeout(BODY_TIMEOUT)
        try:
            return self._rfile.read(length)
        except OSError:
            return b""


def _unique_object(pairs: list) -> dict:
    keys = [key for key, _ in pairs]
    if len(keys) != len(set(keys)):
        raise ValueError("duplicate member")
    return dict(pairs)


def _no_constant(name: str) -> None:
    raise ValueError(f"{name} is not JSON")


def _json_object(data: bytes) -> dict:
    try:
        value = json.loads(data.decode("utf-8"), object_pairs_hook=_unique_object,
                           parse_constant=_no_constant)
    except (ValueError, RecursionError):
        raise _invalid() from None
    if not isinstance(value, dict):
        raise _invalid()
    return value


def _keys(body: dict, required: set, optional: frozenset = frozenset()) -> None:
    if not required <= body.keys() <= required | optional:
        raise _invalid()


def _text(value: object, low: int, high: int) -> str:
    """value as a string of low to high characters; Refusal for anything else."""
    if not isinstance(value, str) or not low <= len(value) <= high:
        raise _invalid()
    try:
        value.encode("utf-8")
    except UnicodeEncodeError:  # a lone surrogate, which \\ud800 decodes to
        raise _invalid() from None
    return value


def _quote(value: object) -> dict | None:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise _invalid()
    _keys(value, {"exact", "prefix", "suffix"})
    return {
        "exact": _text(value["exact"], 1, MAX_EXACT),
        "prefix": _text(value["prefix"], 0, MAX_CONTEXT),
        "suffix": _text(value["suffix"], 0, MAX_CONTEXT),
    }


def _id(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= _MAX_ID:
        raise _invalid()
    return value


def _media_type(headers: Message) -> str:
    return (headers.get("Content-Type") or "").split(";", 1)[0].strip().lower()


def cross_origin(headers: Message) -> bool:
    """Whether a browser sent the request from a page of another origin.

    A request with no Origin (not a browser's) is not cross-origin; one whose
    Origin is not the request's own, or whose Sec-Fetch-Site says cross-site,
    is. The request's own origin is the Host it was sent to, over the scheme
    the reader used: X-Forwarded-Proto when a proxy in front of serve (the
    Cloudflare tunnel, which ends the TLS) names it, else serve's own http.
    """
    if (headers.get("Sec-Fetch-Site") or "").strip().lower() == "cross-site":
        return True
    origins = headers.get_all("Origin") or []
    if not origins:
        return False
    hosts = headers.get_all("Host") or []
    schemes = headers.get_all("X-Forwarded-Proto") or ["http"]
    if len(origins) > 1 or len(hosts) != 1 or len(schemes) != 1:
        return True
    host = hosts[0].strip().lower()
    scheme = schemes[0].strip().lower()
    if not host or scheme not in ("http", "https"):
        return True
    return origins[0].strip().lower() != f"{scheme}://{host}"


class Api:
    """The four routes over one database; pages(name) is the Page serve
    would answer for name, or None; window is routing's owner window."""

    def __init__(self, database: db.Database, pages: Callable[[str], Page | None],
                 window: float = routing.DEFAULT_WINDOW,
                 clock: Callable[[], float] = time.time) -> None:
        self.database = database
        self.pages = pages
        self.window = window
        self.clock = clock

    def answer(self, method: str, path: str, query: str, headers: Message,
               body: Body, actor: Mapping) -> Answer:
        """The answer to one request for path, one of ROUTES."""
        if method not in METHODS:
            return (HTTPStatus.METHOD_NOT_ALLOWED, {"error": "method_not_allowed"},
                    (("Allow", ", ".join(METHODS)),))
        try:
            if method == "POST":
                if path == ANSWERS:
                    row = self._post_answer(headers, body, actor)
                else:
                    row = self._post_comment(headers, body, actor)
                return HTTPStatus.CREATED, row, ()
            page = self._page(self._query_page(query))
            if path == ANSWERS:
                payload = {"page": page.name, "questions": self.database.answers(page.name)}
            else:
                payload = {"page": page.name, "threads": routing.threads(
                    self.database, page.name, self.window, self.clock())}
            return HTTPStatus.OK, payload, ()
        except Refusal as exc:
            return exc.status, {"error": exc.error}, ()
        except (sqlite3.Error, OSError):
            return HTTPStatus.SERVICE_UNAVAILABLE, {"error": "storage_unavailable"}, ()

    @staticmethod
    def _query_page(query: str) -> str:
        try:
            fields = urllib.parse.parse_qs(query, keep_blank_values=True,
                                           strict_parsing=bool(query), errors="strict")
        except (ValueError, UnicodeDecodeError):
            fields = {}
        if list(fields) != ["page"] or len(fields["page"]) != 1:
            raise Refusal(HTTPStatus.BAD_REQUEST, "invalid_query")
        return fields["page"][0]

    def _page(self, name: object) -> Page:
        if not isinstance(name, str):
            raise _invalid()
        page = self.pages(name)
        if page is None:
            raise Refusal(HTTPStatus.NOT_FOUND, "unknown_page")
        return page

    @staticmethod
    def _json_body(headers: Message, body: Body) -> dict:
        if cross_origin(headers):
            raise Refusal(HTTPStatus.FORBIDDEN, "cross_origin")
        if _media_type(headers) != "application/json":
            raise Refusal(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "unsupported_media_type")
        return _json_object(body.read(MAX_BODY))

    def _post_answer(self, headers: Message, body: Body, actor: Mapping) -> dict:
        fields = self._json_body(headers, body)
        _keys(fields, {"page", "question", "version", "choice", "note"})
        question = _text(fields["question"], 1, MAX_NAME)
        version = _text(fields["version"], 1, MAX_NAME)
        choice = _text(fields["choice"], 1, MAX_NAME)
        note = _text(fields["note"], 0, MAX_TEXT)
        page = self._page(fields["page"])
        asked = page.questions.get(question)
        if asked is None:
            raise Refusal(HTTPStatus.BAD_REQUEST, "unknown_question")
        if version != asked.version:
            raise Refusal(HTTPStatus.CONFLICT, "stale")
        if choice not in asked.choices:
            raise Refusal(HTTPStatus.BAD_REQUEST, "invalid_choice")
        return self.database.add_answer(
            page=page.name, question=question, version=version, choice=choice,
            note=note, revision=page.revision, actor=actor,
            question_text=asked.text, choice_label=asked.labels.get(choice, choice),
        )

    def _post_comment(self, headers: Message, body: Body, actor: Mapping) -> dict:
        row = self._store_comment(headers, body, actor)
        return routing.public(row, routing.last_pulls(self.database), self.window, self.clock())

    def _store_comment(self, headers: Message, body: Body, actor: Mapping) -> dict:
        fields = self._json_body(headers, body)
        if "parent" in fields:
            _keys(fields, {"page", "parent", "text"})
            parent = _id(fields["parent"])
            text = _text(fields["text"], 1, MAX_TEXT)
            page = self._page(fields["page"])
            try:
                return self.database.add_reply(
                    page=page.name, parent=parent, revision=page.revision,
                    sections=page.sections, text=text, actor=actor, owner=page.owner,
                )
            except db.UnknownParent:
                raise Refusal(HTTPStatus.NOT_FOUND, "unknown_parent") from None
        _keys(fields, {"page", "section", "text"}, frozenset({"quote"}))
        # A heading's id may be any length, and must match one of the page's
        # boxes exactly: the body's own limit is the only one it needs.
        section = _text(fields["section"], 1, MAX_BODY)
        text = _text(fields["text"], 1, MAX_TEXT)
        quote = _quote(fields.get("quote"))
        page = self._page(fields["page"])
        if section not in page.comment_sections:
            raise Refusal(HTTPStatus.BAD_REQUEST, "unknown_section")
        return self.database.add_comment(
            page=page.name, section=section, section_title=page.sections.get(section, ""),
            revision=page.revision, text=text, quote=quote, actor=actor, owner=page.owner,
        )
