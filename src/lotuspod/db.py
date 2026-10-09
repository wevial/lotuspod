"""The reader's answers and comments: one SQLite file beside the artifacts.

The database never sits in the output directory (the artifacts repository
commits everything there). Its schema is made on first open and versioned
with PRAGMA user_version; ids come from AUTOINCREMENT, so an id is never
given out twice, even after a row is gone. serve answers each request on its
own thread, so every request opens its own connection: WAL mode lets reads
run beside a write, and the busy timeout lets two writers take turns.

Every row keeps the actor who wrote it and the page revision it was written
against, so what the reader saw can be found again later.

The machine credentials agents use on serve's socket are kept here too, by
name, handles, operations and the SHA-256 of their token, never the token,
with each handle's last pull and the answers each owner has acknowledged.
An answer also keeps its question's text and its choice's label as the page
asked them, so an agent reads what the reader answered even after the page
is reworded. A checklist's answer keeps the items checked as `checked`, its
choice "" and its label the change summary; only it carries `checked`.

A reader's comment also keeps, as it arrives, its page's owner and that
owner's last pull then, so routing (lotuspod.routing) can tell whether the
owner was listening when it came, whatever pulls follow.

An agent takes a reader's comment up by claiming it: the comment keeps the
claim's credential, handle, token hash and expiry, and becomes `claimed`.
An agent's reply keeps the credential's idempotency key, unique per
credential, so a retried reply is found again rather than stored twice, and
the model it names as its writer, when it names one. An
agent may add a follow-up to a thread with no claim, kept the same way, and
it changes no comment's state. Each claim, reply, follow-up, release and
failure writes a row to the audit table in the same transaction, and the default responder writes one for each page it
republishes. Whether the responder is paused is kept here too.

A thread's resolution is kept as a history: each time a reader or an agent
resolves or reopens it, one row in resolutions names who did and when, and
the thread's resolution is its newest row. A reader's reply to a resolved
thread reopens it. A resolution never changes a comment's state.

A reader's comment, and an agent's reply or follow-up, may name up to four
images in the media store (lotuspod.media), each kept by its stored name with
its width and height; a comment row carries them as `images`, each with its
/media/ URL, and an empty list when it has none.

A thread may be anchored to a decision rather than a section: each of its
comments keeps the decision's question id as `question`, beside the section
whose comment box follows the decision's form. A row carries `question`
only on such a thread.

Each reader's last visit to each page is kept too: one row per reader, by
the address Access verified, and page, holding the revision they last
opened the page at, so it holds on any device they read from.
"""

from __future__ import annotations

import datetime
import hmac
import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Callable, Iterator, Mapping, Sequence

from lotuspod import media

DEFAULT_NAME = "lotuspod.sqlite3"
SCHEMA_VERSION = 11
# Seconds a connection waits for another writer before giving up.
BUSY_TIMEOUT = 30
# The state of a reader's comment until an agent takes it up.
PENDING = "pending"
# The states an agent's claim, reply and failure leave it in.
CLAIMED = "claimed"
ANSWERED = "answered"
FAILED = "failed"
SETTLED = (ANSWERED, FAILED)

