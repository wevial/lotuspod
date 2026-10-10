"""The reader's answers and comments over /api, for the verified reader only.

serve hands a request here only after its Access assertion verifies, with
the reader as actor. Ten routes:

    POST /api/answers     {page, question, version, choice, note} or
                          {page, question, version, checked, note}
    GET  /api/answers?page=NAME
    POST /api/comments    {page, section, text[, quote][, revision][, images]},
                          {page, section: "", text[, revision][, images]},
                          {page, question, text[, revision][, images]},
                          {page, parent, text[, images]} or {page, thread, resolved}
    GET  /api/comments?page=NAME
    POST /api/media       one image's bytes
    GET  /api/revision?page=NAME
    POST /api/seen        {page, revision} or {page, thread, comment}
    GET  /api/seen
    GET  /api/versions?page=NAME
    GET  /api/changes?page=NAME&since=REV
    GET  /api/activity[?before=TIME]
    POST /api/archive     {page, archived[, supersededBy]}
    GET  /api/archive?page=NAME

A read of the comments carries the page's current revision beside its
threads, and /api/revision answers it alone, {revision}: an open page
compares it with the revision it was rendered at to notice a republish.

POST /api/seen records that the reader opened `page` at `revision`, the
revision it was rendered at ("" for a page with no revision, and only for
one), keyed by their verified address, and answers
200 {page, revision, previous}: `previous` is the revision recorded for them
before, null the first time. GET /api/seen, which takes no query (400
invalid_query for any), answers {pages: {NAME: {revision, seen, seenAt,
replies, unread}}}, one entry for each page the reader has opened, or has
unread replies on, that serve still answers: `revision` the page's current
one, `seen` the one recorded and `seenAt` when (both null for a page never
opened), `replies` the count of the page's comments stored since then by
anyone but the reader (0 for a page never opened) and `unread` the count of
the reader's unread replies on it (lotuspod.db), 0 while the page has no
comment boxes. A page never opened is listed only while that count is not
0. It never names the reader.

`{page, thread, comment}` records that the reader has seen the thread whose
first comment is `thread` up to `comment`, and answers 200 {thread, comment}
with the mark as stored, which never goes down nor passes the thread's
newest comment: 404 unknown_thread when
`thread` is no first comment on `page`. A read of the comments also answers
`unread`, the ids of the reader's unread comments among its threads, oldest
first, none while the page has no comment boxes.

/api/versions answers {page, versions: [{commit, date, revision, current,
summary}]}: each commit of the artifacts repository that changed the page
while it was visible, newest first (lotuspod.versions), `date` its committer
time, `current` true on the newest only and `summary` what it changed from
the page before it in one line (versions.summary()), "" on a first version.
It is empty when the output directory is not the top of its own repository.

/api/activity answers the reader's recent activity on every page serve
answers: the ACTIVITY_DAYS days up to `before`, an ISO 8601 UTC time, else
now. It answers {from, to, older, truncated, pages: [{page, title, latest,
events}]}, `from` and `to` the window's bounds as the database writes times,
a page for each one with an event after `from` and up to `to`, by its newest
event (`latest`), newest first, and its events newest first. Events are
versions (History.recent()), {kind: version, at, commit, revision, current,
actor, first, summary}, `current` true when its revision is the page's as
serve answers it now, `actor` the handle the version's lotuspod:owner names
or null, and the comments, replies and answers of Database.activity(). At most
MAX_EVENTS are kept, the newest, and `truncated` says when any were left
out; `older` says whether anything on those pages happened up to `from`. Any
query but one `before` that parses is 400 invalid_query. An archived page has
no event there, its versions included.

GET /api/archive?page=NAME answers {page, archived, supersededBy,
mayArchive}: `archived` the time the page was archived or null,
`supersededBy` the page that replaces it or null, and `mayArchive` whether
the reader is one of the owners. POST /api/archive with {page, archived:
true|false[, supersededBy]} archives or unarchives the page as `lotuspod
archive` does (lotuspod.archive), and answers 200 in the same shape. It is
refused, with nothing written, as any POST, and 403 not_owner for a reader
who is not an owner, 400 invalid_body for a body not of that shape (a
`supersededBy` with `archived` false included), 404 unknown_page, and 400
unknown_successor for a successor serve does not answer, or the page itself.

/api/changes compares the newest listed version of NAME whose revision is
REV, the revision the reader last opened it at, with the current one
(lotuspod.versions.compare), and answers {page, since: {commit, date,
revision}, behind, changed, sections, lines, truncated}: `behind` the listed
versions newer than it, and `changed` false, with nothing compared, when REV
is the current revision. `sections` is {changed: [{id, title}], added: [{id,
title}], removed: [{title}]}; `lines` and `truncated` are there only when
both versions kept NAME.md, a unified diff of the two as [{op, text}]. It
answers 404 unknown_revision when no listed version carries REV, as for
every page outside a repository, and is refused otherwise as the versions
route is.

A POST is refused before anything is stored: 403 cross_origin when a browser
sent it from another site, 415 when it is not JSON, 411 without a length,
413 over MAX_BODY bytes, 400 invalid_body for a body that is not the one
described, 404 unknown_page for a page serve would not answer, and 404
unknown_parent for a reply to no comment on its page, and 404 unknown_thread
for a resolution or a seen mark naming no thread's first comment on its page. An answer is checked
against the page's own decision forms: 400 unknown_question for a question
the page does not ask, 409 stale for a version other than the page's, and
400 invalid_choice for a choice its form does not offer.
An archived page (Page.archived) takes no new thread, reply, thread on a
decision or answer: each is 409 archived once the page is found. Its
resolutions, seen marks and reads are as any page's.

A checklist's answer sends `checked`, the item ids the reader checked, in
place of `choice`: 400 invalid_body for a list that is not of distinct
strings, for `checked` to a decision and `choice` to a checklist, and 400
invalid_choice for an item the form does not offer. It is stored with the
items in the page's order and `choice` "", its kept label the change summary
(`summary()`). A new thread is checked against the page's comment boxes: 400 unknown_section for a section
the page has no box for, and 409 stale_page when it names a revision other
than the page's, so a quote is never stored against words it was not taken from.

An answer's note also opens a thread on its decision when the page has a
comment box after the decision's form: the note, not empty once trimmed and
not the note of the answer it replaces, is stored as the reader's comment
there, carrying `answer`, {id, choice, label} of the answer, and the 201
body carries it as `comment`, as a new thread's POST answers it. A later
note to the same question is a reply in the newest thread a note opened,
which it reopens if resolved. A note-less answer's body has no `comment`.

`{page, section: "", text}` opens a thread on the whole page rather than one
section: section "" (lotuspod.comments.WHOLE_PAGE), which no box carries, is
stored with section_title "". It takes no quote (400 invalid_body), and only
a page with section boxes takes it: 400 unknown_section on a page with no
comment boxes and on one whose only box is `page`, which already covers the
whole page. It is refused otherwise as any new thread is.

`{page, question, text}` opens a thread on one of the page's decisions
instead of a section: it is stored in the section whose comment box follows
the decision's form, and each comment in it carries `question`, the
decision's id, which no other comment has. It records no answer. It is
refused as a new thread is, and 400 unknown_question for a question the page
does not ask, checked before its section; it takes no quote.

Every reader's comment a route answers carries its routing state (see
lotuspod.routing): `state` is `pending`, `unavailable` or `paused` until an
agent takes it up, and `owner` is the handle it is routed to (null on an agent's reply).

`images` names 1 to MAX_IMAGES images the reader uploaded, by their stored
names, in the order they are shown: 400 invalid_body for anything else, and
400 unknown_image for a name not in the media store. A comment with images
may have empty text. Every comment a route answers carries `images`, each
{name, url, width, height}, an empty list when it has none; the comments
route's GET also answers `maxImageBytes`, the largest upload it takes.

POST /api/media takes one image as its body, with Content-Type image/png,
image/jpeg, image/webp or image/gif, and answers 201 {name, url, width,
height} once it is in the media store (lotuspod.media). It is refused, with
nothing stored: 403 cross_origin as any POST, 415 unsupported_media_type for
any other type, 411 without a length, 413 body_too_large over the store's
cap, 400 invalid_image when the bytes are not a whole image of the declared
type, and 429 too_many_uploads once the reader has had UPLOAD_LIMIT accepted
in the last UPLOAD_WINDOW seconds.

`{page, thread, resolved}` resolves the thread whose first comment is
`thread`, or reopens it, as the reader, and answers 200 {thread, resolution};
a row is stored only when it changes the resolution. A reader's reply to a
resolved thread reopens it.

A reader's actor leaves a route as {kind: human, name}: the name is the part
of their address before its last @, and the address itself never reaches a
page. The agents' socket (lotuspod.machine) still sees the address.
"""

