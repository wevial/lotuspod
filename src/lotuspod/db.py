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
is reworded.

A reader's comment also keeps, as it arrives, its page's owner and that
owner's last pull then, so routing (lotuspod.routing) can tell whether the
owner was listening when it came, whatever pulls follow.
"""

from __future__ import annotations

import datetime
import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Mapping

DEFAULT_NAME = "lotuspod.sqlite3"
SCHEMA_VERSION = 3
# Seconds a connection waits for another writer before giving up.
BUSY_TIMEOUT = 30
# The state of a reader's comment until an agent takes it up.
PENDING = "pending"

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
)}


class UnknownParent(LookupError):
    """A reply names no comment on its page."""


class DuplicateCredential(ValueError):
    """A credential of that name already exists, revoked or not."""


def _now() -> str:
    """The current UTC time, ISO 8601 to the millisecond."""
    stamp = datetime.datetime.now(datetime.timezone.utc)
    return stamp.isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _actor(text: str) -> dict:
    return json.loads(text)


def _answer(row: sqlite3.Row) -> dict:
    return {
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


def _comment(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "page": row["page"],
        "section": row["section"],
        "sectionTitle": row["section_title"],
        "revision": row["revision"],
        "parent": row["parent"],
        "text": row["text"],
        "quote": None if row["quote"] is None else json.loads(row["quote"]),
        "actor": _actor(row["actor"]),
        "createdAt": row["created_at"],
        "state": row["state"],
        # Routing's own: lotuspod.routing reads it and never shows it.
        "arrival": {"owner": row["arrival_owner"], "ownerPull": row["arrival_pull"]},
    }


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
                   question_text: str | None = None, choice_label: str | None = None) -> dict:
        """Store an answer; it supersedes the newest one to the same question.
        question_text and choice_label are the words the page asked it in."""
        with self._connect() as conn, _write(conn):
            last = conn.execute(
                "SELECT MAX(id) FROM answers WHERE page = ? AND question = ?",
                (page, question),
            ).fetchone()[0]
            cursor = conn.execute(
                "INSERT INTO answers (page, question, version, choice, note, revision,"
                " actor, created_at, supersedes, question_text, choice_label)"
                " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (page, question, version, choice, note, revision,
                 _dump(actor), _now(), last, question_text, choice_label),
            )
            row = conn.execute("SELECT * FROM answers WHERE id = ?", (cursor.lastrowid,))
            return _answer(row.fetchone())

    def answers(self, page: str) -> dict:
        """The page's answered questions, each as {current, earlier}: the
        newest answer, and the older ones newest first."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM answers WHERE page = ? ORDER BY id DESC", (page,)
            ).fetchall()
        questions: dict[str, dict] = {}
        for row in reversed(rows):
            questions.setdefault(row["question"], {"current": None, "earlier": []})
        for row in rows:
            entry = questions[row["question"]]
            if entry["current"] is None:
                entry["current"] = _answer(row)
            else:
                entry["earlier"].append(_answer(row))
        return questions

    def add_comment(self, *, page: str, section: str, section_title: str, revision: str,
                    text: str, quote: Mapping | None, actor: Mapping, owner: str = "") -> dict:
        """Store a comment opening a new thread on section of a page owned
        by owner ("" when it has none)."""
        with self._connect() as conn, _write(conn):
            return _insert_comment(
                conn, page=page, section=section, section_title=section_title,
                revision=revision, parent=None, text=text,
                quote=None if quote is None else _dump(quote), actor=actor, owner=owner,
            )

    def add_reply(self, *, page: str, parent: int, revision: str,
                  sections: Mapping[str, str], text: str, actor: Mapping,
                  owner: str = "") -> dict:
        """Store a reply in the thread of comment parent, on its section.

        A reply to a reply joins the same thread: its parent is the thread's
        first comment. sections maps the page's section ids to their titles
        at revision. UnknownParent when parent is not a comment on page.
        """
        with self._connect() as conn, _write(conn):
            found = conn.execute(
                "SELECT id, page, section, parent FROM comments WHERE id = ?", (parent,)
            ).fetchone()
            if found is None or found["page"] != page:
                raise UnknownParent(parent)
            root = found["id"] if found["parent"] is None else found["parent"]
            return _insert_comment(
                conn, page=page, section=found["section"],
                section_title=sections.get(found["section"], ""), revision=revision,
                parent=root, text=text, quote=None, actor=actor, owner=owner,
            )

    def threads(self, page: str) -> list[dict]:
        """The page's threads as {root, replies}, oldest first throughout."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM comments WHERE page = ? ORDER BY id", (page,)
            ).fetchall()
        threads: dict[int, dict] = {}
        for row in rows:
            if row["parent"] is None:
                threads[row["id"]] = {"root": _comment(row), "replies": []}
            else:
                threads[row["parent"]]["replies"].append(_comment(row))
        return list(threads.values())

    def open_comments(self) -> list[dict]:
        """Every comment no agent has taken up yet, oldest first."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM comments WHERE state = ? ORDER BY id", (PENDING,)
            ).fetchall()
        return [_comment(row) for row in rows]

    def thread(self, root: int) -> dict:
        """The thread of comment root as {root, replies}, oldest first."""
        with self._connect() as conn:
            rows = conn.execute(
                "SELECT * FROM comments WHERE id = ? OR parent = ? ORDER BY id", (root, root)
            ).fetchall()
        return {"root": _comment(rows[0]), "replies": [_comment(row) for row in rows[1:]]}

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


def _insert_comment(conn: sqlite3.Connection, *, page: str, section: str,
                    section_title: str, revision: str, parent: int | None, text: str,
                    quote: str | None, actor: Mapping, owner: str) -> dict:
    # The owner's last pull as the comment arrives, read under the write lock.
    pulled = None
    if owner:
        found = conn.execute("SELECT pulled_at FROM pulls WHERE handle = ?", (owner,)).fetchone()
        pulled = None if found is None else found[0]
    cursor = conn.execute(
        "INSERT INTO comments (page, section, section_title, revision, parent, text,"
        " quote, actor, created_at, state, arrival_owner, arrival_pull)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (page, section, section_title, revision, parent, text, quote,
         _dump(actor), _now(), PENDING, owner, pulled),
    )
    row = conn.execute("SELECT * FROM comments WHERE id = ?", (cursor.lastrowid,))
    return _comment(row.fetchone())