# The statements that bring a database from the version before each to it.
_SCHEMA = {1: (
    """CREATE TABLE answers (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        page TEXT NOT NULL,
        question TEXT NOT NULL,
        version TEXT NOT NULL,
        choice TEXT NOT NULL,
        note TEXT NOT NULL,
        revision TEXT NOT NULL,
        actor TEXT NOT NULL,
        created_at TEXT NOT NULL,
        supersedes INTEGER REFERENCES answers(id)
    )""",
    "CREATE INDEX answers_by_question ON answers(page, question, id)",
    """CREATE TABLE comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        page TEXT NOT NULL,
        section TEXT NOT NULL,
        section_title TEXT NOT NULL,
        revision TEXT NOT NULL,
        parent INTEGER REFERENCES comments(id),
        text TEXT NOT NULL,
        quote TEXT,
        actor TEXT NOT NULL,
        created_at TEXT NOT NULL,
        state TEXT NOT NULL
    )""",
    "CREATE INDEX comments_by_page ON comments(page, id)",
), 2: (
    """CREATE TABLE credentials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        handles TEXT NOT NULL,
        operations TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL,
        revoked_at TEXT
    )""",
), 3: (
    "ALTER TABLE comments ADD COLUMN arrival_owner TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE comments ADD COLUMN arrival_pull TEXT",
    "ALTER TABLE answers ADD COLUMN question_text TEXT",
    "ALTER TABLE answers ADD COLUMN choice_label TEXT",
    "CREATE INDEX comments_by_state ON comments(state, id)",
    """CREATE TABLE pulls (
        handle TEXT PRIMARY KEY,
        pulled_at TEXT NOT NULL
    )""",
    """CREATE TABLE answer_acks (
        answer INTEGER NOT NULL REFERENCES answers(id),
        handle TEXT NOT NULL,
        acked_at TEXT NOT NULL,
        PRIMARY KEY (answer, handle)
    )""",
), 4: (
    # The claim on a reader's comment; its handle stays once it is settled.
    "ALTER TABLE comments ADD COLUMN claim_handle TEXT",
    "ALTER TABLE comments ADD COLUMN claim_credential TEXT",
    "ALTER TABLE comments ADD COLUMN claim_hash TEXT",
    "ALTER TABLE comments ADD COLUMN claim_expires TEXT",
    "ALTER TABLE comments ADD COLUMN reason TEXT",
    # An agent's reply: the idempotency key it was sent with, per credential.
    "ALTER TABLE comments ADD COLUMN reply_credential TEXT",
    "ALTER TABLE comments ADD COLUMN reply_key TEXT",
    "CREATE UNIQUE INDEX comments_by_key ON comments(reply_credential, reply_key)"
    " WHERE reply_key IS NOT NULL",
    """CREATE TABLE audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        action TEXT NOT NULL,
        comment INTEGER NOT NULL REFERENCES comments(id),
        page TEXT NOT NULL,
        credential TEXT NOT NULL,
        handle TEXT NOT NULL,
        key TEXT
    )""",
    "CREATE INDEX audit_by_page ON audit(page, id)",
), 5: (
    # Named settings of the site's own: today, whether the responder is paused.
    """CREATE TABLE settings (
        name TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        set_at TEXT NOT NULL
    )""",
    # The revision the responder republished a page at, on its audit row.
    "ALTER TABLE audit ADD COLUMN revision TEXT",
), 6: (
    # Each time a thread, named by its first comment, is resolved or reopened.
    """CREATE TABLE resolutions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread INTEGER NOT NULL REFERENCES comments(id),
        resolved INTEGER NOT NULL,
        actor TEXT NOT NULL,
        at TEXT NOT NULL
    )""",
    "CREATE INDEX resolutions_by_thread ON resolutions(thread, id)",
), 7: (
    # The model an agent's reply names as having written it.
    "ALTER TABLE comments ADD COLUMN model TEXT",
), 8: (
    # A reader's comment's images: a JSON list of {name, width, height}, the
    # names stored in lotuspod-media/; NULL when it has none.
    "ALTER TABLE comments ADD COLUMN images TEXT",
), 9: (
    # The decision a thread is anchored to, on each of its comments; NULL on
    # a thread on a section or a passage.
    "ALTER TABLE comments ADD COLUMN question TEXT",
), 10: (
    # A checklist's answer: a JSON list of the item ids checked, in the
    # page's order; NULL on a decision's answer.
    "ALTER TABLE answers ADD COLUMN checked TEXT",
), 11: (
    # The revision each reader, by their verified address, last opened each
    # page at.
    """CREATE TABLE page_views (
        reader TEXT NOT NULL,
        page TEXT NOT NULL,
        revision TEXT NOT NULL,
        seen_at TEXT NOT NULL,
        PRIMARY KEY (reader, page)
    )""",
)}
# The settings row that holds whether the responder is paused.
_PAUSED = "responder_paused"
# The resolution of a thread no one has resolved or reopened.
UNRESOLVED = {"resolved": False, "actor": None, "at": None}


class UnknownParent(LookupError):
    """A reply names no comment on its page."""


class DuplicateCredential(ValueError):
    """A credential of that name already exists, revoked or not."""


class Refused(Exception):
    """A claim, reply, release, failure or resolution refused, naming why:
    unknown_comment, unknown_thread, unknown_page, settled, not_routed,
    claimed, not_claimed or revision_mismatch. Nothing is stored."""

    def __init__(self, error: str) -> None:
        super().__init__(error)
        self.error = error


def _now() -> str:
    """The current UTC time, ISO 8601 to the millisecond."""
    stamp = datetime.datetime.now(datetime.timezone.utc)
    return stamp.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def stamp(seconds: float) -> str:
    """A time in seconds since the epoch as stored: UTC, ISO 8601 to the
    millisecond, so stored times order as text."""
    moment = datetime.datetime.fromtimestamp(seconds, datetime.timezone.utc)
    return moment.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _actor(text: str) -> dict:
    return json.loads(text)


def _answer(row: sqlite3.Row) -> dict:
    found = {
        "id": row["id"],
        "page": row["page"],
        "question": row["question"],
        "version": row["version"],
        "choice": row["choice"],
        "note": row["note"],
        "revision": row["revision"],
        "actor": _actor(row["actor"]),
        "createdAt": row["created_at"],
        "supersedes": row["supersedes"],
    }
    if row["checked"] is not None:
        found["checked"] = json.loads(row["checked"])
    return found