from __future__ import annotations

import datetime
import json
import socket
import sqlite3
import threading
import time
import urllib.parse
from collections import deque
from dataclasses import dataclass, field
from email.message import Message
from http import HTTPStatus
from pathlib import Path
from typing import BinaryIO, Callable, Mapping, Sequence

from lotuspod import comments, db, media, routing, versions

ANSWERS = "/api/answers"
COMMENTS = "/api/comments"
MEDIA = "/api/media"
REVISION = "/api/revision"
SEEN = "/api/seen"
VERSIONS = "/api/versions"
CHANGES = "/api/changes"
ACTIVITY = "/api/activity"
ARCHIVE = "/api/archive"
ROUTES = (ANSWERS, COMMENTS, MEDIA, REVISION, SEEN, VERSIONS, CHANGES, ACTIVITY, ARCHIVE)
METHODS = ("GET", "HEAD", "POST")
# The methods of a route that is only read.
READ_METHODS = ("GET", "HEAD")

MAX_BODY = 16 << 10
MAX_NAME = 100
MAX_TEXT = 4000
MAX_EXACT = 500
MAX_CONTEXT = 32
MAX_REVISION = 100
# The images one comment may name.
MAX_IMAGES = 4
# Accepted uploads one reader may make in any UPLOAD_WINDOW seconds.
UPLOAD_LIMIT = 20
UPLOAD_WINDOW = 600
# The extension an upload's file name takes from its declared type, so
# media.check refuses bytes of another type.
UPLOAD_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp",
                "image/gif": "gif"}
