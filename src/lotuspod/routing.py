"""Where a reader's comment goes: one rule, used wherever a comment's
destination is shown or checked.

A reader's comment no agent has taken up yet is routed to one handle:

- A comment whose text starts with `@HANDLE` (a handle in any case, then
  whitespace, punctuation or the end) goes to HANDLE and only ever to it;
  `@responder` names the default responder.
- Otherwise, on a page whose owner was listening when the comment arrived,
  it goes to the owner until the owner window has passed since it arrived.
- Otherwise it goes to the default responder, `responder`.

A handle is listening when its last pull is within the window. A comment is
`pending` while the handle it is routed to is listening, else `unavailable`;
one routed to the responder is `paused` while the responder is paused.

A comment an agent has taken up keeps the state stored with it and is shown
as the handle's that took it: `claimed` while the claim is current,
`answered` once replied to, `failed` once the agent gave up on it. A claim
that has expired simply lapses: the comment is routed again, as if never
claimed.

`route()` is a pure function of the comment (which keeps its page's owner and
that owner's last pull as it arrived, and its claim), the last-pull times,
the window, the clock and whether the responder is paused, so the threads
routes, the pull and the claim all agree.
"""

from __future__ import annotations

import datetime
import re
import string
import unicodedata
from typing import Mapping

from lotuspod import db

RESPONDER = "responder"
# Seconds: how long a pull keeps a handle listening, and how long a page's
# listening owner holds a comment before the responder gets it.
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
          now: float, paused: bool = False) -> tuple[str, str] | None:
    """(handle, state) of a reader's comment; None for an agent's reply.

    pulls maps handles to their last pull, in seconds since the epoch;
    paused is whether the responder is paused.
    """
    if comment["actor"].get("kind") != "human":
        return None
    state = PENDING if lapsed(comment, now) else comment["state"]
    if state != PENDING:
        return comment["claim"]["handle"] or _routed(comment, window, now), state
    handle = _routed(comment, window, now)
    if handle == RESPONDER and paused:
        return handle, PAUSED
    return handle, PENDING if listening(handle, pulls, window, now) else UNAVAILABLE


def arrival_owner(comment: Mapping, window: float) -> str:
    """The page's owner when a reader's comment with no mention arrived
    while it was listening, so the comment was routed to it then; "" otherwise."""
    if mention(comment["text"]) is not None:
        return ""
    arrival = comment["arrival"]
    pulled = seconds(arrival["ownerPull"])
    if not arrival["owner"] or pulled is None:
        return ""
    return arrival["owner"] if seconds(comment["createdAt"]) - pulled <= window else ""


def _routed(comment: Mapping, window: float, now: float) -> str:
    """The handle a comment no agent has taken up is routed to."""
    handle = mention(comment["text"])
    if handle is None:
        owner = arrival_owner(comment, window)
        owner_held = owner and now - seconds(comment["createdAt"]) < window
        handle = owner if owner_held else RESPONDER
    return handle


def last_pulls(database: db.Database) -> dict[str, float]:
    """Each handle's last pull, in seconds since the epoch."""
    return {handle: seconds(stamp) for handle, stamp in database.pulls().items()}


def public(comment: Mapping, pulls: Mapping[str, float], window: float, now: float,
           paused: bool = False) -> dict:
    """The comment as it is shown: its `owner` the handle it is routed to
    (None for an agent's reply) and its `state` its routing state."""
    row = {key: value for key, value in comment.items() if key not in ("arrival", "claim")}
    routed = route(comment, pulls, window, now, paused)
    row["owner"] = None if routed is None else routed[0]
    if routed is not None:
        row["state"] = routed[1]
    return row


def thread(found: Mapping, pulls: Mapping[str, float], window: float, now: float,
           paused: bool = False) -> dict:
    """A thread {root, replies} as it is shown."""
    return {
        "root": public(found["root"], pulls, window, now, paused),
        "replies": [public(row, pulls, window, now, paused) for row in found["replies"]],
    }


def threads(database: db.Database, page: str, window: float, now: float) -> list[dict]:
    """The page's threads as the threads routes answer them."""
    pulls, paused = last_pulls(database), database.responder_paused()
    return [thread(found, pulls, window, now, paused) for found in database.threads(page)]