def _comment(row: sqlite3.Row) -> dict:
    found = {
        "id": row["id"],
        "page": row["page"],
        "section": row["section"],
        "sectionTitle": row["section_title"],
        "revision": row["revision"],
        "parent": row["parent"],
        "text": row["text"],
        "quote": None if row["quote"] is None else json.loads(row["quote"]),
        "images": _images(row["images"]),
        "actor": _actor(row["actor"]),
        "createdAt": row["created_at"],
        "state": row["state"],
        # Routing's own: lotuspod.routing reads them and never shows them.
        "arrival": {"owner": row["arrival_owner"], "ownerPull": row["arrival_pull"]},
        "claim": {"handle": row["claim_handle"], "credential": row["claim_credential"],
                  "tokenHash": row["claim_hash"], "expiresAt": row["claim_expires"]},
    }
    # Only a failed comment has a reason.
    if row["reason"] is not None:
        found["reason"] = row["reason"]
    # Only an agent's reply that named its model has one.
    if row["model"] is not None:
        found["model"] = row["model"]
    # Only a comment in a thread on a decision has one.
    if row["question"] is not None:
        found["question"] = row["question"]
    return found


def _images(text: str | None) -> list[dict]:
    """A comment's stored images, each with the URL serve answers it at."""
    if text is None:
        return []
    return [{"name": image["name"], "url": media.URL_PREFIX + image["name"],
             "width": image["width"], "height": image["height"]} for image in json.loads(text)]


def _audit(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "at": row["at"],
        "action": row["action"],
        "comment": row["comment"],
        "page": row["page"],
        "credential": row["credential"],
        "handle": row["handle"],
        "key": row["key"],
        "revision": row["revision"],
    }


def _resolution(row: sqlite3.Row | None) -> dict:
    if row is None:
        return dict(UNRESOLVED)
    return {"resolved": bool(row["resolved"]), "actor": _actor(row["actor"]), "at": row["at"]}


def _credential(row: sqlite3.Row) -> dict:
    return {
        "name": row["name"],
        "handles": json.loads(row["handles"]),
        "operations": json.loads(row["operations"]),
        "tokenHash": row["token_hash"],
        "createdAt": row["created_at"],
        "revokedAt": row["revoked_at"],
    }