# Seconds a request body may take to arrive.
BODY_TIMEOUT = 10
# A refused body up to this size is still read, and dropped: closing a
# connection with unread data resets it, and the reset can overtake the answer.
DRAIN_LIMIT = 64 << 10
# The days of activity one read of the activity route covers.
ACTIVITY_DAYS = 7
# The events one read of the activity route answers at most.
MAX_EVENTS = 500
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
    # Option values to their labels, in the page's order.
    labels: Mapping[str, str] = field(default_factory=dict)
    # The section of the first comment box after its form, where a thread on
    # it is filed; "" when the page has none.
    section: str = ""
    # A checklist's items checked by default, in the page's order; its
    # items are its choices and labels.
    defaults: tuple[str, ...] = ()
    checklist: bool = False
    # Its context lines as the card shows them, labels included, joined by
    # newlines; "" when it has none.
    context: str = ""
    # A decision's default option's value; "" when it has none, and for a
    # checklist.
    default: str = ""


def changes(labels: Mapping[str, str], defaults: Sequence[str],
            checked: Sequence[str]) -> list[dict]:
    """{id, label, checked} for each of a checklist's items (labels, ids to
    labels in the page's order) whose state in checked differs from its
    default, in the page's order."""
    on, was = set(checked), set(defaults)
    return [{"id": item, "label": label, "checked": item in on}
            for item, label in labels.items() if (item in on) != (item in was)]


def summary(changed: Sequence[Mapping]) -> str:
    """A checklist answer's changes as words: "On: LABEL, LABEL · Off:
    LABEL", either part left out when empty, or "No change from the
    defaults". The page script builds the same words."""
    on = [item["label"] for item in changed if item["checked"]]
    off = [item["label"] for item in changed if not item["checked"]]
    parts = ([f"On: {', '.join(on)}"] if on else []) + ([f"Off: {', '.join(off)}"] if off else [])
    return " · ".join(parts) or "No change from the defaults"


def asked_question(page: Page, question: str) -> Question:
    """The question page asks by that id; Refusal unknown_question when it
    asks none."""
    asked = page.questions.get(question)
    if asked is None:
        raise Refusal(HTTPStatus.BAD_REQUEST, "unknown_question")
    return asked


def chosen(asked: Question, choice: str) -> str:
    """The label of a decision's option choice; Refusal invalid_choice when
    its form offers none."""
    if choice not in asked.choices:
        raise Refusal(HTTPStatus.BAD_REQUEST, "invalid_choice")
    return asked.labels.get(choice, choice)


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
    # When it was archived, and the page that replaces it; "" when not.
    archived: str = ""
    superseded_by: str = ""


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


def _checked(value: object) -> list[str]:
    """value as a list of distinct strings; Refusal for anything else. An
    item's id is as long as its `#` cell's slug, so only the body's own limit
    holds it; whether the form offers each is checked against the form."""
    if not isinstance(value, list):
        raise _invalid()
    items = [_text(item, 0, MAX_BODY) for item in value]
    if len(set(items)) != len(items):
        raise _invalid()
    return items


def _image_names(value: object) -> list[str]:
    """value as 1 to MAX_IMAGES distinct stored names; Refusal for anything else."""
    if not isinstance(value, list) or not 1 <= len(value) <= MAX_IMAGES:
        raise _invalid()
    if not all(isinstance(name, str) and media.STORED_NAME.fullmatch(name) for name in value):
        raise _invalid()
    if len(set(value)) != len(value):
        raise _invalid()
    return value


