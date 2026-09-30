"""`lotuspod comments`: what an agent reads and answers over serve's socket.

    lotuspod comments pull --owner HANDLE   GET  /v1/pull?owner=HANDLE
    lotuspod comments ack-answer ID         POST /v1/answers/ID/ack
    lotuspod comments show PAGE             GET  /v1/threads?page=PAGE
    lotuspod comments claim ID              POST /v1/comments/ID/claim
    lotuspod comments reply ID --claim TOKEN --key KEY (--text TEXT | --text-file PATH)
        [--revision R]                      POST /v1/comments/ID/reply
    lotuspod comments release ID --claim TOKEN
                                            POST /v1/comments/ID/release
    lotuspod comments fail ID --claim TOKEN --reason TEXT
                                            POST /v1/comments/ID/fail

Each takes --socket and --credential as every agent command does, prints the
socket's JSON with --json and readable markdown without it, and exits 1 on a
refusal, printing {"error": CODE} with --json. In the markdown, every text a
reader wrote sits in a fence longer than its longest run of backticks, so no
reader's text can end its fence and pass for the output around it.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import urllib.parse

# cli imports this module too: only names used at call time are read from it.
from lotuspod import cli, machine

_BACKTICKS = re.compile(r"`+")


def fence(text: str, info: str = "") -> str:
    """text in a backtick fence longer than its longest run of backticks."""
    longest = max((len(run) for run in _BACKTICKS.findall(text)), default=0)
    marks = "`" * max(3, longest + 1)
    body = text if text.endswith("\n") else text + "\n"
    return f"{marks}{info}\n{body}{marks}"


class _Failed(Exception):
    def __init__(self, error: str, message: str = "") -> None:
        super().__init__(error)
        self.error = error
        self.message = message


def _ask(args: argparse.Namespace, method: str, target: str, body: object = None) -> dict:
    """The socket's JSON for one request; _Failed naming the refusal."""
    try:
        token = cli.agent_token(args)
    except cli.ConfigError as exc:
        raise _Failed("no_credential", str(exc)) from None
    socket_path = cli.agent_socket(args)
    try:
        status, payload = machine.request(socket_path, token, method, target, body)
    except OSError as exc:
        raise _Failed("socket_unavailable", f"cannot reach serve on {socket_path}: {exc}") from None
    except ValueError:
        raise _Failed("invalid_response", "serve's answer is not JSON") from None
    if status != 200:
        raise _Failed(str(payload.get("error") or status))
    return payload


def _run(args: argparse.Namespace, method: str, target: str, text, body: object = None) -> int:
    try:
        payload = _ask(args, method, target, body)
    except _Failed as exc:
        if exc.message:
            print(f"error: {exc.message}", file=sys.stderr)
        if args.json:
            print(json.dumps({"error": exc.error}))
        elif not exc.message:
            print(f"error: {exc.error}", file=sys.stderr)
        return 1
    print(json.dumps(payload, indent=2) if args.json else text(payload))
    return 0


def _by(row: dict) -> str:
    actor = row.get("actor") or {}
    if actor.get("kind") == "human":
        return str(actor.get("email") or "a reader")
    return str(actor.get("handle") or actor.get("name") or "an agent")


def _standing(row: dict) -> str:
    if row.get("owner"):
        return f"{row['state']}, routed to {row['owner']}"
    return str(row.get("state", ""))


def _section(row: dict) -> str:
    title = row.get("sectionTitle") or ""
    return f"{title} (`{row['section']}`)" if title else f"`{row['section']}`"


def _message(row: dict, level: str) -> list[str]:
    """One comment of a thread: who, when, where it stands, and its text."""
    kind = "Comment" if row.get("parent") is None else "Reply"
    head = f"{level} {kind} {row['id']}, {_by(row)}, {row['createdAt']}"
    if row.get("owner"):
        head += f" ({_standing(row)})"
    lines = [head, ""]
    if row.get("quote"):
        lines += ["Quoting the page:", "", fence(row["quote"]["exact"]), ""]
    lines += [fence(row["text"]), ""]
    return lines


def _page_lines(page: dict) -> list[str]:
    source = page["sourceFile"] or "none kept"
    return [
        f"- Page: `{page['name']}`, {page['title']}; owner {page['owner'] or 'none'}",
        f"- Revision: {page['revision']}; source file: {source}",
    ]