class Database:
    """The database file at path, opened afresh for each use."""

    def __init__(self, path: Path | str) -> None:
        self.path = Path(path)

    @contextmanager
    def _connect(self) -> Iterator[sqlite3.Connection]:
        # Autocommit: every write below opens its own BEGIN IMMEDIATE, so a
        # read that decides a write (supersedes, a reply's thread) holds the
        # write lock from the read on.
        conn = sqlite3.connect(str(self.path), timeout=BUSY_TIMEOUT, isolation_level=None)
        try:
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode = WAL")
            conn.execute("PRAGMA foreign_keys = ON")
            self._ensure_schema(conn)
            yield conn
        finally:
            conn.close()

    @staticmethod
    def _ensure_schema(conn: sqlite3.Connection) -> None:
        version = conn.execute("PRAGMA user_version").fetchone()[0]
        if version == SCHEMA_VERSION:
            return
        if version > SCHEMA_VERSION:
            raise sqlite3.DatabaseError(
                f"database schema {version} is newer than this lotuspod's {SCHEMA_VERSION}"
            )
        with _write(conn):
            # Another connection may have moved it on while this one waited.
            version = conn.execute("PRAGMA user_version").fetchone()[0]
            for step in range(version + 1, SCHEMA_VERSION + 1):
                for statement in _SCHEMA[step]:
                    conn.execute(statement)
            conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

    def add_answer(self, *, page: str, question: str, version: str, choice: str,
                   note: str, revision: str, actor: Mapping,
                   question_text: str | None = None, choice_label: str | None = None,
                   checked: Sequence[str] | None = None) -> dict:
        """Store an answer; it supersedes the newest one to the same question.
        question_text and choice_label are the words the page asked it in;
        checked, a checklist's items checked, in the page's order (None on a
        decision's answer)."""
        with self._connect() as conn, _write(conn):
            last = conn.execute(
                "SELECT MAX(id) FROM answers WHERE page = ? AND question = ?",
                (page, question),
            ).fetchone()[0]
            cursor = conn.execute(
                "INSERT INTO answers (page, question, version, choice, note, revision,"
                " actor, created_at, supersedes, question_text, choice_label, checked)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (page, question, version, choice, note, revision,
                 _dump(actor), _now(), last, question_text, choice_label,
                 None if checked is None else json.dumps(list(checked))),
            )
            row = conn.execute("SELECT * FROM answers WHERE id = ?", (cursor.lastrowid,))
            return _answer(row.fetchone())

    def answers(self, page: str, *, asked: bool = False) -> dict:
        """The page's answered questions, each as {current, earlier}: the
        newest answer, and the older ones newest first. With asked, each
        answer also carries asked, the {text, label} of its question and
        choice as the page asked them (None in an answer stored before they
        were kept)."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM answers WHERE page = ? ORDER BY id DESC", (page,)
            ).fetchall()

        def answer(row: sqlite3.Row) -> dict:
            found = _answer(row)
            if asked:
                found["asked"] = {"text": row["question_text"], "label": row["choice_label"]}
            return found

        questions: dict[str, dict] = {}
        for row in reversed(rows):
            questions.setdefault(row["question"], {"current": None, "earlier": []})
        for row in rows:
            entry = questions[row["question"]]
            if entry["current"] is None:
                entry["current"] = answer(row)
            else:
                entry["earlier"].append(answer(row))
        return questions

    def add_comment(self, *, page: str, section: str, section_title: str, revision: str,
                    text: str, quote: Mapping | None, actor: Mapping, owner: str = "",
                    images: Sequence[Mapping] = (), question: str | None = None) -> dict:
        """Store a comment opening a new thread on section of a page owned
        by owner ("" when it has none), with its images, each {name, width,
        height}; with question, the thread is on that decision, in section."""
        with self._connect() as conn, _write(conn):
            return _insert_comment(
                conn, page=page, section=section, section_title=section_title,
                revision=revision, parent=None, text=text,
                quote=None if quote is None else _dump(quote), actor=actor, owner=owner,
                images=images, question=question,
            )

    def add_reply(self, *, page: str, parent: int, revision: str,
                  sections: Mapping[str, str], text: str, actor: Mapping,
                  owner: str = "", images: Sequence[Mapping] = ()) -> dict:
        """Store a reply in the thread of comment parent, on its section and
        its decision, if any.

        A reply to a reply joins the same thread: its parent is the thread's
        first comment. sections maps the page's section ids to their titles
        at revision; images are as add_comment's. UnknownParent when parent
        is not a comment on page.
        A reply to a resolved thread reopens it, with actor as the reopener.
        """
        with self._connect() as conn, _write(conn):
            found = conn.execute(
                "SELECT id, page, section, parent, question FROM comments WHERE id = ?",
                (parent,)
            ).fetchone()
            if found is None or found["page"] != page:
                raise UnknownParent(parent)
            root = found["id"] if found["parent"] is None else found["parent"]
            row = _insert_comment(
                conn, page=page, section=found["section"],
                section_title=sections.get(found["section"], ""), revision=revision,
                parent=root, text=text, quote=None, actor=actor, owner=owner,
                images=images, question=found["question"],
            )
            if _resolution(_newest(conn, root))["resolved"]:
                _insert_resolution(conn, root, False, actor)
            return row

    def threads(self, page: str) -> list[dict]:
        """The page's threads as {root, replies, resolution}, oldest first
        throughout."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM comments WHERE page = ? ORDER BY id", (page,)
            ).fetchall()
            # Oldest first, so each thread's newest row is the one left.
            changes = conn.execute(
                "SELECT resolutions.* FROM resolutions JOIN comments"
                " ON comments.id = resolutions.thread WHERE comments.page = ?"
                " ORDER BY resolutions.id", (page,)
            ).fetchall()
        newest = {row["thread"]: row for row in changes}
        threads: dict[int, dict] = {}
        for row in rows:
            if row["parent"] is None:
                threads[row["id"]] = {"root": _comment(row), "replies": [],
                                      "resolution": _resolution(newest.get(row["id"]))}
            else:
                threads[row["parent"]]["replies"].append(_comment(row))
        return list(threads.values())

    def resolve(self, root: int, *, page: str, resolved: bool, actor: Mapping,
                credential: str | None = None) -> dict:
        """Resolve the thread whose first comment is root on page, or reopen
        it when resolved is False, as actor; the thread's resolution.

        A row is stored only when it changes the resolution. With
        credential, the agent's, the change is written to the audit trail
        too, as actor's handle. Refused unknown_thread when root is not the
        first comment of a thread on page.
        """
        with self._connect() as conn, _write(conn):
            found = _row(conn, root)
            if found is None or found["page"] != page or found["parent"] is not None:
                raise Refused("unknown_thread")
            current = _resolution(_newest(conn, root))
            if current["resolved"] == resolved:
                return current
            _insert_resolution(conn, root, resolved, actor)
            if credential is not None:
                _record(conn, "resolve" if resolved else "reopen", _comment(found),
                        credential, actor["handle"], None)
            return _resolution(_newest(conn, root))

    def resolutions(self, root: int) -> list[dict]:
        """Every resolution the thread of first comment root has had, oldest
        first."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM resolutions WHERE thread = ? ORDER BY id", (root,)
            ).fetchall()
        return [_resolution(row) for row in rows]

    def open_comments(self) -> list[dict]:
        """Every comment not yet answered or failed, claimed ones too (a
        claim may have lapsed), oldest first."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM comments WHERE state IN (?, ?) ORDER BY id", (PENDING, CLAIMED)
            ).fetchall()
        return [_comment(row) for row in rows]

    def comment(self, comment_id: int) -> dict | None:
        """The comment comment_id; None when there is none."""
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM comments WHERE id = ?", (comment_id,)).fetchone()
        return None if row is None else _comment(row)

    def claim(self, comment_id: int, *, credential: str, handles: list[str],
              token_hash: str, claim_sec: float, clock: Callable[[], float],
              route: Callable[[dict, dict[str, str], float], str | None]) -> dict:
        """Claim comment_id for credential for claim_sec seconds; the comment
        as claimed.

        clock() is the time, read once the write lock is held, so a request
        that waited for it is judged as of when it is decided.
        route(comment, pulls, now) is the handle the comment is routed to, a
        lapsed claim routed afresh, given each handle's last pull. Refused
        settled for an answered or failed comment, not_routed when that
        handle is none of handles, claimed while another credential's claim
        is current. A current claim of credential's own is renewed.
        """
        with self._connect() as conn, _write(conn):
            now = clock()
            found = _find(conn, comment_id)
            if found["state"] in SETTLED:
                raise Refused("settled")
            pulls = {row["handle"]: row["pulled_at"]
                     for row in conn.execute("SELECT handle, pulled_at FROM pulls")}
            handle = route(found, pulls, now)
            if handle is None or handle not in handles:
                raise Refused("not_routed")
            # Only while it is unclaimed, or its claim has lapsed or is this
            # credential's own.
            changed = conn.execute(
                "UPDATE comments SET state = ?, claim_handle = ?, claim_credential = ?,"
                " claim_hash = ?, claim_expires = ?"
                " WHERE id = ? AND (state = ? OR (state = ? AND"
                " (claim_expires <= ? OR claim_credential = ?)))",
                (CLAIMED, handle, credential, token_hash, stamp(now + claim_sec),
                 comment_id, PENDING, CLAIMED, stamp(now), credential),
            ).rowcount
            if changed != 1:
                raise Refused("claimed")
            _record(conn, "claim", found, credential, handle, None)
            return _comment(_row(conn, comment_id))

    def reply(self, comment_id: int, *, credential: str, token_hash: str, key: str,
              text: str, revision: str | None, clock: Callable[[], float],
              page_of: Callable[[str], Mapping | None], model: str | None = None,
              images: Sequence[Mapping] = ()) -> dict:
        """Store credential's reply to comment_id under its claim, naming
        model as its writer when it is not None, with its images, each
        {name, width, height}, as a reader's comment keeps them; the reply.

        clock() is the time the claim is checked at and page_of(name) the
        page {revision, sections} as serve answers it now, or None; both are
        read under the write lock, so a request that waited for it is judged
        as of when it is decided.

        A key credential has used before answers the reply stored with it,
        whatever the claim's state now. Otherwise refused not_claimed unless
        the comment's current claim is credential's and token_hash is its
        token's; unknown_page when serve no longer answers the comment's
        page; revision_mismatch when revision is not None, not the page's,
        and not one credential republished the page at for this key (see
        record_publish), which stays true once the page moves on.
        The reply joins the comment's thread, the comment becomes answered
        and the claim ends.
        """
        with self._connect() as conn, _write(conn):
            stored = conn.execute(
                "SELECT * FROM comments WHERE reply_credential = ? AND reply_key = ?",
                (credential, key),
            ).fetchone()
            if stored is not None:
                return _comment(stored)
            found = _held(conn, comment_id, credential, token_hash, clock())
            page = page_of(found["page"])
            if page is None:
                raise Refused("unknown_page")
            if revision is not None and revision != page["revision"] and not _published(
                    conn, comment_id, credential, key, revision):
                raise Refused("revision_mismatch")
            handle = found["claim"]["handle"]
            actor = {"kind": "agent", "handle": handle, "credential": credential}
            root = found["id"] if found["parent"] is None else found["parent"]
            cursor = conn.execute(
                "INSERT INTO comments (page, section, section_title, revision, parent, text,"
                " quote, actor, created_at, state, reply_credential, reply_key, model,"
                " question, images) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)",
                (found["page"], found["section"],
                 page["sections"].get(found["section"], ""),
                 # A reply's revision is the page revision it made, if any.
                 revision or "", root, text, _dump(actor), _now(), ANSWERED,
                 credential, key, model, found.get("question"), _stored_images(images)),
            )
            conn.execute(
                "UPDATE comments SET state = ?, claim_hash = NULL, claim_expires = NULL"
                " WHERE id = ?", (ANSWERED, comment_id),
            )
            _record(conn, "reply", found, credential, handle, key)
            return _comment(_row(conn, cursor.lastrowid))

    def follow_up(self, root: int, *, credential: str, handle: str, key: str, text: str,
                  revision: str | None, reopen: bool,
                  page_of: Callable[[str], Mapping | None],
                  images: Sequence[Mapping] = ()) -> dict:
        """Store credential's message, as handle, in the thread whose first
        comment is root, with no claim and with images as reply keeps them;
        the message.

        A key credential has used before answers the message stored with
        it. Otherwise refused unknown_thread when root is not a reader's
        first comment, and unknown_page and revision_mismatch as reply is.
        No comment's state changes. With reopen, a resolved thread is
        reopened as handle; else its resolution stays as it is.
        """
        with self._connect() as conn, _write(conn):
            stored = conn.execute(
                "SELECT * FROM comments WHERE reply_credential = ? AND reply_key = ?",
                (credential, key),
            ).fetchone()
            if stored is not None:
                return _comment(stored)
            row = _row(conn, root)
            if (row is None or row["parent"] is not None
                    or json.loads(row["actor"]).get("kind") != "human"):
                raise Refused("unknown_thread")
            found = _comment(row)
            page = page_of(found["page"])
            if page is None:
                raise Refused("unknown_page")
            if revision is not None and revision != page["revision"] and not _published(
                    conn, root, credential, key, revision):
                raise Refused("revision_mismatch")
            actor = {"kind": "agent", "handle": handle, "credential": credential}
            cursor = conn.execute(
                "INSERT INTO comments (page, section, section_title, revision, parent, text,"
                " quote, actor, created_at, state, reply_credential, reply_key, question,"
                " images) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)",
                (found["page"], found["section"],
                 page["sections"].get(found["section"], ""),
                 revision or "", root, text, _dump(actor), _now(), ANSWERED,
                 credential, key, found.get("question"), _stored_images(images)),
            )
            _record(conn, "follow-up", found, credential, handle, key)
            if reopen and _resolution(_newest(conn, root))["resolved"]:
                _insert_resolution(conn, root, False, actor)
                _record(conn, "reopen", found, credential, handle, None)
            return _comment(_row(conn, cursor.lastrowid))

    def release(self, comment_id: int, *, credential: str, token_hash: str,
                clock: Callable[[], float]) -> dict:
        """End credential's current claim on comment_id and route it again;
        the comment. Refused not_claimed as reply is."""
        with self._connect() as conn, _write(conn):
            found = _held(conn, comment_id, credential, token_hash, clock())
            conn.execute(
                "UPDATE comments SET state = ?, claim_handle = NULL, claim_credential = NULL,"
                " claim_hash = NULL, claim_expires = NULL WHERE id = ?",
                (PENDING, comment_id),
            )
            _record(conn, "release", found, credential, found["claim"]["handle"], None)
            return _comment(_row(conn, comment_id))

    def fail(self, comment_id: int, *, credential: str, token_hash: str,
             clock: Callable[[], float], reason: str) -> dict:
        """Leave comment_id failed for reason under credential's current
        claim, which ends; the comment. Refused not_claimed as reply is."""
        with self._connect() as conn, _write(conn):
            found = _held(conn, comment_id, credential, token_hash, clock())
            conn.execute(
                "UPDATE comments SET state = ?, reason = ?, claim_hash = NULL,"
                " claim_expires = NULL WHERE id = ?",
                (FAILED, reason, comment_id),
            )
            _record(conn, "fail", found, credential, found["claim"]["handle"], None)
            return _comment(_row(conn, comment_id))

    def record_publish(self, comment_id: int, *, credential: str, handle: str,
                       key: str, revision: str) -> None:
        """Write to the audit trail that credential, acting as handle,
        republished the page of comment comment_id at revision, as asked in
        it, for the reply of idempotency key key; once, however often it is
        recorded."""
        with self._connect() as conn, _write(conn):
            if not _published(conn, comment_id, credential, key, revision):
                _record(conn, "publish", _find(conn, comment_id), credential, handle, key,
                        revision)

    def published_revision(self, comment_id: int, *, credential: str,
                           key: str) -> str | None:
        """The revision credential republished comment_id's page at for the
        reply of key; None when it did not."""
        with self._connect() as conn:
            row = conn.execute(
                "SELECT revision FROM audit WHERE action = 'publish' AND comment = ?"
                " AND credential = ? AND key = ? ORDER BY id DESC LIMIT 1",
                (comment_id, credential, key),
            ).fetchone()
        return None if row is None else row[0]

    def responder_paused(self) -> bool:
        """Whether the responder is paused."""
        with self._connect() as conn:
            row = conn.execute("SELECT value FROM settings WHERE name = ?", (_PAUSED,)).fetchone()
        return row is not None and row[0] == "1"

    def set_responder_paused(self, paused: bool) -> None:
        """Pause the responder, or resume it."""
        with self._connect() as conn, _write(conn):
            conn.execute(
                "INSERT INTO settings (name, value, set_at) VALUES (?, ?, ?)"
                " ON CONFLICT (name) DO UPDATE SET value = excluded.value,"
                " set_at = excluded.set_at",
                (_PAUSED, "1" if paused else "0", _now()),
            )

    def audit(self, page: str | None = None) -> list[dict]:
        """Every claim, reply, follow-up, release, failure, resolve and
        reopen by an agent, and every republish by the responder, on page or on any page,
        oldest first."""
        with self._connect() as conn:
            if page is None:
                rows = conn.execute("SELECT * FROM audit ORDER BY id").fetchall()
            else:
                rows = conn.execute(
                    "SELECT * FROM audit WHERE page = ? ORDER BY id", (page,)
                ).fetchall()
        return [_audit(row) for row in rows]

    def thread(self, root: int) -> dict:
        """The thread of comment root as {root, replies, resolution}, oldest
        first."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM comments WHERE id = ? OR parent = ? ORDER BY id", (root, root)
            ).fetchall()
            resolution = _resolution(_newest(conn, root))
        return {"root": _comment(rows[0]), "replies": [_comment(row) for row in rows[1:]],
                "resolution": resolution}

    def record_pull(self, handle: str) -> str:
        """Record that handle pulled now; the time it did."""
        stamp = _now()
        with self._connect() as conn, _write(conn):
            conn.execute(
                "INSERT INTO pulls (handle, pulled_at) VALUES (?, ?)"
                " ON CONFLICT (handle) DO UPDATE SET pulled_at = excluded.pulled_at",
                (handle, stamp),
            )
        return stamp

    def pulls(self) -> dict[str, str]:
        """Each handle that has pulled, to the time it last did."""
        with self._connect() as conn:
            rows = conn.execute("SELECT handle, pulled_at FROM pulls").fetchall()
        return {row["handle"]: row["pulled_at"] for row in rows}

    def record_view(self, *, reader: str, page: str, revision: str) -> str | None:
        """Record that reader opened page at revision; the revision recorded
        for them before, None the first time."""
        with self._connect() as conn, _write(conn):
            row = conn.execute(
                "SELECT revision FROM page_views WHERE reader = ? AND page = ?", (reader, page)
            ).fetchone()
            conn.execute(
                "INSERT INTO page_views (reader, page, revision, seen_at) VALUES (?, ?, ?, ?)"
                " ON CONFLICT (reader, page) DO UPDATE SET revision = excluded.revision,"
                " seen_at = excluded.seen_at",
                (reader, page, revision, _now()),
            )
        return None if row is None else row[0]

    def views(self, reader: str) -> dict[str, str]:
        """Each page reader has opened, to the revision they last opened it at."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT page, revision FROM page_views WHERE reader = ?", (reader,)
            ).fetchall()
        return {row["page"]: row["revision"] for row in rows}

    def answer(self, answer_id: int) -> dict | None:
        """The answer answer_id; None when there is none."""
        with self._connect() as conn:
            row = conn.execute("SELECT * FROM answers WHERE id = ?", (answer_id,)).fetchone()
        return None if row is None else _answer(row)

    def unacknowledged_answers(self, handle: str) -> list[dict]:
        """Every answer handle has not acknowledged, oldest first, each as
        {answer, asked}: the answer, and the {text, label} of its question
        and choice as the page asked them (None in an answer stored before
        they were kept)."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM answers WHERE id NOT IN"
                " (SELECT answer FROM answer_acks WHERE handle = ?) ORDER BY id", (handle,)
            ).fetchall()
        return [{"answer": _answer(row),
                 "asked": {"text": row["question_text"], "label": row["choice_label"]}}
                for row in rows]

    def acknowledge_answer(self, answer_id: int, handle: str) -> str:
        """Record that handle has the answer answer_id; when it first did."""
        with self._connect() as conn, _write(conn):
            conn.execute(
                "INSERT OR IGNORE INTO answer_acks (answer, handle, acked_at) VALUES (?, ?, ?)",
                (answer_id, handle, _now()),
            )
            return conn.execute(
                "SELECT acked_at FROM answer_acks WHERE answer = ? AND handle = ?",
                (answer_id, handle),
            ).fetchone()[0]

    def add_credential(self, *, name: str, handles: list[str], operations: list[str],
                       token_hash: str) -> dict:
        """Store a credential; DuplicateCredential when name is taken."""
        with self._connect() as conn, _write(conn):
            if conn.execute("SELECT 1 FROM credentials WHERE name = ?", (name,)).fetchone():
                raise DuplicateCredential(name)
            cursor = conn.execute(
                "INSERT INTO credentials (name, handles, operations, token_hash, created_at)"
                " VALUES (?, ?, ?, ?, ?)",
                (name, json.dumps(handles), json.dumps(operations), token_hash, _now()),
            )
            row = conn.execute("SELECT * FROM credentials WHERE id = ?", (cursor.lastrowid,))
            return _credential(row.fetchone())

    def credentials(self) -> list[dict]:
        """Every credential, revoked ones too, oldest first."""
        with self._connect() as conn:
            rows = conn.execute("SELECT * FROM credentials ORDER BY id").fetchall()
        return [_credential(row) for row in rows]

    def revoke_credential(self, name: str) -> dict | None:
        """Revoke the credential name, now unless it already is; None when
        there is no such credential."""
        with self._connect() as conn, _write(conn):
            conn.execute(
                "UPDATE credentials SET revoked_at = ? WHERE name = ? AND revoked_at IS NULL",
                (_now(), name),
            )
            row = conn.execute("SELECT * FROM credentials WHERE name = ?", (name,)).fetchone()
            return None if row is None else _credential(row)


def _dump(value: Mapping) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


@contextmanager
def _write(conn: sqlite3.Connection) -> Iterator[None]:
    """One write transaction, holding the write lock from its first read."""
    conn.execute("BEGIN IMMEDIATE")
    try:
        yield
    except BaseException:
        conn.execute("ROLLBACK")
        raise
    conn.execute("COMMIT")


def _stored_images(images: Sequence[Mapping]) -> str | None:
    if not images:
        return None
    return json.dumps([{"name": image["name"], "width": image["width"],
                        "height": image["height"]} for image in images])


def _row(conn: sqlite3.Connection, comment_id: int) -> sqlite3.Row:
    return conn.execute("SELECT * FROM comments WHERE id = ?", (comment_id,)).fetchone()


def _find(conn: sqlite3.Connection, comment_id: int) -> dict:
    """The reader's comment comment_id; Refused unknown_comment when there
    is none, or it is an agent's reply."""
    row = _row(conn, comment_id)
    if row is None or json.loads(row["actor"]).get("kind") != "human":
        raise Refused("unknown_comment")
    return _comment(row)