def stored_images(media_dir: Path | None, names: list[str] | None) -> list[dict]:
    """Each stored image names names, as {name, width, height}; Refusal
    unknown_image when one is not in the media store media_dir."""
    if not names:
        return []
    if media_dir is None:
        raise Refusal(HTTPStatus.SERVICE_UNAVAILABLE, "storage_unavailable")
    found = []
    for name in names:
        image = media.load_stored(media_dir, name)
        if image is None:
            raise Refusal(HTTPStatus.BAD_REQUEST, "unknown_image")
        found.append({"name": name, "width": image.width, "height": image.height})
    return found


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


def named(actor: object) -> object:
    """A reader's actor as a page is shown it: {kind: human, name}, name the
    address's part before its last @; any other actor as it is."""
    if not isinstance(actor, Mapping) or actor.get("kind") != "human":
        return actor
    email = str(actor.get("email") or "")
    return {"kind": "human", "name": email.rsplit("@", 1)[0]}


def utc_time(text: str) -> datetime.datetime:
    """An ISO 8601 time, ending in Z or an offset; ValueError for anything
    else. Before Python 3.11, fromisoformat() takes no Z."""
    if text[-1:] in ("Z", "z"):
        text = text[:-1] + "+00:00"
    return datetime.datetime.fromisoformat(text)


def shown(value: object) -> object:
    """value, a route's payload, with every actor in it named."""
    if isinstance(value, Mapping):
        return {key: named(item) if key == "actor" else shown(item)
                for key, item in value.items()}
    if isinstance(value, list):
        return [shown(item) for item in value]
    return value


