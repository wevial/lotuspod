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
`pending` while the handle it is routed to is listening, else `unavailable`.
A comment an agent has taken up keeps the state stored with it.

`route()` is a pure function of the comment (which keeps its page's owner and
that owner's last pull as it arrived), the last-pull times, the window and
the clock, so the threads routes, the pull and the claim all agree.
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


def route(comment: Mapping, pulls: Mapping[str, float], window: float,
          now: float) -> tuple[str, str] | None:
    """(handle, state) of a reader's comment; None for an agent's reply.

    pulls maps handles to their last pull, in seconds since the epoch.
    """
    if comment["actor"].get("kind") != "human":
        return None
    handle = mention(comment["text"])
    if handle is None:
        arrival = comment["arrival"]
        arrived = seconds(comment["createdAt"])
        pulled = seconds(arrival["ownerPull"])
        owner_held = (arrival["owner"] and pulled is not None
                      and arrived - pulled <= window and now - arrived < window)
        handle = arrival["owner"] if owner_held else RESPONDER
    if comment["state"] != PENDING:
        return handle, comment["state"]
    return handle, PENDING if listening(handle, pulls, window, now) else UNAVAILABLE


def last_pulls(database: db.Database) -> dict[str, float]:
    """Each handle's last pull, in seconds since the epoch."""
    return {handle: seconds(stamp) for handle, stamp in database.pulls().items()}


def public(comment: Mapping, pulls: Mapping[str, float], window: float, now: float) -> dict:
    """The comment as it is shown: its `owner` the handle it is routed to
    (None for an agent's reply) and its `state` its routing state."""
    row = {key: value for key, value in comment.items() if key != "arrival"}
    routed = route(comment, pulls, window, now)
    row["owner"] = None if routed is None else routed[0]
    if routed is not None:
        row["state"] = routed[1]
    return row


def thread(found: Mapping, pulls: Mapping[str, float], window: float, now: float) -> dict:
    """A thread {root, replies} as it is shown."""
    return {
        "root": public(found["root"], pulls, window, now),
        "replies": [public(row, pulls, window, now) for row in found["replies"]],
    }


def threads(database: db.Database, page: str, window: float, now: float) -> list[dict]:
    """The page's threads as the threads routes answer them."""
    pulls = last_pulls(database)
    return [thread(found, pulls, window, now) for found in database.threads(page)]