def _held(conn: sqlite3.Connection, comment_id: int, credential: str, token_hash: str,
          now: float) -> dict:
    """The comment comment_id while credential's claim on it is current and
    token_hash is its token's; Refused not_claimed otherwise."""
    found = _find(conn, comment_id)
    claim = found["claim"]
    if (found["state"] != CLAIMED or claim["credential"] != credential
            or claim["expiresAt"] is None or claim["expiresAt"] <= stamp(now)
            or not hmac.compare_digest(claim["tokenHash"] or "", token_hash)):
        raise Refused("not_claimed")
    return found


def _record(conn: sqlite3.Connection, action: str, comment: Mapping, credential: str,
            handle: str, key: str | None, revision: str | None = None) -> None:
    conn.execute(
        "INSERT INTO audit (at, action, comment, page, credential, handle, key, revision)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        (_now(), action, comment["id"], comment["page"], credential, handle, key, revision),
    )


def _newest(conn: sqlite3.Connection, root: int) -> sqlite3.Row | None:
    """The newest resolution row of the thread of first comment root."""
    return conn.execute(
        "SELECT * FROM resolutions WHERE thread = ? ORDER BY id DESC LIMIT 1", (root,)
    ).fetchone()


def _insert_resolution(conn: sqlite3.Connection, root: int, resolved: bool,
                       actor: Mapping) -> None:
    conn.execute(
        "INSERT INTO resolutions (thread, resolved, actor, at) VALUES (?, ?, ?, ?)",
        (root, int(resolved), _dump(actor), _now()),
    )


