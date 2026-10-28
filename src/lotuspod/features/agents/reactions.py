"""An agent's emoji reaction on a comment, over serve's socket.

    POST /v1/comments/ID/reactions      {emoji, reacted}: add (reacted true)
                                        or remove the agent's reaction on
                                        comment ID (needs reply, as a
                                        follow-up does)

It acts as a follow-up to the comment's thread does, as the page's owner
when the credential holds it, else as the handle the thread's first comment
is routed to, and stores the reaction as `agent:HANDLE`
(lotuspod.store.reactions). It answers {comment, reactions}, `mine` true on
an emoji one of the credential's handles reacted with. It writes no audit
row, takes no claim and changes no comment's state. It is refused, with
nothing stored, 403 operation_not_allowed without reply, 404
unknown_comment for an id no comment has, 403 not_routed as a follow-up is,
and 400 invalid_body for a body not of that shape or an emoji not in the
composers' table, compared as sent. Every comment `GET /v1/threads` answers
carries its reactions, and so does the comment a reply, follow-up, release
or failure answers; a pull's and the inbox's comments carry none.

    lotuspod comments react ID EMOJI [--remove]
                                        POST /v1/comments/ID/reactions

EMOJI is an emoji, or a :shortcode: the composers' table names (:eyes:
sends 👀); anything else is sent as typed, for serve to refuse. Without
--json it prints one line per emoji, `👀 1: hermes`.
"""

from __future__ import annotations

import argparse
import re
from email.message import Message
from http import HTTPStatus
from typing import Mapping

from lotuspod import store
from lotuspod.features import serve
from lotuspod.features.agents import agents, machine

_ID = re.compile(r"[1-9][0-9]{0,18}")


def post(sockets: machine.Routes, credential: Mapping, comment_id: int,
         headers: Message, body: serve.Body | None) -> dict:
    """Add or remove credential's reaction on comment_id as the body says."""
    machine._allow_op(credential, "reply")
    found = sockets.database.comment(comment_id)
    if found is None:
        raise serve.Refusal(HTTPStatus.NOT_FOUND, "unknown_comment")
    _page, handle = sockets._thread_handle(credential, found["parent"] or found["id"])
    fields = machine._json_body(headers, body)
    serve._keys(fields, {"emoji", "reacted"})
    emoji = serve.checked_emoji(fields["emoji"])
    reacted = fields["reacted"]
    if not isinstance(reacted, bool):
        raise serve.Refusal(HTTPStatus.BAD_REQUEST, "invalid_body")
    reactor = store.reactions.agent(handle)
    if reacted:
        actor = {"kind": "agent", "handle": handle, "credential": credential["name"]}
        store.reactions.add(sockets.database, comment_id, emoji, reactor, actor)
    else:
        store.reactions.remove(sockets.database, comment_id, emoji, reactor)
    sockets.changed("comment", found["page"])
    return {"comment": comment_id, "reactions": store.reactions.on_comment(
        sockets.database, comment_id, mine(credential))}


def mine(credential: Mapping) -> set[str]:
    """The reactors credential reacts as: each of its handles."""
    return {store.reactions.agent(handle) for handle in credential["handles"]}


def react_text(payload: dict) -> str:
    """`comments react` without --json."""
    lines = [f"{entry['emoji']} {entry['count']}: {', '.join(entry['by'])}"
             for entry in payload["reactions"]]
    return "\n".join(lines) or f"comment {payload['comment']} has no reactions"


def cmd_react(args: argparse.Namespace) -> int:
    if not _ID.fullmatch(args.id):
        return agents._refused(args, agents._Failed("invalid_body",
                                                    f"not a comment id: {args.id!r}"))
    emoji = args.emoji
    if len(emoji) > 2 and emoji[0] == emoji[-1] == ":":
        emoji = serve.emoji_table().get(emoji[1:-1], emoji)
    return agents._run(args, "POST", f"/v1/comments/{args.id}/reactions", react_text,
                       {"emoji": emoji, "reacted": not args.remove})
