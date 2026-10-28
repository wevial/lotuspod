"""A reader's emoji reaction on a comment, over POST /api/comments.

    POST /api/comments    {page, comment, emoji, reacted}

adds the reader's reaction `emoji` to comment `comment` on `page` when
`reacted` is true and removes it when false, and answers 200 {comment,
reactions}, the comment's reactions as a read of the comments gives them
(lotuspod.store.reactions). Adding one twice, or removing one that is not
there, stores nothing new and answers the same. A reaction is no comment:
it routes nothing, is no reply, makes nothing unread and leaves a resolved
thread resolved. Every comment a read of the comments answers carries its
`reactions`, and so does the comment a new thread, a reply or an answer's
note answers.

`emoji` is exactly one of the values of the composers' emoji table
(core.EMOJI_TABLE), compared as sent. After the refusals every POST meets,
it is refused, with nothing stored, in this order: 400 invalid_body for any
other keys, a `comment` that is not a positive id, a `reacted` that is not a
boolean or an emoji not in the table; 404 unknown_page; 409 archived; and 404
unknown_comment for an id that is no comment on the page.
"""

from __future__ import annotations

import functools
import json
from http import HTTPStatus
from typing import Mapping

from lotuspod import core
from lotuspod import store
from lotuspod.features.serve import api


@functools.cache
def emoji_table() -> Mapping[str, str]:
    """The composers' emoji table: each shortcode, without its colons, to its emoji."""
    path = core.THEME_ROOT / core.THEME_FILE_SOURCES[core.EMOJI_TABLE]
    return json.loads(path.read_text(encoding="utf-8"))


@functools.cache
def _emojis() -> frozenset[str]:
    return frozenset(emoji_table().values())


def checked_emoji(value: object) -> str:
    """value when it is exactly one of the emoji table's values; Refusal
    invalid_body for anything else."""
    if not isinstance(value, str) or value not in _emojis():
        raise api._invalid()
    return value


def reactor(actor: Mapping) -> str:
    """The reactor a reader reacts as: their verified address."""
    return str(actor.get("email") or "")


def is_reaction(fields: Mapping) -> bool:
    """Whether a comments POST's body is a reaction's, by its keys."""
    return not {"comment", "emoji", "reacted"}.isdisjoint(fields)


def post(routes: api.Api, fields: dict, actor: Mapping) -> dict:
    """Add or remove the reader's reaction as fields say."""
    api._keys(fields, {"page", "comment", "emoji", "reacted"})
    comment = api._id(fields["comment"])
    reacted = fields["reacted"]
    if not isinstance(reacted, bool):
        raise api._invalid()
    chosen = checked_emoji(fields["emoji"])
    page = routes._open_page(fields["page"])
    found = routes.database.comment(comment)
    if found is None or found["page"] != page.name:
        raise api.Refusal(HTTPStatus.NOT_FOUND, "unknown_comment")
    reader = reactor(actor)
    if reacted:
        store.reactions.add(routes.database, comment, chosen, reader, actor)
    else:
        store.reactions.remove(routes.database, comment, chosen, reader)
    routes.changed("comment", page.name)
    return {"comment": comment,
            "reactions": store.reactions.on_comment(routes.database, comment, {reader})}
