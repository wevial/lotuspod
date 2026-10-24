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

import bisect
import datetime
import re
import string
import unicodedata
from typing import Callable, Mapping

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
    return _route(comment, pulls, window, now, paused,
                  lambda: None if thread is None else _answerer(_agents(thread), comment))


def _route(comment: Mapping, pulls: Mapping[str, float], window: float, now: float,
           paused: bool, answerer: Callable[[], str | None]) -> tuple[str, str] | None:
    """route(), the thread's latest agent before the comment read from
    answerer(), which is called only for a reply that names no handle."""
    if comment["actor"].get("kind") != "human":
        return None
    state = PENDING if lapsed(comment, now) else comment["state"]
    if state != PENDING:
        return comment["claim"]["handle"] or _routed(comment, answerer, pulls, window, now), state
    handle = _routed(comment, answerer, pulls, window, now)
    if handle == RESPONDER and paused:
        return handle, PAUSED
    return handle, PENDING if listening(handle, pulls, window, now) else UNAVAILABLE


def _routed(comment: Mapping, answerer: Callable[[], str | None],
            pulls: Mapping[str, float], window: float, now: float) -> str:
    """The handle a comment no agent has taken up is routed to: the one it
    mentions, else, for a reply, its thread's last answering agent while that
    one is listening, else the responder."""
    named = mention(comment["text"])
    if named is not None:
        return named
    if comment.get("parent") is not None:
        handle = answerer()
        if handle is not None and listening(handle, pulls, window, now):
            return handle
    return RESPONDER


def _agents(thread: Mapping) -> tuple[list[int], list[str]]:
    """The ids of the thread's agent replies, oldest first, and their handles."""
    found = [(row["id"], row["actor"]["handle"]) for row in thread["replies"]
             if row["actor"].get("kind") == "agent" and row["actor"].get("handle")]
    return [row_id for row_id, _ in found], [handle for _, handle in found]


def _answerer(agents: tuple[list[int], list[str]], comment: Mapping) -> str | None:
    """The handle of the latest agent reply before comment; None for none."""
    ids, handles = agents
    at = bisect.bisect_left(ids, comment["id"])
    return handles[at - 1] if at else None


def thread_of(database: db.Database, comment: Mapping) -> dict | None:
    """The thread route() takes for comment: None for a thread's root."""
    return None if comment.get("parent") is None else database.thread(comment["parent"])


class Threads:
    """Many comments routed and shown as of one moment, each thread loaded
    from the database at most once, and only when a comment needs it."""

    def __init__(self, database: db.Database, pulls: Mapping[str, float], window: float,
                 now: float, paused: bool = False) -> None:
        self.database, self.pulls, self.window = database, pulls, window
        self.now, self.paused = now, paused
        self._loaded: dict[int, dict] = {}
        self._indexed: dict[int, tuple[list[int], list[str]]] = {}

    def of(self, comment: Mapping) -> dict:
        """The comment's thread {root, replies, resolution}."""
        root = comment.get("parent") or comment["id"]
        if root not in self._loaded:
            self._loaded[root] = self.database.thread(root)
        return self._loaded[root]

    def _answerer(self, comment: Mapping) -> str | None:
        root = comment.get("parent") or comment["id"]
        if root not in self._indexed:
            self._indexed[root] = _agents(self.of(comment))
        return _answerer(self._indexed[root], comment)

    def route(self, comment: Mapping) -> tuple[str, str] | None:
        """route() of the comment, its thread loaded as needed."""
        return _route(comment, self.pulls, self.window, self.now, self.paused,
                      lambda: self._answerer(comment))

    def public(self, comment: Mapping) -> dict:
        """public() of the comment, its thread loaded as needed."""
        return _shown(comment, self.route(comment))


def last_pulls(database: db.Database) -> dict[str, float]:
    """Each handle's last pull, in seconds since the epoch."""
    return {handle: seconds(stamp) for handle, stamp in database.pulls().items()}


def public(comment: Mapping, pulls: Mapping[str, float], window: float, now: float,
           paused: bool = False, thread: Mapping | None = None) -> dict:
    """The comment as it is shown: its `owner` the handle it is routed to
    (None for an agent's reply) and its `state` its routing state; thread
    as route() takes it."""
    return _shown(comment, route(comment, pulls, window, now, paused, thread))


def _shown(comment: Mapping, routed: tuple[str, str] | None) -> dict:
    row = {key: value for key, value in comment.items() if key not in ("arrival", "claim")}
    row["owner"] = None if routed is None else routed[0]
    if routed is not None:
        row["state"] = routed[1]
    return row


def thread(found: Mapping, pulls: Mapping[str, float], window: float, now: float,
           paused: bool = False) -> dict:
    """A thread {root, replies, resolution} as it is shown."""
    agents = _agents(found)
    return {
        "root": public(found["root"], pulls, window, now, paused),
        "replies": [_shown(row, _route(row, pulls, window, now, paused,
                                       lambda row=row: _answerer(agents, row)))
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