class Api:
    """The routes over one database; pages(name) is the Page serve
    would answer for name, or None; window is routing's owner window.
    media_dir is the media store and max_image_bytes its cap; without a
    store, uploads and comments naming images answer 503. history reads the
    pages' versions; without it every page has none. names() is the names
    of the pages serve answers, archived ones left out, whose versions the
    activity route reads. archive(name, archived, superseded_by) archives or
    unarchives a page (lotuspod.archive.set_archived), and owners are the
    readers who may; without it the archive route's POST answers 503."""

    def __init__(self, database: db.Database, pages: Callable[[str], Page | None],
                 window: float = routing.DEFAULT_WINDOW,
                 clock: Callable[[], float] = time.time,
                 media_dir: Path | None = None,
                 max_image_bytes: int = media.DEFAULT_MAX_BYTES,
                 history: versions.History | None = None,
                 names: Callable[[], Sequence[str]] = tuple,
                 archive: Callable[[str, bool, str | None], tuple] | None = None,
                 owners: frozenset[str] = frozenset()) -> None:
        self.database = database
        self.pages = pages
        self.window = window
        self.clock = clock
        self.media_dir = media_dir
        self.max_image_bytes = max_image_bytes
        self.history = history
        self.names = names
        self.archive = archive
        self.owners = owners
        # Each reader's accepted uploads, oldest first, kept in memory only.
        self._uploads: dict[str, deque[float]] = {}
        self._uploads_lock = threading.Lock()

    def answer(self, method: str, path: str, query: str, headers: Message,
               body: Body, actor: Mapping) -> Answer:
        """The answer to one request for path, one of ROUTES."""
        status, payload, extra = self._answer(method, path, query, headers, body, actor)
        return status, shown(payload), extra

    def _answer(self, method: str, path: str, query: str, headers: Message,
                body: Body, actor: Mapping) -> Answer:
        methods = READ_METHODS if path in (REVISION, VERSIONS, CHANGES, ACTIVITY) else METHODS
        if method not in methods:
            return (HTTPStatus.METHOD_NOT_ALLOWED, {"error": "method_not_allowed"},
                    (("Allow", ", ".join(methods)),))
        try:
            if path == MEDIA:
                if method != "POST":
                    return (HTTPStatus.METHOD_NOT_ALLOWED, {"error": "method_not_allowed"},
                            (("Allow", "POST"),))
                return HTTPStatus.CREATED, self._post_media(headers, body, actor), ()
            if method == "POST":
                if path == ANSWERS:
                    return HTTPStatus.CREATED, self._post_answer(headers, body, actor), ()
                fields = self._json_body(headers, body)
                if path == ARCHIVE:
                    return HTTPStatus.OK, self._post_archive(fields, actor), ()
                if path == SEEN:
                    return HTTPStatus.OK, self._post_seen(fields, actor), ()
                if "thread" in fields:
                    return HTTPStatus.OK, self._post_resolution(fields, actor), ()
                return HTTPStatus.CREATED, self._post_comment(fields, actor), ()
            if path == SEEN:
                return HTTPStatus.OK, self._seen(query, actor), ()
            if path == CHANGES:
                return HTTPStatus.OK, self._changes(query), ()
            if path == ACTIVITY:
                return HTTPStatus.OK, self._activity(query, actor), ()
            page = self._page(self._query(query, ("page",))["page"])
            if path == ANSWERS:
                payload = {"page": page.name, "questions": self.database.answers(page.name, asked=True)}
            elif path == ARCHIVE:
                payload = {"page": page.name, "archived": page.archived or None,
                           "supersededBy": page.superseded_by or None,
                           "mayArchive": str(actor.get("email") or "") in self.owners}
            elif path == REVISION:
                payload = {"revision": page.revision}
            elif path == VERSIONS:
                payload = {"page": page.name, "versions": self._versions(page.name)}
            else:
                threads = routing.threads(self.database, page.name, self.window, self.clock())
                payload = {"page": page.name, "revision": page.revision,
                           "threads": threads, "unread": self._unread(page, threads, actor),
                           "maxImageBytes": self.max_image_bytes}
            return HTTPStatus.OK, payload, ()
        except Refusal as exc:
            return exc.status, {"error": exc.error}, ()
        except (sqlite3.Error, OSError):
            return HTTPStatus.SERVICE_UNAVAILABLE, {"error": "storage_unavailable"}, ()

    def _versions(self, name: str) -> list[dict]:
        listed = self.history.listed(name) if self.history is not None else []
        return [{"commit": version.commit, "date": version.date, "revision": version.revision,
                 "current": at == 0, "summary": version.summary}
                for at, version in enumerate(listed)]

    def _window(self, query: str) -> tuple[str, str]:
        """The activity route's window, (from, to) as the database writes
        times: the ACTIVITY_DAYS days up to the query's `before`, else now."""
        fields = self._query(query, ("before",) if query else ())
        try:
            if fields:
                moment = utc_time(fields["before"])
                if moment.utcoffset() != datetime.timedelta(0):
                    raise ValueError("not UTC")
                end = moment.timestamp()
            else:
                end = self.clock()
            return db.stamp(end - ACTIVITY_DAYS * 86400), db.stamp(end)
        except (ValueError, OverflowError, OSError):
            raise Refusal(HTTPStatus.BAD_REQUEST, "invalid_query") from None

    def _activity(self, query: str, actor: Mapping) -> dict:
        start, end = self._window(query)
        found: dict[str, Page | None] = {}

        def served(name: str) -> Page | None:
            if name not in found:
                found[name] = self.pages(name)
            return found[name]

        # An archived page is left out, every event of it.
        def listed(name: str) -> bool:
            page = served(name)
            return page is not None and not page.archived

        events, older = self.database.activity(
            str(actor.get("email") or ""), start, end, listed, MAX_EVENTS + 1)
        truncated = False
        if self.history is not None:
            recent = self.history.recent(utc_time(start), utc_time(end), list(self.names()))
            older = older or recent.older
            truncated = recent.truncated
            for change in recent.changes:
                if not listed(change.name):
                    continue
                events.append({"page": change.name, "kind": "version",
                               # As the database writes times, so all sort as text.
                               "at": change.date[:-1] + ".000Z", "commit": change.commit,
                               "revision": change.revision, "actor": change.owner or None,
                               "first": change.first, "summary": change.summary})
            events.sort(key=lambda event: event["at"], reverse=True)
        truncated = truncated or len(events) > MAX_EVENTS
        pages: dict[str, dict] = {}
        for event in events[:MAX_EVENTS]:
            name = event.pop("page")
            page = served(name)
            # Only for the events kept, so no page is read for one left out.
            if event["kind"] == "version":
                event["current"] = page is not None and event["revision"] == page.revision
            entry = pages.setdefault(name, {"page": name, "title": page.title if page else name,
                                            "latest": event["at"], "events": []})
            entry["events"].append(event)
        return {"from": start, "to": end, "older": older, "truncated": truncated,
                "pages": list(pages.values())}

    def _post_archive(self, fields: dict, actor: Mapping) -> dict:
        if str(actor.get("email") or "") not in self.owners:
            raise Refusal(HTTPStatus.FORBIDDEN, "not_owner")
        _keys(fields, {"page", "archived"}, frozenset({"supersededBy"}))
        archived = fields["archived"]
        if not isinstance(archived, bool):
            raise _invalid()
        # Present at all, null included, it must name a page, and only an
        # archived page has one. A page name has no length of its own but
        # the body's, as `page` has.
        successor = None
        if "supersededBy" in fields:
            if not archived:
                raise _invalid()
            successor = _text(fields["supersededBy"], 1, MAX_BODY)
        page = self._page(fields["page"])
        if successor is not None and (successor == page.name or self.pages(successor) is None):
            raise Refusal(HTTPStatus.BAD_REQUEST, "unknown_successor")
        if self.archive is None:
            raise Refusal(HTTPStatus.SERVICE_UNAVAILABLE, "storage_unavailable")
        # A Refusal when the page or the successor has gone since; any other
        # failure has put back what it wrote.
        try:
            record, _ = self.archive(page.name, archived, successor)
        except Refusal:
            raise
        except RuntimeError:
            raise Refusal(HTTPStatus.SERVICE_UNAVAILABLE, "storage_unavailable") from None
        return {"page": page.name, "archived": record["archivedAt"] if record else None,
                "supersededBy": record["supersededBy"] if record else None,
                "mayArchive": True}

    def _changes(self, query: str) -> dict:
        fields = self._query(query, ("page", "since"))
        since = fields["since"]
        if not 1 <= len(since) <= MAX_REVISION:
            raise Refusal(HTTPStatus.BAD_REQUEST, "invalid_query")
        page = self._page(fields["page"])
        found = self.history.changes(page.name, since) if self.history is not None else None
        if found is None:
            raise Refusal(HTTPStatus.NOT_FOUND, "unknown_revision")
        version, behind, compared = found
        payload = {"page": page.name,
                   "since": {"commit": version.commit, "date": version.date,
                             "revision": version.revision},
                   "behind": behind,
                   "changed": compared is not None and since != page.revision}
        if payload["changed"]:
            payload.update(compared)
        return payload

    @staticmethod
    def _query(query: str, names: tuple[str, ...]) -> dict[str, str]:
        """The query's fields, exactly names and one value each."""
        try:
            fields = urllib.parse.parse_qs(query, keep_blank_values=True,
                                           strict_parsing=bool(query), errors="strict")
        except (ValueError, UnicodeDecodeError):
            fields = {}
        if sorted(fields) != sorted(names) or any(len(fields[name]) != 1 for name in names):
            raise Refusal(HTTPStatus.BAD_REQUEST, "invalid_query")
        return {name: fields[name][0] for name in names}

    def _page(self, name: object) -> Page:
        if not isinstance(name, str):
            raise _invalid()
        page = self.pages(name)
        if page is None:
            raise Refusal(HTTPStatus.NOT_FOUND, "unknown_page")
        return page

    def _open_page(self, name: object) -> Page:
        """The page named, as _page() finds it, refused 409 archived when it
        is archived: it takes no new comment, reply or answer."""
        page = self._page(name)
        if page.archived:
            raise Refusal(HTTPStatus.CONFLICT, "archived")
        return page

    @staticmethod
    def _json_body(headers: Message, body: Body) -> dict:
        if cross_origin(headers):
            raise Refusal(HTTPStatus.FORBIDDEN, "cross_origin")
        if _media_type(headers) != "application/json":
            raise Refusal(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "unsupported_media_type")
        return _json_object(body.read(MAX_BODY))

    def _post_media(self, headers: Message, body: Body, actor: Mapping) -> dict:
        if cross_origin(headers):
            raise Refusal(HTTPStatus.FORBIDDEN, "cross_origin")
        extension = UPLOAD_TYPES.get(_media_type(headers))
        if extension is None:
            raise Refusal(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "unsupported_media_type")
        if self.media_dir is None:
            raise Refusal(HTTPStatus.SERVICE_UNAVAILABLE, "storage_unavailable")
        reader = str(actor.get("email") or "")
        self._take_upload(reader, reserve=False)
        data = body.read(self.max_image_bytes)
        try:
            image = media.check(data, f"upload.{extension}", self.max_image_bytes)
        except media.MediaError:
            raise Refusal(HTTPStatus.BAD_REQUEST, "invalid_image") from None
        at = self._take_upload(reader, reserve=True)
        try:
            media.store(self.media_dir, image)
        except OSError:
            self._give_back(reader, at)
            raise
        return {"name": image.name, "url": image.url, "width": image.width,
                "height": image.height}

    def _take_upload(self, reader: str, reserve: bool) -> float:
        """Refusal too_many_uploads when reader has had UPLOAD_LIMIT uploads
        in the last UPLOAD_WINDOW seconds; with reserve, count one more now.
        The time it was counted at."""
        now = self.clock()
        with self._uploads_lock:
            times = self._uploads.setdefault(reader, deque())
            while times and times[0] <= now - UPLOAD_WINDOW:
                times.popleft()
            if len(times) >= UPLOAD_LIMIT:
                raise Refusal(HTTPStatus.TOO_MANY_REQUESTS, "too_many_uploads")
            if reserve:
                times.append(now)
            elif not times:
                del self._uploads[reader]
        return now

    def _give_back(self, reader: str, at: float) -> None:
        """Take back the upload counted for reader at `at`, never stored."""
        with self._uploads_lock:
            times = self._uploads.get(reader)
            if times is not None and at in times:
                times.remove(at)

    def _images(self, names: list[str] | None) -> list[dict]:
        return stored_images(self.media_dir, names)

    def _post_answer(self, headers: Message, body: Body, actor: Mapping) -> dict:
        fields = self._json_body(headers, body)
        # A checklist's answer sends checked in place of choice; which the
        # question takes is known only once it is found.
        checklist = "checked" in fields
        _keys(fields, {"page", "question", "version", "checked" if checklist else "choice",
                       "note"})
        question = _text(fields["question"], 1, MAX_NAME)
        version = _text(fields["version"], 1, MAX_NAME)
        if checklist:
            checked = _checked(fields["checked"])
        else:
            choice = _text(fields["choice"], 1, MAX_NAME)
        note = _text(fields["note"], 0, MAX_TEXT)
        page = self._open_page(fields["page"])
        asked = asked_question(page, question)
        if checklist != asked.checklist:
            raise _invalid()
        if version != asked.version:
            raise Refusal(HTTPStatus.CONFLICT, "stale")
        if checklist:
            if not set(checked) <= asked.choices:
                raise Refusal(HTTPStatus.BAD_REQUEST, "invalid_choice")
            # In the page's order, whatever order the reader sent.
            checked = [item for item in asked.labels if item in set(checked)]
            choice, label = "", summary(changes(asked.labels, asked.defaults, checked))
        else:
            checked, label = None, chosen(asked, choice)
        # A note opens a thread on the decision only where the page has a
        # comment box for it, as a question asked with Ask does.
        thread = None
        if asked.section in page.comment_sections:
            thread = {"section": asked.section,
                      "section_title": page.sections.get(asked.section, ""),
                      "owner": page.owner}
        stored = self.database.add_answer(
            page=page.name, question=question, version=version, choice=choice,
            note=note, revision=page.revision, actor=actor,
            question_text=asked.text, choice_label=label, checked=checked, thread=thread,
        )
        if "comment" in stored:
            stored["comment"] = routing.public(
                stored["comment"], routing.last_pulls(self.database), self.window,
                self.clock(), self.database.responder_paused())
        return stored

    def _unread(self, page: Page, threads: list[dict], actor: Mapping) -> list[int]:
        """The ids of the reader's unread comments on page, among the threads
        just read, so it never names a comment they do not hold: none on a
        page without comment boxes, whose threads the reader cannot open."""
        if not page.comment_sections:
            return []
        held = {row["id"] for thread in threads for row in (thread["root"], *thread["replies"])}
        unread = self.database.unread(str(actor.get("email") or ""), page.name).get(page.name, [])
        return [comment for comment in unread if comment in held]

    def _post_seen(self, fields: dict, actor: Mapping) -> dict:
        if "thread" in fields:
            return self._post_thread_seen(fields, actor)
        _keys(fields, {"page", "revision"})
        revision = _text(fields["revision"], 0, MAX_REVISION)
        page = self._page(fields["page"])
        # A page with no revision (rendered, never published) is opened at
        # its own, "": the index's tabs record it so. Any other page is
        # opened at a revision named.
        if not revision and page.revision:
            raise _invalid()
        previous = self.database.record_view(reader=str(actor.get("email") or ""),
                                             page=page.name, revision=revision)
        return {"page": page.name, "revision": revision, "previous": previous}

    def _seen(self, query: str, actor: Mapping) -> dict:
        if query:
            raise Refusal(HTTPStatus.BAD_REQUEST, "invalid_query")
        reader = str(actor.get("email") or "")
        views = self.database.page_views(reader)
        unread = self.database.unread(reader)
        pages = {}
        for name in sorted(views.keys() | unread.keys()):
            # A page serve no longer answers, hidden or gone, is left out.
            page = self.pages(name)
            # A page without comment boxes counts no unread replies, and is
            # left out when the reader never opened it.
            count = len(unread.get(name, [])) if page is not None and page.comment_sections else 0
            if page is not None and (name in views or count):
                view = views.get(name, {})
                pages[name] = {"revision": page.revision, "seen": view.get("revision"),
                               "seenAt": view.get("seenAt"), "replies": view.get("replies", 0),
                               "unread": count}
        return {"pages": pages}

    def _post_thread_seen(self, fields: dict, actor: Mapping) -> dict:
        _keys(fields, {"page", "thread", "comment"})
        thread = _id(fields["thread"])
        comment = _id(fields["comment"])
        page = self._page(fields["page"])
        try:
            stored = self.database.record_thread_view(
                reader=str(actor.get("email") or ""), page=page.name, thread=thread,
                comment=comment)
        except db.Refused as exc:
            raise Refusal(HTTPStatus.NOT_FOUND, exc.error) from None
        return {"thread": thread, "comment": stored}

    def _post_resolution(self, fields: dict, actor: Mapping) -> dict:
        _keys(fields, {"page", "thread", "resolved"})
        root = _id(fields["thread"])
        resolved = fields["resolved"]
        if not isinstance(resolved, bool):
            raise _invalid()
        page = self._page(fields["page"])
        try:
            resolution = self.database.resolve(root, page=page.name, resolved=resolved,
                                               actor=actor)
        except db.Refused as exc:
            raise Refusal(HTTPStatus.NOT_FOUND, exc.error) from None
        return {"thread": root, "resolution": resolution}

    def _post_comment(self, fields: dict, actor: Mapping) -> dict:
        row = self._store_comment(fields, actor)
        return routing.public(row, routing.last_pulls(self.database), self.window, self.clock(),
                              self.database.responder_paused())

    def _store_comment(self, fields: dict, actor: Mapping) -> dict:
        names = _image_names(fields["images"]) if "images" in fields else None
        # A comment with images may say nothing more.
        least = 0 if names else 1
        if "parent" in fields:
            _keys(fields, {"page", "parent", "text"}, frozenset({"images"}))
            parent = _id(fields["parent"])
            text = _text(fields["text"], least, MAX_TEXT)
            page = self._open_page(fields["page"])
            images = self._images(names)
            try:
                return self.database.add_reply(
                    page=page.name, parent=parent, revision=page.revision,
                    sections=page.sections, text=text, actor=actor, owner=page.owner,
                    images=images,
                )
            except db.UnknownParent:
                raise Refusal(HTTPStatus.NOT_FOUND, "unknown_parent") from None
        if "question" in fields and "section" not in fields:
            return self._store_decision_thread(fields, names, least, actor)
        _keys(fields, {"page", "section", "text"}, frozenset({"quote", "revision", "images"}))
        # A heading's id may be any length, and must match one of the page's
        # boxes exactly: the body's own limit is the only one it needs.
        # comments.WHOLE_PAGE, "", is the whole page, and matches no box.
        section = _text(fields["section"], 0, MAX_BODY)
        text = _text(fields["text"], least, MAX_TEXT)
        quote = _quote(fields.get("quote"))
        if section == comments.WHOLE_PAGE and quote is not None:
            raise _invalid()
        # The revision the reader's page was rendered at; absent when it had none.
        read = _text(fields["revision"], 0, MAX_REVISION) if "revision" in fields else None
        page = self._open_page(fields["page"])
        if section == comments.WHOLE_PAGE:
            # Only a page with section boxes takes one: a page whose only box
            # is comments.PAGE_SECTION already has its box for the whole page.
            if not page.comment_sections - {comments.PAGE_SECTION}:
                raise Refusal(HTTPStatus.BAD_REQUEST, "unknown_section")
        elif section not in page.comment_sections:
            raise Refusal(HTTPStatus.BAD_REQUEST, "unknown_section")
        if read is not None and read != page.revision:
            raise Refusal(HTTPStatus.CONFLICT, "stale_page")
        images = self._images(names)
        return self.database.add_comment(
            page=page.name, section=section, section_title=page.sections.get(section, ""),
            revision=page.revision, text=text, quote=quote, actor=actor, owner=page.owner,
            images=images,
        )

    def _store_decision_thread(self, fields: dict, names: list[str] | None, least: int,
                               actor: Mapping) -> dict:
        _keys(fields, {"page", "question", "text"}, frozenset({"revision", "images"}))
        question = _text(fields["question"], 1, MAX_NAME)
        text = _text(fields["text"], least, MAX_TEXT)
        read = _text(fields["revision"], 0, MAX_REVISION) if "revision" in fields else None
        page = self._open_page(fields["page"])
        asked = page.questions.get(question)
        if asked is None:
            raise Refusal(HTTPStatus.BAD_REQUEST, "unknown_question")
        if asked.section not in page.comment_sections:
            raise Refusal(HTTPStatus.BAD_REQUEST, "unknown_section")
        if read is not None and read != page.revision:
            raise Refusal(HTTPStatus.CONFLICT, "stale_page")
        images = self._images(names)
        return self.database.add_comment(
            page=page.name, section=asked.section,
            section_title=page.sections.get(asked.section, ""), revision=page.revision,
            text=text, quote=None, actor=actor, owner=page.owner, images=images,
            question=question,
        )