def pull_text(payload: dict) -> str:
    """`comments pull` without --json."""
    items = payload["items"]
    lines = [f"# Pull for {payload['owner']}: {len(items)} "
             f"item{'' if len(items) == 1 else 's'}", ""]
    if not items:
        lines.append("Nothing waits for this handle.")
    pages: dict[str, dict] = {}
    for number, item in enumerate(items, 1):
        page = item["page"]
        pages.setdefault(page["name"], page)
        if item["kind"] == "comment":
            comment, thread = item["comment"], item["thread"]
            lines += [
                f"## {number}. Comment {comment['id']} on `{page['name']}`, "
                f"section {_section(comment)}",
                "",
                *_page_lines(page),
                f"- From: {_by(comment)} at {comment['createdAt']}, "
                f"against revision {comment['revision'] or 'unknown'}",
                f"- State: {_standing(comment)}",
                "",
            ]
            if comment.get("quote"):
                lines += ["Quoting the page:", "", fence(comment["quote"]["exact"]), ""]
            lines += [fence(comment["text"]), "",
                      f"- Claim: `lotuspod comments claim {comment['id']}`", ""]
            about = "the thread's first comment and its latest replies"
            if item["omitted"]:
                about += f"; {item['omitted']} earlier replies left out"
            lines += [f"### Thread ({about})", ""]
            for row in thread:
                lines += _message(row, "####")
        else:
            answer, question = item["answer"], item["question"]
            asked = question["text"] or "(its words were not kept)"
            if question["reworded"]:
                asked += " (the page now asks it in other words, or not at all)"
            lines += [
                f"## {number}. Answer {answer['id']} on `{page['name']}`, "
                f"question `{question['id']}`",
                "",
                *_page_lines(page),
                f"- Question: {asked}",
                f"- Chosen: {question['label']} (`{answer['choice']}`)",
                f"- From: {_by(answer)} at {answer['createdAt']}, "
                f"against revision {answer['revision'] or 'unknown'}",
                f"- Acknowledge: `lotuspod comments ack-answer {answer['id']}`",
                "",
                "The answer is the reader's choice on this question only.",
                "",
            ]
            if answer["note"]:
                lines += ["Note:", "", fence(answer["note"]), ""]
    for page in pages.values():
        if not page["sourceFile"]:
            continue
        lines += [f"## Source of `{page['name']}`: {page['sourceFile']}, "
                  f"revision {page['revision']}", "", fence(page["source"]), ""]
    return "\n".join(lines).rstrip("\n")


def ack_text(payload: dict) -> str:
    return (f"answer {payload['answer']} acknowledged for {payload['owner']} "
            f"at {payload['ackedAt']}")


def show_text(payload: dict) -> str:
    """`comments show` without --json."""
    threads = payload["threads"]
    lines = [f"# Threads on `{payload['page']}`: {len(threads)}", ""]
    if not threads:
        lines.append("No comments yet.")
    for thread in threads:
        root = thread["root"]
        lines += [f"## Section {_section(root)}", ""]
        for row in (root, *thread["replies"]):
            lines += _message(row, "###")
    return "\n".join(lines).rstrip("\n")


def claim_text(payload: dict) -> str:
    return (f"comment {payload['comment']} claimed as {payload['handle']} until "
            f"{payload['expiresAt']}\nclaim token: {payload['claimToken']}")


def reply_text(payload: dict) -> str:
    return f"reply {payload['id']} stored in the thread of comment {payload['parent']}"


def settled_text(payload: dict) -> str:
    line = f"comment {payload['id']} is {_standing(payload)}"
    if payload.get("reason"):
        line += f": {payload['reason']}"
    return line


def cmd_pull(args: argparse.Namespace) -> int:
    target = "/v1/pull?" + urllib.parse.urlencode({"owner": args.owner})
    return _run(args, "GET", target, pull_text)


def cmd_ack_answer(args: argparse.Namespace) -> int:
    return _run(args, "POST", f"/v1/answers/{args.id}/ack", ack_text)


def cmd_show(args: argparse.Namespace) -> int:
    target = "/v1/threads?" + urllib.parse.urlencode({"page": args.page})
    return _run(args, "GET", target, show_text)


def cmd_claim(args: argparse.Namespace) -> int:
    return _run(args, "POST", f"/v1/comments/{args.id}/claim", claim_text)


def cmd_reply(args: argparse.Namespace) -> int:
    if args.text_file is not None:
        try:
            with open(args.text_file, encoding="utf-8") as fh:
                text = fh.read()
        except (OSError, UnicodeDecodeError) as exc:
            print(f"error: cannot read {args.text_file}: {exc}", file=sys.stderr)
            if args.json:
                print(json.dumps({"error": "unreadable_text"}))
            return 1
    else:
        text = args.text
    body = {"claimToken": args.claim, "idempotencyKey": args.key, "text": text}
    if args.revision is not None:
        body["revision"] = args.revision
    return _run(args, "POST", f"/v1/comments/{args.id}/reply", reply_text, body)


def cmd_release(args: argparse.Namespace) -> int:
    return _run(args, "POST", f"/v1/comments/{args.id}/release", settled_text,
                {"claimToken": args.claim})


def cmd_fail(args: argparse.Namespace) -> int:
    return _run(args, "POST", f"/v1/comments/{args.id}/fail", settled_text,
                {"claimToken": args.claim, "reason": args.reason})


def _answer_id(value: str) -> int:
    if not value.isdigit() or int(value) < 1:
        raise argparse.ArgumentTypeError(f"not an answer id: {value!r}")
    return int(value)


