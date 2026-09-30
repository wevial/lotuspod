"""The reader's answers and comments: one SQLite file beside the artifacts.

The database never sits in the output directory (the artifacts repository
commits everything there). Its schema is made on first open and versioned
with PRAGMA user_version; ids come from AUTOINCREMENT, so an id is never
given out twice, even after a row is gone. serve answers each request on its
own thread, so every request opens its own connection: WAL mode lets reads
run beside a write, and the busy timeout lets two writers take turns.

Every row keeps the actor who wrote it and the page revision it was written
against, so what the reader saw can be found again later.
"""

from __future__ import annotations

import datetime
import json
import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator, Mapping

DEFAULT_NAME = "lotuspod.sqlite3"
SCHEMA_VERSION = 1
# Seconds a connection waits for another writer before giving up.
BUSY_TIMEOUT = 30
# The state of a reader's comment until an agent takes it up.
PENDING = "pending"

_SCHEMA = (
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
)


class UnknownParent(LookupError):
    """A reply names no comment on its page."""


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
            # Another connection may have made it while this one waited.
            if conn.execute("PRAGMA user_version").fetchone()[0] == 0:
                for statement in _SCHEMA:
                    conn.execute(statement)
                conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

    def add_answer(self, *, page: str, question: str, version: str, choice: str,
                   note: str, revision: str, actor: Mapping) -> dict:
        """Store an answer; it supersedes the newest one to the same question."""
        with self._connect() as conn, _write(conn):
            last = conn.execute(
                "SELECT MAX(id) FROM answers WHERE page = ? AND question = ?",
                (page, question),
            ).fetchone()[0]
            cursor = conn.execute(
                "INSERT INTO answers (page, question, version, choice, note, revision,"
                " actor, created_at, supersedes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (page, question, version, choice, note, revision,
                 _dump(actor), _now(), last),
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
                    text: str, quote: Mapping | None, actor: Mapping) -> dict:
        """Store a comment opening a new thread on section."""
        with self._connect() as conn, _write(conn):
            return _insert_comment(
                conn, page=page, section=section, section_title=section_title,
                revision=revision, parent=None, text=text,
                quote=None if quote is None else _dump(quote), actor=actor,
            )

    def add_reply(self, *, page: str, parent: int, revision: str,
                  sections: Mapping[str, str], text: str, actor: Mapping) -> dict:
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
                parent=root, text=text, quote=None, actor=actor,
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
                    quote: str | None, actor: Mapping) -> dict:
    cursor = conn.execute(
        "INSERT INTO comments (page, section, section_title, revision, parent, text,"
        " quote, actor, created_at, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        (page, section, section_title, revision, parent, text, quote,
         _dump(actor), _now(), PENDING),
    )
    row = conn.execute("SELECT * FROM comments WHERE id = ?", (cursor.lastrowid,))
    return _comment(row.fetchone())