def _published(conn: sqlite3.Connection, comment_id: int, credential: str, key: str,
               revision: str) -> bool:
    """Whether credential republished comment_id's page at revision for the
    reply of key: that reply may name it after the page has moved on."""
    return conn.execute(
        "SELECT 1 FROM audit WHERE action = 'publish' AND comment = ? AND credential = ?"
        " AND key = ? AND revision = ?", (comment_id, credential, key, revision),
    ).fetchone() is not None


def _insert_comment(conn: sqlite3.Connection, *, page: str, section: str,
                    section_title: str, revision: str, parent: int | None, text: str,
                    quote: str | None, actor: Mapping, owner: str,
                    images: Sequence[Mapping] = (), question: str | None = None) -> dict:
    # The owner's last pull as the comment arrives, read under the write lock.
    pulled = None
    if owner:
        found = conn.execute("SELECT pulled_at FROM pulls WHERE handle = ?", (owner,)).fetchone()
        pulled = None if found is None else found[0]
    cursor = conn.execute(
        "INSERT INTO comments (page, section, section_title, revision, parent, text,"
        " quote, actor, created_at, state, arrival_owner, arrival_pull, images, question)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (page, section, section_title, revision, parent, text, quote,
         _dump(actor), _now(), PENDING, owner, pulled, _stored_images(images), question),
    )
    row = conn.execute("SELECT * FROM comments WHERE id = ?", (cursor.lastrowid,))
    return _comment(row.fetchone())
