"""Agents on the writer host: machine credentials and serve's local socket.

An agent is never a reader, and being on the same machine is not an
identity. The operator makes each agent a credential with `lotuspod
credential create`, bound to the owner handles it may act as and the
operations it may do; its token goes to a file only its owner can read, and
the database keeps only the token's SHA-256.

serve listens on a Unix socket (mode 0600, removed when serve stops) beside
its port, and answers only /v1/ paths there, each for a bearer token of a
credential that exists and is not revoked:

    GET  /v1/whoami                     the credential's name, handles, operations
    GET  /v1/check?op=OP&handle=HANDLE  whether it may do OP as HANDLE
    GET  /v1/pull?owner=HANDLE          the comments routed to HANDLE and the
                                        answers on its pages it has not
                                        acknowledged (needs pull for HANDLE)
    POST /v1/answers/ID/ack             the page's owner has answer ID (needs
                                        pull for that owner)
    POST /v1/answers/record             {page, question, choice, source[, note]}:
                                        a decision's answer given elsewhere
                                        (needs publish as the page's owner)
    GET  /v1/threads?page=NAME          the page's threads, as the reader's
                                        route answers them (needs pull)
    POST /v1/comments/ID/claim          take comment ID up, for claim_sec
                                        seconds (needs claim, and the handle
                                        it is routed to)
    POST /v1/media                      one image's bytes, stored as the
                                        reader's POST /api/media stores them
                                        (needs reply)
    POST /v1/comments/ID/reply          {claimToken, idempotencyKey, text[,
                                        revision, model, images]}: answer it
                                        under the claim, once per key (needs
                                        reply)
    POST /v1/comments/ID/release        {claimToken}: route it again (needs claim)
    POST /v1/comments/ID/fail           {claimToken, reason}: leave it failed
                                        (needs claim)
    POST /v1/threads/ID/resolve         resolve the thread whose first comment
    POST /v1/threads/ID/reopen          is ID, or reopen it (needs reply, and
                                        the page's owner or the handle its
                                        first comment is routed to)
    POST /v1/threads/ID/follow-up       {idempotencyKey, text[, revision,
                                        reopen, images]}: add a message to that
                                        thread with no claim, once per key
                                        (needs reply, as resolve does)

A pull records that HANDLE is listening and takes nothing off the queue: the
same items come back until they are claimed or acknowledged. A page's owner
also reads the comments routed to it as they arrived that have since passed
to the responder, until an agent takes them up; only the responder may claim
them. The pull is the only way a page's kept source leaves the host's files.

POST /v1/media takes one image as its body, with Content-Type image/png,
image/jpeg, image/webp or image/gif, and answers {name, url, width, height}
once it is in the media store. It is refused, with nothing stored, as the
reader's route refuses one: 415 unsupported_media_type, 411 length_required,
413 body_too_large over the store's cap, 400 invalid_image, and 503
storage_unavailable with no media store; it has no rate limit. A reply's or
follow-up's `images` names 1 to api.MAX_IMAGES uploaded images by their
stored names, in the order they are shown, as a reader's comment names them:
400 invalid_body for anything else and 400 unknown_image for a name not in
the media store. Its text is still required.

In the pull and threads answers, each image of each comment also carries
`path`: the absolute path of its file in the media directory, or null when
the file is no longer there, so an agent on this host reads its bytes there
(a file's name is the SHA-256 of its bytes). The reader's routes never carry it.

A pulled comment in a thread on a decision also carries `decision`: {id,
text, context, options, answer, asked}, the question as the page asks it now
(its context lines as the card shows them, labels included, joined by
newlines; its options each {value, label}, in the page's order), its current
answer as the answers route gives it with the reader's address, or null, and
whether the page still asks it; when it does not, text, context and options
are empty. An item for any other thread has no `decision`.

A pulled answer's `question` also carries `context`: the page's context for
the question while it asks it at the answer's version, and "" when
`reworded` is true. The context is not kept with the answer.

A pulled answer whose note the reader's page stored as a comment in a
thread on its decision also carries `noteComment`, that comment's id; the
comment carries `answer`, {id, choice, label} of the answer, and is pulled
as any comment is.

A pulled answer to a checklist also carries, in its `question`, `changed`:
{id, label, checked} for each item whose state differs from its default, in
the page's order, read against the page's form while it asks the checklist
at the answer's version, and null when `reworded` is true. Its `label` is the
change summary kept with the answer.

Each claim, reply, follow-up, release and failure is one database
transaction, written to the audit trail with the credential and handle that
acted. A claim is refused 409 claimed while another credential's is
current, 403 not_routed for a comment routed to none of the credential's
handles, and 409 settled once it is answered or failed; a reply, release or failure without the
credential's current claim and its token is 409 not_claimed. A reply's key
names it for good: the same credential sending the same key again gets the
reply stored the first time, its images included. A reply's model names the
model that wrote it, as the page shows beside the agent's handle: 1 to 40
printable characters with no space at either end.

A resolve or reopen acts as the page's owner when the credential holds it,
else as the handle the thread's first comment is routed to; it is refused
403 not_routed when the credential holds neither, and 404 unknown_thread
when ID is not a thread's first comment. It answers {thread, resolution},
and each change is one transaction, written to the audit trail.

A follow-up lets an agent that answered a thread bring a promised result
to it: it acts as a resolve does and is refused as one is, and answers the
message, stored as an agent's reply in the thread. It changes no comment's
state, so nothing is claimed, settled or routed again, and a resolved thread
stays resolved unless reopen is true. Its key names it for good, as a
reply's does, and its revision is checked as a reply's is.

POST /v1/answers/record stores an answer the page's owner gave somewhere
else, such as a chat or another page: an agent's answer, as that owner,
keeping where in `source` (1 to MAX_SOURCE characters). Its version,
question text and option label are the page's as it asks the decision now,
and its revision is the page's. It counts as answered wherever answers do,
supersedes the question's newest answer, and the owner has it acknowledged
already. The same option recorded again from the same source, at the same
version, is not stored again: it answers {answer, created: false} with the
answer stored first, and {answer, created: true} otherwise, the answer
carrying `asked` as the pull's do. It is refused, with nothing stored, in
this order: 400 invalid_body when page is missing or not a string, 404
unknown_page, 403 handle_not_allowed or operation_not_allowed, 400
invalid_body for any other missing or extra key or length, 400
unknown_question, 400 not_a_decision for a checklist, and
400 invalid_choice for an option the form does not offer. A reader's later
answer replaces it, as it replaces any.

No socket route writes a reader's answer, comment or resolution as the
reader, whatever the credential.
"""

