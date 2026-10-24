"""Where a reader's comment goes: one rule, used wherever a comment's
destination is shown or checked.

A reader's comment no agent has taken up yet is routed to one handle:

- A comment whose text starts with `@HANDLE` (a handle in any case, then
  whitespace, punctuation or the end) goes to HANDLE and only ever to it;
  `@responder` names the default responder.
- A reply (a comment that is not its thread's root) that names no handle
  goes to the handle of the latest agent reply before it in its thread,
  while that handle is listening; when it is not, or no agent has replied
  before it, it goes to the default responder as below. Listening is read
  at routing time, so such a reply whose agent stops listening before it
  claims the reply is routed to the responder again.
- Otherwise it goes to the default responder, `responder`, on a page with
  an owner too, whether or not the owner is listening. The responder
  answers it, and queues what asks the owner to act in that owner's inbox
  (lotuspod.features.agents.responder, lotuspod.db).

A handle is listening when its last pull is within the window. A comment is
`pending` while the handle it is routed to is listening, else `unavailable`;
one routed to the responder is `paused` while the responder is paused.

A comment an agent has taken up keeps the state stored with it and is shown
as the handle's that took it: `claimed` while the claim is current,
`answered` once replied to, `failed` once the agent gave up on it. A claim
that has expired simply lapses: the comment is routed again, as if never
claimed.

`route()` is a pure function of the comment (its text and its claim), its
thread (its root and the replies before it), the last-pull times,
the window, the clock and whether the responder is paused, so the threads
routes, the pull and the claim all agree. A thread's resolution plays no
part: a comment in a resolved thread is routed as any other.
"""

from __future__ import annotations

import datetime
import re
import string
import unicodedata
from typing import Mapping

from lotuspod.store import db

RESPONDER = "responder"
# Seconds: how long a pull keeps a handle listening.
DEFAULT_WINDOW = 300
PENDING = db.PENDING
UNAVAILABLE = "unavailable"
PAUSED = "paused"
CLAIMED = db.CLAIMED
# The routing states of a comment waiting for its handle: what a pull returns.
WAITING = (PENDING, UNAVAILABLE, PAUSED)
# Seconds a claim lasts unless the config's [comments] claim_sec says otherwise.
DEFAULT_CLAIM = 900
# Messages after a thread's root that a pulled item carries.
THREAD_TAIL = 20

_MENTION = re.compile(r"@([a-z0-9][a-z0-9-]{0,62})", re.IGNORECASE)


def _ends_mention(char: str) -> bool:
    return (char.isspace() or char in string.punctuation
            or unicodedata.category(char).startswith("P"))


def mention(text: str) -> str | None:
    """The handle text starts by naming, in lower case; None when it names none."""
    match = _MENTION.match(text)
    if match is None:
        return None
    rest = text[match.end():]
    if rest and not _ends_mention(rest[0]):
        return None
    return match.group(1).lower()


def seconds(stamp: str | None) -> float | None:
    """A stored time as seconds since the epoch; None for None."""
    if stamp is None:
        return None
    return datetime.datetime.fromisoformat(stamp.replace("Z", "+00:00")).timestamp()


def listening(handle: str, pulls: Mapping[str, float], window: float, now: float) -> bool:
    last = pulls.get(handle)
    return last is not None and now - last <= window


def lapsed(comment: Mapping, now: float) -> bool:
    """Whether the comment is claimed and its claim has expired."""
    expires = seconds(comment["claim"]["expiresAt"])
    return comment["state"] == CLAIMED and (expires is None or expires <= now)


def route(comment: Mapping, pulls: Mapping[str, float], window: float,
          now: float, paused: bool = False,
          thread: Mapping | None = None) -> tuple[str, str] | None:
    """(handle, state) of a reader's comment; None for an agent's reply.

    pulls maps handles to their last pull, in seconds since the epoch;
    paused is whether the responder is paused; thread is the comment's
    thread {root, replies}, of which only the replies before it count, or
    None for a thread's root.
    """
    if comment["actor"].get("kind") != "human":
        return None
    state = PENDING if lapsed(comment, now) else comment["state"]
    if state != PENDING:
        return comment["claim"]["handle"] or _routed(comment, thread, pulls, window, now), state
    handle = _routed(comment, thread, pulls, window, now)
    if handle == RESPONDER and paused:
        return handle, PAUSED
    return handle, PENDING if listening(handle, pulls, window, now) else UNAVAILABLE


def _routed(comment: Mapping, thread: Mapping | None, pulls: Mapping[str, float],
            window: float, now: float) -> str:
    """The handle a comment no agent has taken up is routed to: the one it
    mentions, else, for a reply, its thread's last answering agent while that
    one is listening, else the responder."""
    named = mention(comment["text"])
    if named is not None:
        return named
    if thread is not None and comment.get("parent") is not None:
        before = [row for row in thread["replies"] if row["id"] < comment["id"]]
        agents = [row["actor"]["handle"] for row in before
                  if row["actor"].get("kind") == "agent" and row["actor"].get("handle")]
        if agents and listening(agents[-1], pulls, window, now):
            return agents[-1]
    return RESPONDER


def thread_of(database: db.Database, comment: Mapping) -> dict | None:
    """The thread route() takes for comment: None for a thread's root."""
    return None if comment.get("parent") is None else database.thread(comment["parent"])


def last_pulls(database: db.Database) -> dict[str, float]:
    """Each handle's last pull, in seconds since the epoch."""
    return {handle: seconds(stamp) for handle, stamp in database.pulls().items()}


def public(comment: Mapping, pulls: Mapping[str, float], window: float, now: float,
           paused: bool = False, thread: Mapping | None = None) -> dict:
    """The comment as it is shown: its `owner` the handle it is routed to
    (None for an agent's reply) and its `state` its routing state; thread
    as route() takes it."""
    row = {key: value for key, value in comment.items() if key not in ("arrival", "claim")}
    routed = route(comment, pulls, window, now, paused, thread)
    row["owner"] = None if routed is None else routed[0]
    if routed is not None:
        row["state"] = routed[1]
    return row


def thread(found: Mapping, pulls: Mapping[str, float], window: float, now: float,
           paused: bool = False) -> dict:
    """A thread {root, replies, resolution} as it is shown."""
    return {
        "root": public(found["root"], pulls, window, now, paused),
        "replies": [public(row, pulls, window, now, paused, found)
                    for row in found["replies"]],
        "resolution": found["resolution"],
    }


def threads(database: db.Database, page: str, window: float, now: float) -> list[dict]:
    """The page's threads as the threads routes answer them."""
    pulls, paused = last_pulls(database), database.responder_paused()
    return [thread(found, pulls, window, now, paused) for found in database.threads(page)]


def shown(database: db.Database, comment: Mapping, window: float, now: float) -> dict:
    """The comment as public() shows it, as the database stands now."""
    return public(comment, last_pulls(database), window, now,
                  database.responder_paused(), thread_of(database, comment))
