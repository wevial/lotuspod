"""Emoji reactions on comments, kept apart from the comments themselves.

A reaction is one row per comment, emoji and reactor: a reader's verified
address, or `agent:HANDLE` for an agent (an address always holds @, a handle
never does). Adding one twice stores one row, and removing one that is not
there does nothing. Nothing here reads or writes the comments table, so a
reaction never routes a comment, counts as a reply or makes anything unread.

A comment's reactions are shown grouped by emoji, in the order of each
emoji's first reaction: {emoji, count, mine, by}, `by` the reactors' shown
names oldest first (a reader's address up to its last @, an agent's handle)
and `mine` whether one of the asker's reactors is among them.
"""

from __future__ import annotations

from typing import Collection, Mapping

from lotuspod.store import db

AGENT = "agent:"


def agent(handle: str) -> str:
    """The reactor an agent reacts as."""
    return AGENT + handle


def add(database: db.Database, comment: int, emoji: str, reactor: str,
        actor: Mapping) -> None:
    with database._connect() as conn, db._write(conn):
        conn.execute(
            "INSERT OR IGNORE INTO reactions (comment, emoji, reactor, actor, created_at)"
            " VALUES (?, ?, ?, ?, ?)", (comment, emoji, reactor, db._dump(actor), db._now()))


def remove(database: db.Database, comment: int, emoji: str, reactor: str) -> None:
    with database._connect() as conn, db._write(conn):
        conn.execute("DELETE FROM reactions WHERE comment = ? AND emoji = ? AND reactor = ?",
                     (comment, emoji, reactor))


def _name(reactor: str) -> str:
    # An address always holds @ and a handle never does, so a reader whose
    # address starts with agent: is still a reader.
    if "@" not in reactor and reactor.startswith(AGENT):
        return reactor[len(AGENT):]
    return reactor.rsplit("@", 1)[0]


def _grouped(rows: list, mine: Collection[str]) -> dict[int, list[dict]]:
    found: dict[int, dict[str, dict]] = {}
    for comment, emoji, reactor in rows:
        entry = found.setdefault(comment, {}).setdefault(
            emoji, {"emoji": emoji, "count": 0, "mine": False, "by": []})
        entry["count"] += 1
        entry["mine"] = entry["mine"] or reactor in mine
        entry["by"].append(_name(reactor))
    return {comment: list(emojis.values()) for comment, emojis in found.items()}


def on_page(database: db.Database, page: str, mine: Collection[str]) -> dict[int, list[dict]]:
    """The reactions on each of the page's comments that has any, by id;
    mine is the asker's reactors."""
    with database._connect() as conn:
        rows = conn.execute(
            "SELECT reactions.comment, reactions.emoji, reactions.reactor FROM reactions"
            " JOIN comments ON comments.id = reactions.comment WHERE comments.page = ?"
            " ORDER BY reactions.created_at, reactions.rowid", (page,)).fetchall()
    return _grouped([tuple(row) for row in rows], mine)


def on_comment(database: db.Database, comment: int, mine: Collection[str]) -> list[dict]:
    """The comment's reactions; mine is the asker's reactors."""
    with database._connect() as conn:
        rows = conn.execute(
            "SELECT comment, emoji, reactor FROM reactions WHERE comment = ?"
            " ORDER BY created_at, rowid", (comment,)).fetchall()
    return _grouped([tuple(row) for row in rows], mine).get(comment, [])