from __future__ import annotations

import hashlib
import hmac
import http.client
import http.server
import json
import os
import re
import secrets
import socket
import socketserver
import sqlite3
import stat
import string
import time
import urllib.parse
from email.message import Message
from http import HTTPStatus
from pathlib import Path
from typing import Callable, Mapping

from lotuspod import api, db, media, routing

OPERATIONS = ("pull", "claim", "reply", "publish")
# An owner handle, and a credential's name: 1 to 63 lower-case letters,
# digits and hyphens, starting with a letter or digit.
_HANDLE = re.compile(r"[a-z0-9][a-z0-9-]{0,62}")
SOCKET_NAME = "lotuspod.sock"
CREDENTIAL_ENV = "LOTUSPOD_CREDENTIAL"
TOKEN_BYTES = 32

WHOAMI = "/v1/whoami"
CHECK = "/v1/check"
PULL = "/v1/pull"
THREADS = "/v1/threads"
MEDIA = "/v1/media"
RECORD = "/v1/answers/record"
ROUTES = (WHOAMI, CHECK, PULL, THREADS)
METHODS = ("GET", "HEAD")
# POST /v1/answers/ID/ack
_ACK = re.compile(r"/v1/answers/([1-9][0-9]{0,18})/ack")
# POST /v1/comments/ID/claim, /reply, /release and /fail
_COMMENT = re.compile(r"/v1/comments/([1-9][0-9]{0,18})/(claim|reply|release|fail)")
# POST /v1/threads/ID/resolve, /reopen and /follow-up
_THREAD = re.compile(r"/v1/threads/([1-9][0-9]{0,18})/(resolve|reopen|follow-up)")
ACK_METHODS = ("POST",)
# Characters of a claim token or an idempotency key, and of a failure's reason.
MAX_KEY = 200
MAX_REASON = 200
# Characters of the model a reply names.
MAX_MODEL = 40
# Characters of where a recorded answer was given.
MAX_SOURCE = 200
CLAIM_BYTES = 32
# The HTTP status of each refusal a claim, reply, release, failure or resolution meets.
_REFUSED = {
    "unknown_comment": HTTPStatus.NOT_FOUND,
    "unknown_thread": HTTPStatus.NOT_FOUND,
    "unknown_page": HTTPStatus.NOT_FOUND,
    "not_routed": HTTPStatus.FORBIDDEN,
    "settled": HTTPStatus.CONFLICT,
    "claimed": HTTPStatus.CONFLICT,
    "not_claimed": HTTPStatus.CONFLICT,
    "revision_mismatch": HTTPStatus.CONFLICT,
}
# Seconds a socket connection may sit idle.
REQUEST_TIMEOUT = 30

# Headers on every socket answer.
_HEADERS = (
    ("Content-Type", "application/json"),
    ("Cache-Control", "no-store"),
    ("X-Content-Type-Options", "nosniff"),
)


class CredentialError(ValueError):
    """A credential that cannot be made, or a token file that cannot be read."""


class SocketInUse(RuntimeError):
    """Something already answers on the socket path, or it is not a socket."""