def _comment_id(value: str) -> int:
    if not value.isdigit() or int(value) < 1:
        raise argparse.ArgumentTypeError(f"not a comment id: {value!r}")
    return int(value)


def add_parser(sub: argparse._SubParsersAction) -> None:
    """Register `lotuspod comments` and its actions."""
    parser = sub.add_parser(
        "comments",
        help="read the comments routed to an agent and the answers on its pages, and "
        "claim and answer comments, over serve's socket",
    )
    actions = parser.add_subparsers(dest="action", required=True)

    pull = actions.add_parser(
        "pull",
        help="the comments routed to HANDLE and the new answers on its pages, each with "
        "the page's source and revision; takes nothing off the queue",
        description="Print the comments routed to HANDLE and the answers on its pages it "
        "has not acknowledged, each with the page's source, revision, a bounded thread and "
        "the verified author. Records that HANDLE is listening; claims and settles nothing, "
        "so the same items come back until they are claimed or acknowledged. Needs a "
        "credential that may pull as HANDLE.",
    )
    pull.add_argument("--owner", required=True, metavar="HANDLE", help="the handle to pull for")
    pull.add_argument("--json", action="store_true", help="print the socket's JSON")
    cli.add_agent_options(pull)
    pull.set_defaults(func=cmd_pull)

    ack = actions.add_parser(
        "ack-answer",
        help="mark an answer as had by its page's owner, so its pulls leave it out",
    )
    ack.add_argument("id", type=_answer_id, metavar="ID", help="the answer's id")
    ack.add_argument("--json", action="store_true", help="print the socket's JSON")
    cli.add_agent_options(ack)
    ack.set_defaults(func=cmd_ack_answer)

    show = actions.add_parser(
        "show", help="a page's threads, as the reader's threads route answers them"
    )
    show.add_argument("page", metavar="PAGE", help="the page's name")
    show.add_argument("--json", action="store_true", help="print the socket's JSON")
    cli.add_agent_options(show)
    show.set_defaults(func=cmd_show)

    claim = actions.add_parser(
        "claim",
        help="take a comment routed to one of the credential's handles up, so no other "
        "agent answers it",
        description="Claim comment ID for the handle it is routed to. Prints the claim "
        "token a reply, release or failure names, and when the claim expires (the "
        "config's [comments] claim_sec after now); an expired claim lapses and the "
        "comment is routed again. Needs a credential with claim and that handle.",
    )
    claim.add_argument("id", type=_comment_id, metavar="ID", help="the comment's id")
    claim.add_argument("--json", action="store_true", help="print the socket's JSON")
    cli.add_agent_options(claim)
    claim.set_defaults(func=cmd_claim)

    reply = actions.add_parser(
        "reply",
        help="answer a claimed comment, once per idempotency key",
        description="Reply to comment ID under the claim TOKEN names. Choose KEY once per "
        "intended reply, before acting, and send the same KEY again after a crash: a key "
        "this credential has used before prints the reply stored with it, and nothing is "
        "stored twice. With --revision, the reply says it revised the page to revision R, "
        "which must be the page's current revision. The comment becomes answered and the "
        "claim ends. Needs a credential with reply.",
    )
    reply.add_argument("id", type=_comment_id, metavar="ID", help="the comment's id")
    reply.add_argument("--claim", required=True, metavar="TOKEN",
                       help="the claim token `comments claim` printed")
    reply.add_argument("--key", required=True, metavar="KEY",
                       help="the idempotency key of this reply, chosen before acting")
    text = reply.add_mutually_exclusive_group(required=True)
    text.add_argument("--text", metavar="TEXT", help="the reply's text")
    text.add_argument("--text-file", metavar="PATH", help="a UTF-8 file holding the reply's text")
    reply.add_argument("--revision", default=None, metavar="R",
                       help="the page's revision after the agent revised it")
    reply.add_argument("--json", action="store_true", help="print the socket's JSON")
    cli.add_agent_options(reply)
    reply.set_defaults(func=cmd_reply)

    release = actions.add_parser(
        "release", help="end a claim unanswered, so the comment is routed again",
    )
    release.add_argument("id", type=_comment_id, metavar="ID", help="the comment's id")
    release.add_argument("--claim", required=True, metavar="TOKEN", help="the claim token")
    release.add_argument("--json", action="store_true", help="print the socket's JSON")
    cli.add_agent_options(release)
    release.set_defaults(func=cmd_release)

    fail = actions.add_parser(
        "fail",
        help="give up on a claimed comment, with a reason the page shows; nothing retries it",
    )
    fail.add_argument("id", type=_comment_id, metavar="ID", help="the comment's id")
    fail.add_argument("--claim", required=True, metavar="TOKEN", help="the claim token")
    fail.add_argument("--reason", required=True, metavar="TEXT",
                      help="why, in up to 200 characters")
    fail.add_argument("--json", action="store_true", help="print the socket's JSON")
    cli.add_agent_options(fail)
    fail.set_defaults(func=cmd_fail)
