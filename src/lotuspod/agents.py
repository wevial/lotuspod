"""`lotuspod comments`: what an agent reads over serve's socket.

    lotuspod comments pull --owner HANDLE   GET  /v1/pull?owner=HANDLE
    lotuspod comments ack-answer ID         POST /v1/answers/ID/ack
    lotuspod comments show PAGE             GET  /v1/threads?page=PAGE

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


def _ask(args: argparse.Namespace, method: str, target: str) -> dict:
    """The socket's JSON for one request; _Failed naming the refusal."""
    try:
        token = cli.agent_token(args)
    except cli.ConfigError as exc:
        raise _Failed("no_credential", str(exc)) from None
    socket_path = cli.agent_socket(args)
    try:
        status, payload = machine.request(socket_path, token, method, target)
    except OSError as exc:
        raise _Failed("socket_unavailable", f"cannot reach serve on {socket_path}: {exc}") from None
    except ValueError:
        raise _Failed("invalid_response", "serve's answer is not JSON") from None
    if status != 200:
        raise _Failed(str(payload.get("error") or status))
    return payload


def _run(args: argparse.Namespace, method: str, target: str, text) -> int:
    try:
        payload = _ask(args, method, target)
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
            lines += [fence(comment["text"]), ""]
            about = "the thread's first comment and its latest replies"
            if thread["omitted"]:
                about += f"; {thread['omitted']} earlier replies left out"
            lines += [f"### Thread ({about})", ""]
            for row in (thread["root"], *thread["replies"]):
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


def cmd_pull(args: argparse.Namespace) -> int:
    target = "/v1/pull?" + urllib.parse.urlencode({"owner": args.owner})
    return _run(args, "GET", target, pull_text)


def cmd_ack_answer(args: argparse.Namespace) -> int:
    return _run(args, "POST", f"/v1/answers/{args.id}/ack", ack_text)


def cmd_show(args: argparse.Namespace) -> int:
    target = "/v1/threads?" + urllib.parse.urlencode({"page": args.page})
    return _run(args, "GET", target, show_text)


def _answer_id(value: str) -> int:
    if not value.isdigit() or int(value) < 1:
        raise argparse.ArgumentTypeError(f"not an answer id: {value!r}")
    return int(value)


def add_parser(sub: argparse._SubParsersAction) -> None:
    """Register `lotuspod comments` and its actions."""
    parser = sub.add_parser(
        "comments",
        help="read the comments routed to an agent and the answers on its pages, "
        "over serve's socket",
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