def is_handle(value: str) -> bool:
    return _HANDLE.fullmatch(value) is not None


def token_hash(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8", "replace")).hexdigest()


def claim_token() -> str:
    """A new claim token. token_urlsafe's alphabet holds "-", and a token
    starting with one reads as an option to `--claim TOKEN`, so a leading
    "-" becomes a letter; the length and alphabet stay as they were."""
    token = secrets.token_urlsafe(CLAIM_BYTES)
    if token.startswith("-"):
        token = secrets.choice(string.ascii_letters) + token[1:]
    return token


def is_model(value: object) -> bool:
    """Whether value may name a reply's model: a string of 1 to MAX_MODEL
    characters, every one printable, with no space at either end."""
    return (isinstance(value, str) and 1 <= len(value) <= MAX_MODEL and value.isprintable()
            and value == value.strip(" "))


def _unique(values: list[str]) -> list[str]:
    return list(dict.fromkeys(values))


def create_credential(database: db.Database, name: str, handles: list[str],
                      operations: list[str], out: Path) -> dict:
    """Make the credential name, write its token to out (mode 0600, never
    over an existing file) and store it; CredentialError, with nothing
    stored and no file changed, when any part is not allowed."""
    if not is_handle(name):
        raise CredentialError(
            f"credential name {name!r} is not 1 to 63 lower-case letters, digits and "
            "hyphens starting with a letter or digit"
        )
    if not handles:
        raise CredentialError("a credential needs at least one --handle")
    if not operations:
        raise CredentialError("a credential needs at least one --op")
    for handle in handles:
        if not is_handle(handle):
            raise CredentialError(
                f"handle {handle!r} is not 1 to 63 lower-case letters, digits and "
                "hyphens starting with a letter or digit"
            )
    for operation in operations:
        if operation not in OPERATIONS:
            raise CredentialError(
                f"operation {operation!r} is not one of {', '.join(OPERATIONS)}"
            )
    token = secrets.token_urlsafe(TOKEN_BYTES)
    # The file is claimed before the database is opened: opening it may
    # migrate its schema, and a refused create changes nothing.
    try:
        fd = os.open(out, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    except FileExistsError:
        raise CredentialError(f"{out} already exists; not overwriting it") from None
    except OSError as exc:
        raise CredentialError(f"cannot write {out}: {exc.strerror}") from None
    try:
        with os.fdopen(fd, "w", encoding="ascii") as fh:
            os.fchmod(fh.fileno(), 0o600)
            fh.write(token + "\n")
        row = database.add_credential(
            name=name, handles=_unique(handles), operations=_unique(operations),
            token_hash=token_hash(token),
        )
    except BaseException as exc:
        os.unlink(out)
        if isinstance(exc, db.DuplicateCredential):
            raise CredentialError(f"a credential named {name!r} already exists") from None
        raise
    return public(row)


def public(credential: Mapping) -> dict:
    """What may be shown of a credential: everything but its token's hash."""
    return {key: value for key, value in credential.items() if key != "tokenHash"}


def find(database: db.Database, token: str) -> dict | None:
    """The unrevoked credential whose token this is; None when there is none."""
    digest = token_hash(token)
    found = None
    for credential in database.credentials():
        if hmac.compare_digest(credential["tokenHash"], digest):
            found = credential
    if found is None or found["revokedAt"] is not None:
        return None
    return found


def authorize(credential: Mapping, operation: str, handle: str) -> str | None:
    """The rule for every agent route: None when the credential may do
    operation on behalf of handle, else the refusal's error."""
    if handle not in credential["handles"]:
        return "handle_not_allowed"
    if operation not in credential["operations"]:
        return "operation_not_allowed"
    return None


def check_owner(database: db.Database, token: str, handle: str) -> dict:
    """The credential of token when it may publish as handle;
    CredentialError naming the problem when it may not."""
    credential = find(database, token)
    if credential is None:
        raise CredentialError("the credential is unknown or revoked")
    error = authorize(credential, "publish", handle)
    if error == "handle_not_allowed":
        raise CredentialError(
            f"credential {credential['name']} may not act as {handle} "
            f"(its handles: {', '.join(credential['handles'])})"
        )
    if error is not None:
        raise CredentialError(f"credential {credential['name']} may not publish")
    return credential


def bearer(headers: Message) -> str | None:
    """The token of the request's one Authorization: Bearer header."""
    values = headers.get_all("Authorization") or []
    if len(values) != 1:
        return None
    scheme, _, token = values[0].strip().partition(" ")
    token = token.strip()
    if scheme.lower() != "bearer" or not token:
        return None
    return token


def _no_page(name: str) -> api.Page | None:
    return None


class Routes:
    """The socket's routes over one database.

    pages(name) is the Page serve would answer for name, or None, and
    describe(page) the page as a pulled item shows it, its kept source
    included; window is routing's owner window, and claim_sec how long a
    claim lasts. media_dir is the media store comments' images are found
    in, and max_image_bytes the largest image it takes; without one, no
    image has a path and none is taken.
    """

    def __init__(self, database: db.Database,
                 pages: Callable[[str], api.Page | None] = _no_page,
                 describe: Callable[[api.Page], dict] | None = None,
                 window: float = routing.DEFAULT_WINDOW,
                 clock: Callable[[], float] = time.time,
                 claim_sec: float = routing.DEFAULT_CLAIM,
                 media_dir: Path | None = None,
                 max_image_bytes: int = media.DEFAULT_MAX_BYTES) -> None:
        self.database = database
        self.media_dir = media_dir
        self.max_image_bytes = max_image_bytes
        self.pages = pages
        self.describe = describe or _describe
        self.window = window
        self.clock = clock
        self.claim_sec = claim_sec

    def answer(self, method: str, target: str, headers: Message,
               body: api.Body | None = None) -> api.Answer:
        """The answer to one request for target, a path and query; body is
        the request's, which only the comment and media routes read."""
        token = bearer(headers)
        try:
            credential = None if token is None else find(self.database, token)
        except (sqlite3.Error, OSError):
            return HTTPStatus.SERVICE_UNAVAILABLE, {"error": "storage_unavailable"}, ()
        if credential is None:
            return HTTPStatus.UNAUTHORIZED, {"error": "invalid_credential"}, ()
        path, _, query = target.split("#", 1)[0].partition("?")
        ack = _ACK.fullmatch(path)
        acting = _COMMENT.fullmatch(path)
        resolving = _THREAD.fullmatch(path)
        if (path not in ROUTES and path not in (MEDIA, RECORD) and ack is None
                and acting is None and resolving is None):
            return HTTPStatus.NOT_FOUND, {"error": "not_found"}, ()
        allowed = METHODS if path in ROUTES else ACK_METHODS
        if method not in allowed:
            return (HTTPStatus.METHOD_NOT_ALLOWED, {"error": "method_not_allowed"},
                    (("Allow", ", ".join(allowed)),))
        try:
            if path == WHOAMI:
                return HTTPStatus.OK, {"credential": public(credential)}, ()
            if path == CHECK:
                fields = _query(query, ("op", "handle"))
                error = authorize(credential, fields["op"], fields["handle"])
                if error is not None:
                    raise api.Refusal(HTTPStatus.FORBIDDEN, error)
                return HTTPStatus.OK, {"allowed": True, **fields}, ()
            if path == PULL:
                return HTTPStatus.OK, self._pull(credential, _query(query, ("owner",))["owner"]), ()
            if path == THREADS:
                return HTTPStatus.OK, self._threads(credential, _query(query, ("page",))["page"]), ()
            if path == MEDIA:
                return HTTPStatus.OK, self._media(credential, headers, body), ()
            if path == RECORD:
                return HTTPStatus.OK, self._record(credential, headers, body), ()
            if acting is not None:
                return HTTPStatus.OK, self._act(credential, int(acting.group(1)),
                                                acting.group(2), headers, body), ()
            if resolving is not None and resolving.group(2) == "follow-up":
                return HTTPStatus.OK, self._follow_up(credential, int(resolving.group(1)),
                                                      headers, body), ()
            if resolving is not None:
                return HTTPStatus.OK, self._resolve(credential, int(resolving.group(1)),
                                                    resolving.group(2) == "resolve"), ()
            return HTTPStatus.OK, self._ack(credential, int(ack.group(1))), ()
        except api.Refusal as exc:
            return exc.status, {"error": exc.error}, ()
        except db.Refused as exc:
            return _REFUSED[exc.error], {"error": exc.error}, ()
        except (sqlite3.Error, OSError):
            return HTTPStatus.SERVICE_UNAVAILABLE, {"error": "storage_unavailable"}, ()

    def _page(self, name: str) -> api.Page | None:
        return self.pages(name) if isinstance(name, str) else None

    def _pull(self, credential: Mapping, owner: str) -> dict:
        _allow(credential, "pull", owner)
        pulled_at = self.database.record_pull(owner)
        pulls = routing.last_pulls(self.database)
        paused = self.database.responder_paused()
        now = self.clock()
        pages: dict[str, api.Page | None] = {}
        described: dict[str, dict] = {}
        answered: dict[str, dict] = {}

        def page_of(name: str) -> api.Page | None:
            if name not in pages:
                pages[name] = self._page(name)
            return pages[name]

        def item_page(page: api.Page) -> dict:
            if page.name not in described:
                described[page.name] = self.describe(page)
            return described[page.name]

        def decision(page: api.Page, question: str) -> dict:
            if page.name not in answered:
                answered[page.name] = self.database.answers(page.name)
            current = answered[page.name].get(question, {}).get("current")
            asked = page.questions.get(question)
            return {"id": question, "text": "" if asked is None else asked.text,
                    "context": "" if asked is None else asked.context,
                    "options": [] if asked is None else [
                        {"value": value, "label": label}
                        for value, label in asked.labels.items()],
                    "answer": current, "asked": asked is not None}

        items = []
        for comment in self.database.open_comments():
            routed = routing.route(comment, pulls, self.window, now, paused)
            # A current claim takes it off the queue; a lapsed one does not.
            if routed is None or routed[1] not in routing.WAITING:
                continue
            # The owner it was routed to as it arrived still reads it, but
            # does not hold it past the window.
            if owner not in (routed[0], routing.arrival_owner(comment, self.window)):
                continue
            # A comment on a page serve no longer answers waits for it.
            page = page_of(comment["page"])
            if page is None:
                continue
            root = comment["id"] if comment["parent"] is None else comment["parent"]
            found = self.database.thread(root)
            omitted = max(0, len(found["replies"]) - routing.THREAD_TAIL)
            item = {
                "kind": "comment",
                "comment": self._located(
                    routing.public(comment, pulls, self.window, now, paused)),
                # The thread's first comment and its latest replies, oldest first.
                "thread": [self._located(routing.public(row, pulls, self.window, now, paused))
                           for row in (found["root"], *found["replies"][omitted:])],
                "omitted": omitted,
                # The thread's resolution: a comment in a resolved thread still waits.
                "resolution": found["resolution"],
                "page": item_page(page),
            }
            if "question" in found["root"]:
                item["decision"] = decision(page, found["root"]["question"])
            items.append(item)
        for found in self.database.unacknowledged_answers(owner):
            answer, kept = found["answer"], found["asked"]
            page = page_of(answer["page"])
            if page is None or page.owner != owner:
                continue
            asked = page.questions.get(answer["question"])
            # Whether the page now asks it in other words, or not at all.
            reworded = asked is None or asked.version != answer["version"]
            text, label = kept["text"], kept["label"]
            # A checklist's items changed from their defaults, read against
            # the page's form only while it asks at the answer's version.
            changed = None
            if "checked" in answer and not reworded:
                changed = api.changes(asked.labels, asked.defaults, answer["checked"])
            if text is None:
                # Stored before the words were kept: the page's own words are
                # the answered ones only while its version is the same.
                text = "" if reworded else asked.text
                label = answer["choice"] if reworded else asked.labels.get(
                    answer["choice"], answer["choice"])
            # The question's default while the page asks it at the answer's
            # version; a checklist's defaults are in changed.
            default = None
            if not reworded and asked.default and "checked" not in answer:
                default = {"value": asked.default,
                           "label": asked.labels.get(asked.default, asked.default)}
            # The question and choice in the words the reader answered.
            question = {"id": answer["question"], "text": text,
                        "context": "" if reworded else asked.context, "label": label,
                        "reworded": reworded, "default": default}
            if "checked" in answer:
                question["changed"] = changed
            item = {
                "kind": "answer",
                "answer": answer,
                "question": question,
                "page": item_page(page),
            }
            # The comment holding its note, in a thread on the decision.
            if found["comment"] is not None:
                item["noteComment"] = found["comment"]
            items.append(item)
        return {"owner": owner, "pulledAt": pulled_at, "items": items}

    def _threads(self, credential: Mapping, name: str) -> dict:
        if "pull" not in credential["operations"]:
            raise api.Refusal(HTTPStatus.FORBIDDEN, "operation_not_allowed")
        page = self._page(name)
        if page is None:
            raise api.Refusal(HTTPStatus.NOT_FOUND, "unknown_page")
        threads = routing.threads(self.database, page.name, self.window, self.clock())
        for thread in threads:
            thread["root"] = self._located(thread["root"])
            thread["replies"] = [self._located(row) for row in thread["replies"]]
        return {"page": page.name, "threads": threads}

    def _located(self, row: dict) -> dict:
        """row with each image's path on this host: its file in the media
        directory, or None when it is not there."""
        images = []
        for image in row.get("images") or ():
            stored = None if self.media_dir is None else media.stored_file(
                self.media_dir, image["name"])
            images.append({**image, "path": None if stored is None else str(stored)})
        return {**row, "images": images}

    def _media(self, credential: Mapping, headers: Message, body: api.Body | None) -> dict:
        """Check and store one image, as the reader's media route does."""
        _allow_op(credential, "reply")
        extension = api.UPLOAD_TYPES.get(api._media_type(headers))
        if extension is None:
            raise api.Refusal(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "unsupported_media_type")
        if self.media_dir is None:
            raise api.Refusal(HTTPStatus.SERVICE_UNAVAILABLE, "storage_unavailable")
        if body is None:
            raise api.Refusal(HTTPStatus.LENGTH_REQUIRED, "length_required")
        data = body.read(self.max_image_bytes)
        try:
            image = media.check(data, f"upload.{extension}", self.max_image_bytes)
        except media.MediaError:
            raise api.Refusal(HTTPStatus.BAD_REQUEST, "invalid_image") from None
        media.store(self.media_dir, image)
        return {"name": image.name, "url": image.url, "width": image.width,
                "height": image.height}

    def _images(self, fields: dict) -> Callable[[], list[dict]]:
        """What looks up the stored images a message's fields name, as a
        reader's comment names them, once the database knows its key is new;
        none without `images`. The names' form is checked now."""
        names = api._image_names(fields["images"]) if "images" in fields else None
        return lambda: api.stored_images(self.media_dir, names)

    def _ack(self, credential: Mapping, answer_id: int) -> dict:
        answer = self.database.answer(answer_id)
        if answer is None:
            raise api.Refusal(HTTPStatus.NOT_FOUND, "unknown_answer")
        page = self._page(answer["page"])
        if page is None:
            raise api.Refusal(HTTPStatus.NOT_FOUND, "unknown_page")
        # A page with no owner is no handle's to acknowledge.
        _allow(credential, "pull", page.owner)
        acked_at = self.database.acknowledge_answer(answer_id, page.owner)
        return {"answer": answer_id, "owner": page.owner, "ackedAt": acked_at}

    def _record(self, credential: Mapping, headers: Message, body: api.Body | None) -> dict:
        """Store a decision's answer given elsewhere, as the page's owner."""
        fields = _json_body(headers, body)
        # With no page named, there is none to look up: the body is wrong.
        if not isinstance(fields.get("page"), str):
            raise api.Refusal(HTTPStatus.BAD_REQUEST, "invalid_body")
        page = self._page(fields["page"])
        if page is None:
            raise api.Refusal(HTTPStatus.NOT_FOUND, "unknown_page")
        # A page with no owner is no handle's to answer for.
        _allow(credential, "publish", page.owner)
        api._keys(fields, {"page", "question", "choice", "source"}, frozenset({"note"}))
        question = api._text(fields["question"], 1, api.MAX_NAME)
        choice = api._text(fields["choice"], 1, api.MAX_NAME)
        source = api._text(fields["source"], 1, MAX_SOURCE)
        note = api._text(fields.get("note", ""), 0, api.MAX_TEXT)
        asked = api.asked_question(page, question)
        if asked.checklist:
            raise api.Refusal(HTTPStatus.BAD_REQUEST, "not_a_decision")
        label = api.chosen(asked, choice)
        answer, created = self.database.record_answer(
            page=page.name, question=question, version=asked.version, choice=choice,
            note=note, revision=page.revision, owner=page.owner,
            credential=credential["name"], source=source, question_text=asked.text,
            choice_label=label,
        )
        return {"answer": answer, "created": created}


    def _act(self, credential: Mapping, comment_id: int, action: str,
             headers: Message, body: api.Body | None) -> dict:
        """Claim, reply to, release or fail comment comment_id."""
        _allow_op(credential, "reply" if action == "reply" else "claim")
        if action == "claim":
            return self._claim(credential, comment_id)
        fields = _json_body(headers, body)
        required = {"reply": {"claimToken", "idempotencyKey", "text"},
                    "release": {"claimToken"},
                    "fail": {"claimToken", "reason"}}[action]
        api._keys(fields, required,
                  frozenset({"revision", "model", "images"} if action == "reply" else ()))
        token = token_hash(api._text(fields["claimToken"], 1, MAX_KEY))
        name = credential["name"]
        if action == "release":
            row = self.database.release(comment_id, credential=name, token_hash=token,
                                        clock=self.clock)
            return self._shown(row)
        if action == "fail":
            reason = api._text(fields["reason"], 1, MAX_REASON)
            row = self.database.fail(comment_id, credential=name, token_hash=token,
                                     clock=self.clock, reason=reason)
            return self._shown(row)
        key = api._text(fields["idempotencyKey"], 1, MAX_KEY)
        text = api._text(fields["text"], 1, api.MAX_TEXT)
        revision = fields.get("revision")
        if revision is not None:
            revision = api._text(revision, 1, api.MAX_NAME)
        model = fields.get("model")
        if "model" in fields and not is_model(model):
            raise api.Refusal(HTTPStatus.BAD_REQUEST, "invalid_body")
        images = self._images(fields)
        row = self.database.reply(comment_id, credential=name, token_hash=token, key=key,
                                  text=text, revision=revision, model=model, clock=self.clock,
                                  page_of=self._current, images_of=images)
        return self._shown(row)

    def _thread_handle(self, credential: Mapping, root: int) -> tuple[api.Page, str]:
        """The page of the thread whose first comment is root, and the handle
        credential acts on it as: the page's owner when it holds it, else the
        handle the first comment is routed to."""
        _allow_op(credential, "reply")
        found = self.database.comment(root)
        if found is None or found["parent"] is not None:
            raise api.Refusal(HTTPStatus.NOT_FOUND, "unknown_thread")
        page = self._page(found["page"])
        if page is None:
            raise api.Refusal(HTTPStatus.NOT_FOUND, "unknown_page")
        routed = self._shown(found)["owner"]
        if page.owner and page.owner in credential["handles"]:
            return page, page.owner
        if routed in credential["handles"]:
            return page, routed
        raise api.Refusal(HTTPStatus.FORBIDDEN, "not_routed")

    def _resolve(self, credential: Mapping, root: int, resolved: bool) -> dict:
        """Resolve or reopen the thread whose first comment is root."""
        page, handle = self._thread_handle(credential, root)
        actor = {"kind": "agent", "handle": handle, "credential": credential["name"]}
        resolution = self.database.resolve(root, page=page.name, resolved=resolved,
                                           actor=actor, credential=credential["name"])
        return {"thread": root, "resolution": resolution}

    def _follow_up(self, credential: Mapping, root: int, headers: Message,
                   body: api.Body | None) -> dict:
        """Add credential's message to the thread whose first comment is root."""
        _page, handle = self._thread_handle(credential, root)
        fields = _json_body(headers, body)
        api._keys(fields, {"idempotencyKey", "text"},
                  frozenset({"revision", "reopen", "images"}))
        key = api._text(fields["idempotencyKey"], 1, MAX_KEY)
        text = api._text(fields["text"], 1, api.MAX_TEXT)
        revision = fields.get("revision")
        if revision is not None:
            revision = api._text(revision, 1, api.MAX_NAME)
        reopen = fields.get("reopen", False)
        if not isinstance(reopen, bool):
            raise api.Refusal(HTTPStatus.BAD_REQUEST, "invalid_body")
        images = self._images(fields)
        row = self.database.follow_up(root, credential=credential["name"], handle=handle,
                                      key=key, text=text, revision=revision, reopen=reopen,
                                      page_of=self._current, images_of=images)
        return self._shown(row)

    def _current(self, name: str) -> dict | None:
        """The page's revision, as a pull gives it, and its sections; None
        when serve would not answer it."""
        page = self._page(name)
        if page is None:
            return None
        return {"revision": self.describe(page)["revision"], "sections": page.sections}

    def _claim(self, credential: Mapping, comment_id: int) -> dict:
        found = self.database.comment(comment_id)
        # A comment on a page serve no longer answers is no one's to claim.
        if found is not None and self._page(found["page"]) is None:
            raise api.Refusal(HTTPStatus.NOT_FOUND, "unknown_page")

        def route(comment: dict, pulls: dict[str, str], now: float) -> str | None:
            last = {handle: routing.seconds(stamp) for handle, stamp in pulls.items()}
            routed = routing.route(comment, last, self.window, now)
            return None if routed is None else routed[0]

        token = claim_token()
        row = self.database.claim(
            comment_id, credential=credential["name"], handles=credential["handles"],
            token_hash=token_hash(token), claim_sec=self.claim_sec, clock=self.clock,
            route=route,
        )
        return {"comment": row["id"], "handle": row["claim"]["handle"],
                "claimToken": token, "expiresAt": row["claim"]["expiresAt"]}

    def _shown(self, row: dict) -> dict:
        """A comment as the threads routes show it."""
        return routing.public(row, routing.last_pulls(self.database), self.window,
                              self.clock(), self.database.responder_paused())


def _json_body(headers: Message, body: api.Body | None) -> dict:
    """The request's JSON object; Refusal as the /api routes refuse one."""
    if body is None:
        raise api.Refusal(HTTPStatus.LENGTH_REQUIRED, "length_required")
    if (headers.get("Content-Type") or "").split(";", 1)[0].strip().lower() != "application/json":
        raise api.Refusal(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, "unsupported_media_type")
    return api._json_object(body.read(api.MAX_BODY))


def _allow_op(credential: Mapping, operation: str) -> None:
    if operation not in credential["operations"]:
        raise api.Refusal(HTTPStatus.FORBIDDEN, "operation_not_allowed")


def _describe(page: api.Page) -> dict:
    """A page as a pulled item shows it, when serve names no source."""
    return {"name": page.name, "title": page.title, "owner": page.owner,
            "revision": page.revision, "sourceFile": "", "source": ""}


def _allow(credential: Mapping, operation: str, handle: str) -> None:
    error = authorize(credential, operation, handle)
    if error is not None:
        raise api.Refusal(HTTPStatus.FORBIDDEN, error)


def _query(query: str, names: tuple[str, ...]) -> dict:
    """The fields of a query naming each of names exactly once and nothing
    else; Refusal invalid_query otherwise."""
    try:
        fields = urllib.parse.parse_qs(query, keep_blank_values=True,
                                       strict_parsing=bool(query), errors="strict")
    except (ValueError, UnicodeDecodeError):
        fields = {}
    if sorted(fields) != sorted(names) or any(len(v) != 1 for v in fields.values()):
        raise api.Refusal(HTTPStatus.BAD_REQUEST, "invalid_query")
    return {name: fields[name][0] for name in names}


class _Handler(http.server.BaseHTTPRequestHandler):
    """Every request is answered in parse_request, before method dispatch,
    so every method meets the credential check."""

    server: SocketServer
    server_version = "lotuspod"
    timeout = REQUEST_TIMEOUT

    def address_string(self) -> str:
        # A Unix socket's peer has no address.
        return "socket"

    def parse_request(self) -> bool:
        if not super().parse_request():
            return False
        body = api.Body(self.rfile, self.connection, self.headers)
        status, payload, headers = self.server.routes.answer(
            self.command, self.path, self.headers, body
        )
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        for header, value in (*_HEADERS, *headers):
            self.send_header(header, value)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(data)
        self.wfile.flush()
        # Only once the answer is out: a body left unread would reset it.
        body.discard()
        return False


def clear_stale(path: Path) -> None:
    """Remove a socket file at path that nothing answers on; SocketInUse
    when something does, or when path is not a socket."""
    try:
        mode = os.lstat(path).st_mode
    except FileNotFoundError:
        return
    if not stat.S_ISSOCK(mode):
        raise SocketInUse(f"{path} exists and is not a socket")
    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        probe.connect(str(path))
    except ConnectionRefusedError:
        os.unlink(path)
        return
    except FileNotFoundError:
        return
    finally:
        probe.close()
    raise SocketInUse(f"something already answers on {path}")


class SocketServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    """The socket's server: made with mode 0600, removed when closed."""

    daemon_threads = True

    def __init__(self, path: Path | str, database: db.Database,
                 pages: Callable[[str], api.Page | None] = _no_page,
                 describe: Callable[[api.Page], dict] | None = None,
                 window: float = routing.DEFAULT_WINDOW,
                 claim_sec: float = routing.DEFAULT_CLAIM,
                 media_dir: Path | None = None,
                 max_image_bytes: int = media.DEFAULT_MAX_BYTES) -> None:
        self.path = Path(path)
        self.routes = Routes(database, pages, describe, window, claim_sec=claim_sec,
                             media_dir=media_dir, max_image_bytes=max_image_bytes)
        self._inode: int | None = None
        clear_stale(self.path)
        # Never, even briefly, readable or writable by anyone else.
        mask = os.umask(0o177)
        try:
            super().__init__(str(self.path), _Handler)
        finally:
            os.umask(mask)
        self._inode = os.lstat(self.path).st_ino

    def server_close(self) -> None:
        super().server_close()
        inode, self._inode = self._inode, None
        if inode is None:
            return
        try:
            found = os.lstat(self.path)
        except FileNotFoundError:
            return
        # Only the socket this server made, never one another serve made since.
        if found.st_ino == inode and stat.S_ISSOCK(found.st_mode):
            os.unlink(self.path)


def read_token(path: Path | str) -> str:
    """The token in a credential file; CredentialError when there is none."""
    try:
        text = Path(path).read_text(encoding="ascii")
    except (OSError, UnicodeDecodeError) as exc:
        raise CredentialError(f"cannot read credential {path}: {exc}") from None
    token = text.strip()
    if not token or len(token.split()) != 1:
        raise CredentialError(f"credential {path} does not hold one token")
    return token


class UnixConnection(http.client.HTTPConnection):
    """HTTP to serve's socket."""

    def __init__(self, path: Path | str, timeout: float = REQUEST_TIMEOUT) -> None:
        super().__init__("localhost", timeout=timeout)
        self.socket_path = str(path)

    def connect(self) -> None:
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.settimeout(self.timeout)
        try:
            sock.connect(self.socket_path)
        except OSError:
            sock.close()
            raise
        self.sock = sock


def request(path: Path | str, token: str | None, method: str, target: str,
            body: object = None, content_type: str | None = None,
            timeout: float = REQUEST_TIMEOUT) -> tuple[int, dict]:
    """(status, JSON payload) of one request on the socket at path, each
    socket operation bounded by timeout seconds. body is sent as JSON, or,
    with content_type, as its own bytes of that type."""
    headers = {}
    if token is not None:
        headers["Authorization"] = f"Bearer {token}"
    data = None
    if content_type is not None:
        data = body
        headers["Content-Type"] = content_type
    elif body is not None:
        data = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    conn = UnixConnection(path, timeout)
    try:
        try:
            conn.request(method, target, body=data, headers=headers)
        except (BrokenPipeError, ConnectionResetError):
            # serve refused the body before reading all of it (one over the
            # media cap): its answer may still be there to read.
            if conn.sock is None:
                raise
        response = conn.getresponse()
        payload = response.read()
    finally:
        conn.close()
    return response.status, json.loads(payload.decode("utf-8")) if payload else {}
