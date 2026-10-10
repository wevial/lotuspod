"""`lotuspod comments`: what an agent reads and answers over serve's socket.

    lotuspod comments pull --owner HANDLE   GET  /v1/pull?owner=HANDLE
    lotuspod comments ack-answer ID         POST /v1/answers/ID/ack
    lotuspod comments record-answer PAGE QUESTION OPTION --source TEXT [--note TEXT]
                                            POST /v1/answers/record
    lotuspod comments show PAGE             GET  /v1/threads?page=PAGE
    lotuspod comments claim ID              POST /v1/comments/ID/claim
    lotuspod comments reply ID --claim TOKEN --key KEY (--text TEXT | --text-file PATH)
        [--revision R] [--model NAME] [--image PATH]...
                                            POST /v1/media for each image, then
                                            POST /v1/comments/ID/reply
    lotuspod comments follow-up ID --key KEY (--text TEXT | --text-file PATH)
        [--revision R] [--image PATH]...    POST /v1/media for each image, then
                                            POST /v1/threads/ID/follow-up
    lotuspod comments release ID --claim TOKEN
                                            POST /v1/comments/ID/release
    lotuspod comments fail ID --claim TOKEN --reason TEXT
                                            POST /v1/comments/ID/fail
    lotuspod comments resolve ID            POST /v1/threads/ID/resolve
    lotuspod comments reopen ID             POST /v1/threads/ID/reopen

Each takes --socket and --credential as every agent command does, prints the
socket's JSON with --json and readable markdown without it, and exits 1 on a
refusal, printing {"error": CODE} with --json. In the markdown, every text a
reader wrote sits in a fence longer than its longest run of backticks, so no
reader's text can end its fence and pass for the output around it. Each
image a comment carries is a line under its text: its URL, its size, and
the path of its file on this host, which an agent reads to see it. A thread
on a decision names it: `pull` gives its question, its options and its
current answer, and `show` heads the thread with its id.

A reply or follow-up attaches each --image file, in order: each is read and
uploaded first, its type named by its extension, and the message names them.
More than api.MAX_IMAGES images, a file that cannot be read, and an
extension of no accepted type are refused before anything is uploaded.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
import unicodedata
import urllib.parse
from pathlib import Path

# cli imports this module too: only names used at call time are read from it.
from lotuspod import api, cli, machine, media

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


def _ask(args: argparse.Namespace, method: str, target: str, body: object = None,
         content_type: str | None = None) -> dict:
    """The socket's JSON for one request; _Failed naming the refusal."""
    try:
        token = cli.agent_token(args)
    except cli.ConfigError as exc:
        raise _Failed("no_credential", str(exc)) from None
    socket_path = cli.agent_socket(args)
    try:
        status, payload = machine.request(socket_path, token, method, target, body,
                                          content_type)
    except OSError as exc:
        raise _Failed("socket_unavailable", f"cannot reach serve on {socket_path}: {exc}") from None
    except ValueError:
        raise _Failed("invalid_response", "serve's answer is not JSON") from None
    if status != 200:
        raise _Failed(str(payload.get("error") or status))
    return payload


def _refused(args: argparse.Namespace, exc: _Failed) -> int:
    if exc.message:
        print(f"error: {exc.message}", file=sys.stderr)
    if args.json:
        print(json.dumps({"error": exc.error}))
    elif not exc.message:
        print(f"error: {exc.error}", file=sys.stderr)
    return 1


def _run(args: argparse.Namespace, method: str, target: str, text, body: object = None) -> int:
    try:
        payload = _ask(args, method, target, body)
    except _Failed as exc:
        return _refused(args, exc)
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


def passage(quote: dict, lead: str) -> list[str]:
    """A quote's highlighted words under lead, then the same words with the
    text around them."""
    around = quote["prefix"] + quote["exact"] + quote["suffix"]
    return [lead, "", fence(quote["exact"]), "", "With the words around it:", "", fence(around), ""]


def moved(comment: dict, revision: str) -> str:
    """The revision a quote was highlighted on, beside the page's revision."""
    if comment["revision"] == revision:
        return f"revision {comment['revision'] or 'unknown'}; the page is still at that revision"
    return (f"revision {comment['revision'] or 'unknown'}; "
            f"the page is now at revision {revision or 'unknown'}")


def one_line(text: str) -> str:
    """text with each control character a space, then every run of
    whitespace, line breaks included, one space: a reader's words printed
    unfenced never start a line of their own nor drive the terminal."""
    shown = "".join(" " if unicodedata.category(char) == "Cc" else char for char in text)
    return " ".join(shown.split())


def answered(decision: dict) -> str:
    """A decision's current answer: its label and choice, who and when, and
    where it was given when an agent recorded it from elsewhere; "not
    answered yet" when it has none, and "dismissed, by NAME at TIME", with
    ": REASON" when it has one, when an owner dismissed it."""
    answer = decision["answer"]
    if answer is None:
        return "not answered yet"
    if answer.get("dismissed"):
        line = f"dismissed, by {_by(answer)} at {answer['createdAt']}"
        reason = one_line(answer["note"])
        return line + f": {reason}" if reason else line
    label = next((option["label"] for option in decision["options"]
                  if option["value"] == answer["choice"]), answer["choice"])
    line = f"{label} (`{answer['choice']}`), by {_by(answer)} at {answer['createdAt']}"
    if answer.get("source"):
        line += f", answered elsewhere: {answer['source']}"
    return line


def _context_lines(context: str) -> list[str]:
    return [f"- Context: {line}" for line in context.splitlines()]


def _decision(decision: dict) -> list[str]:
    """The lines naming a pulled item's decision, its options and its answer."""
    if not decision["asked"]:
        return [f"- Decision: `{decision['id']}`, which the page no longer asks",
                f"- Answer: {answered(decision)}"]
    options = ", ".join(f"{option['label']} (`{option['value']}`)"
                        for option in decision["options"])
    return [f"- Decision: `{decision['id']}`, {decision['text']}",
            *_context_lines(decision["context"]),
            f"- Options: {options}",
            f"- Answer: {answered(decision)}"]


def _resolved(resolution: dict | None) -> list[str]:
    """The line under a resolved thread's heading; none under another."""
    if not resolution or not resolution["resolved"]:
        return []
    return [f"Resolved by {_by(resolution)} at {resolution['at']}", ""]


def images(row: dict) -> list[str]:
    """A line for each image row carries, then a blank line; none without
    images."""
    lines = []
    for image in row.get("images") or ():
        where = (f"file {image['path']}" if image.get("path")
                 else "not in the media directory")
        lines.append(f"- Image {image['url']}, {image['width']}x{image['height']}, {where}")
    return [*lines, ""] if lines else []


def _message(row: dict, level: str) -> list[str]:
    """One comment of a thread: who, when, which model wrote it, where it
    stands, the answer whose note it holds, its text and its images."""
    kind = "Comment" if row.get("parent") is None else "Reply"
    head = f"{level} {kind} {row['id']}, {_by(row)}, {row['createdAt']}"
    if row.get("model"):
        head += f", model {row['model']}"
    if row.get("owner"):
        head += f" ({_standing(row)})"
    lines = [head, ""]
    if row.get("answer"):
        answer = row["answer"]
        choice = f" (`{answer['choice']}`)" if answer["choice"] else ""
        lines += [f"- With answer {answer['id']}: {answer['label']}{choice}", ""]
    if row.get("quote"):
        lead = f"The reader highlighted, on revision {row['revision'] or 'unknown'}:"
        lines += passage(row["quote"], lead)
    lines += [fence(row["text"]), "", *images(row)]
    return lines


def _note_line(comment: int, routed: dict, owner: str) -> str:
    """The line pointing an answer item to the comment holding its note:
    to claim it only when this pull has it routed to owner."""
    line = f"- Note: comment {comment}, in a thread on this decision"
    if comment not in routed:
        return line
    if routed[comment] == owner:
        return line + "; claim and reply to it there"
    return line + f"; routed to {routed[comment]}, which may claim it"


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
    # The handle each pulled comment is routed to, by its id.
    routed = {item["comment"]["id"]: item["comment"].get("owner")
              for item in items if item["kind"] == "comment"}
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
            ]
            decision = item.get("decision")
            if decision:
                lines += _decision(decision)
                # A note the thread holds is read there, not twice, also
                # once kept unchanged with another option.
                noted = {row["text"] for row in thread if row.get("answer")}
                # A dismissal's reason is on its Answer line.
                if (decision["answer"] and decision["answer"]["note"]
                        and not decision["answer"].get("dismissed")
                        and decision["answer"]["note"] not in noted):
                    lines += ["", "The answer's note:", "", fence(decision["answer"]["note"])]
            if comment.get("quote"):
                lines += [f"- Passage: highlighted on {moved(comment, page['revision'])}", "",
                          *passage(comment["quote"], "The reader highlighted:")]
            else:
                lines.append("")
            if comment.get("owner") == payload["owner"]:
                take = f"- Claim: `lotuspod comments claim {comment['id']}`"
            else:
                take = (f"- Passed to {comment.get('owner')} once the owner window ended; "
                        "only it may claim this")
            # A note's comment is read once, in the thread below, under the
            # answer it came with.
            if comment.get("answer") and comment["id"] in {row["id"] for row in thread}:
                said = [f"- Note: the reader's note on answer {comment['answer']['id']}, "
                        f"comment {comment['id']} in the thread below", ""]
            else:
                said = [fence(comment["text"]), "", *images(comment)]
            lines += [*said, take, ""]
            about = "the thread's first comment and its latest replies"
            if item["omitted"]:
                about += f"; {item['omitted']} earlier replies left out"
            lines += [f"### Thread ({about})", "", *_resolved(item.get("resolution"))]
            for row in thread:
                lines += _message(row, "####")
        else:
            answer, question = item["answer"], item["question"]
            asked = question["text"] or "(its words were not kept)"
            if question["reworded"]:
                asked += " (the page now asks it in other words, or not at all)"
            dismissed = bool(answer.get("dismissed"))
            if dismissed:
                # Its reason is said here, once.
                reason = one_line(answer["note"])
                reason = f": {reason}" if reason else ""
                chosen = [f"- Chosen: Dismissed{reason}"]
            elif "checked" in answer:
                chosen = [f"- Chosen: {question['label']}"]
                if question.get("changed") is not None:
                    chosen += [f"- Changed: {item['label']} (`{item['id']}`) "
                               f"{'on' if item['checked'] else 'off'}"
                               for item in question["changed"]] or ["- Changed: nothing"]
            else:
                chosen = [f"- Chosen: {question['label']} (`{answer['choice']}`)"]
                default = question.get("default")
                if default and default["value"] != answer["choice"]:
                    chosen.append(f"- Was: {default['label']} (`{default['value']}`), the default")
            lines += [
                f"## {number}. Answer {answer['id']} on `{page['name']}`, "
                f"question `{question['id']}`",
                "",
                *_page_lines(page),
                f"- Question: {asked}",
                *_context_lines(question["context"]),
                *chosen,
                f"- From: {_by(answer)} at {answer['createdAt']}, "
                f"against revision {answer['revision'] or 'unknown'}",
                *([f"- Answered elsewhere: {answer['source']}"] if answer.get("source") else []),
                *([f"- Undone at {answer['undoneAt']}"] if answer.get("undoneAt") else []),
                *([_note_line(item["noteComment"], routed, payload["owner"])]
                  if item.get("noteComment") else []),
                f"- Acknowledge: `lotuspod comments ack-answer {answer['id']}`",
                "",
                ("The reader dismissed this question as no longer relevant." if dismissed else
                 "The answer was given elsewhere and recorded by an agent, on this question "
                 "only." if answer.get("source") else
                 "The answer is the reader's choice on this question only."),
                "",
            ]
            if answer["note"] and not dismissed and not item.get("noteComment"):
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


def record_text(payload: dict) -> str:
    answer = payload["answer"]
    done = "recorded" if payload["created"] else "was already recorded"
    label = answer["asked"]["label"] or answer["choice"]
    return f"answer {answer['id']} {done} on {answer['page']}: {answer['question']} = {label}"


def show_text(payload: dict) -> str:
    """`comments show` without --json."""
    threads = payload["threads"]
    lines = [f"# Threads on `{payload['page']}`: {len(threads)}", ""]
    if not threads:
        lines.append("No comments yet.")
    for thread in threads:
        root = thread["root"]
        head = (f"## Decision `{root['question']}` in section {_section(root)}"
                if root.get("question") else f"## Section {_section(root)}")
        lines += [head, "", *_resolved(thread.get("resolution"))]
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


def resolution_text(payload: dict) -> str:
    resolution = payload["resolution"]
    if resolution["actor"] is None:
        return f"thread {payload['thread']} is not resolved"
    done = "resolved" if resolution["resolved"] else "reopened"
    return f"thread {payload['thread']} {done} by {_by(resolution)} at {resolution['at']}"


def cmd_pull(args: argparse.Namespace) -> int:
    target = "/v1/pull?" + urllib.parse.urlencode({"owner": args.owner})
    return _run(args, "GET", target, pull_text)


def cmd_ack_answer(args: argparse.Namespace) -> int:
    return _run(args, "POST", f"/v1/answers/{args.id}/ack", ack_text)


def cmd_record_answer(args: argparse.Namespace) -> int:
    body = {"page": args.page, "question": args.question, "choice": args.option,
            "source": args.source}
    if args.note is not None:
        body["note"] = args.note
    return _run(args, "POST", "/v1/answers/record", record_text, body)


def cmd_show(args: argparse.Namespace) -> int:
    target = "/v1/threads?" + urllib.parse.urlencode({"page": args.page})
    return _run(args, "GET", target, show_text)


def cmd_claim(args: argparse.Namespace) -> int:
    return _run(args, "POST", f"/v1/comments/{args.id}/claim", claim_text)


def _text(args: argparse.Namespace) -> str | None:
    """The message's text, from --text or --text-file; None, once the
    refusal is printed, when the file cannot be read."""
    if args.text_file is None:
        return args.text
    try:
        with open(args.text_file, encoding="utf-8") as fh:
            return fh.read()
    except (OSError, UnicodeDecodeError) as exc:
        print(f"error: cannot read {args.text_file}: {exc}", file=sys.stderr)
        if args.json:
            print(json.dumps({"error": "unreadable_text"}))
        return None


# The Content-Type an upload declares, by the extension its type is stored under.
_CONTENT_TYPES = {extension: media_type for media_type, extension in api.UPLOAD_TYPES.items()}


def _read_images(paths: list[str]) -> list[tuple[bytes, str]]:
    """Each --image file's bytes and Content-Type, in order; _Failed when
    there are too many, one cannot be read or its extension names no
    accepted type."""
    if len(paths) > api.MAX_IMAGES:
        raise _Failed("too_many_images",
                      f"{len(paths)} images; a message takes at most {api.MAX_IMAGES}")
    read = []
    for path in paths:
        kind = media.named_type(path)
        content_type = None if kind is None else _CONTENT_TYPES.get(media.EXTENSIONS[kind])
        if content_type is None:
            raise _Failed("unsupported_media_type",
                          f"{path} is not a .png, .jpg, .jpeg, .webp or .gif file")
        try:
            data = Path(path).read_bytes()
        except OSError as exc:
            raise _Failed("unreadable_image", f"cannot read {path}: {exc}") from None
        read.append((data, content_type))
    return read


def _send(args: argparse.Namespace, target: str, body: dict) -> int:
    """Upload each --image file, then send the message naming them."""
    try:
        images = _read_images(args.image)
        names = [_ask(args, "POST", machine.MEDIA, data, content_type)["name"]
                 for data, content_type in images]
    except _Failed as exc:
        return _refused(args, exc)
    if names:
        body["images"] = names
    return _run(args, "POST", target, reply_text, body)


def cmd_reply(args: argparse.Namespace) -> int:
    text = _text(args)
    if text is None:
        return 1
    body = {"claimToken": args.claim, "idempotencyKey": args.key, "text": text}
    if args.revision is not None:
        body["revision"] = args.revision
    if args.model is not None:
        body["model"] = args.model
    return _send(args, f"/v1/comments/{args.id}/reply", body)


def cmd_follow_up(args: argparse.Namespace) -> int:
    text = _text(args)
    if text is None:
        return 1
    body = {"idempotencyKey": args.key, "text": text}
    if args.revision is not None:
        body["revision"] = args.revision
    return _send(args, f"/v1/threads/{args.id}/follow-up", body)


def cmd_release(args: argparse.Namespace) -> int:
    return _run(args, "POST", f"/v1/comments/{args.id}/release", settled_text,
                {"claimToken": args.claim})


def cmd_fail(args: argparse.Namespace) -> int:
    return _run(args, "POST", f"/v1/comments/{args.id}/fail", settled_text,
                {"claimToken": args.claim, "reason": args.reason})


def cmd_resolve(args: argparse.Namespace) -> int:
    return _run(args, "POST", f"/v1/threads/{args.id}/resolve", resolution_text)


def cmd_reopen(args: argparse.Namespace) -> int:
    return _run(args, "POST", f"/v1/threads/{args.id}/reopen", resolution_text)


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
        help="read the comments routed to an agent and the answers on its pages, "
        "claim and answer comments, record answers given elsewhere, and resolve and "
        "reopen threads, over serve's socket",
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

    record = actions.add_parser(
        "record-answer",
        help="record a decision's answer the page's owner gave elsewhere, so the page shows "
        "it saved",
        description="Record OPTION as the answer to decision QUESTION on PAGE, given "
        "elsewhere (a chat, another seat's conversation, another page), which --source "
        "names. The page shows it saved, with \"Answered elsewhere: SOURCE\", and it counts "
        "as answered wherever answers count; a reader may still change it. It is recorded "
        "as the page's owner at the version the page asks now, and that owner's pulls "
        "leave it out. Recording the same OPTION from the same SOURCE again stores "
        "nothing and prints the answer recorded first. Needs a credential that may "
        "publish as the page's owner.",
    )
    record.add_argument("page", metavar="PAGE", help="the page's name")
    record.add_argument("question", metavar="QUESTION",
                        help="the decision's question id, as `lotuspod answers` and the pull "
                        "print it (decision-1)")
    record.add_argument("option", metavar="OPTION", help="the chosen option's value")
    record.add_argument("--source", required=True, metavar="TEXT",
                        help="where the answer was given, in 1 to 200 characters")
    record.add_argument("--note", default=None, metavar="TEXT", help="a note kept with it")
    record.add_argument("--json", action="store_true", help="print the socket's JSON")
    cli.add_agent_options(record)
    record.set_defaults(func=cmd_record_answer)

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
        "which must be the page's current revision, or one this credential republished it "
        "at for KEY. With --model, the reply names the model that wrote it, which the page "
        "shows beside the agent's handle. Each --image PATH (up to four) is uploaded "
        "first and shown in the reply's bubble, in order. The comment becomes answered "
        "and the claim ends. Needs a credential with reply.",
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
    reply.add_argument("--model", default=None, metavar="NAME",
                       help="the model that wrote the reply, in 1 to 40 printable characters")
    reply.add_argument("--image", action="append", default=[], metavar="PATH",
                       help="a PNG, JPEG, WebP or GIF file to attach; repeat for up to four")
    reply.add_argument("--json", action="store_true", help="print the socket's JSON")
    cli.add_agent_options(reply)
    reply.set_defaults(func=cmd_reply)

    follow = actions.add_parser(
        "follow-up",
        help="add a message to a thread the credential answered or whose page it owns, "
        "with no claim, once per idempotency key",
        description="Add a message to the thread whose first comment is ID, as the page's "
        "owner when the credential holds it, else as the handle the first comment is routed "
        "to (the one that answered it): a result promised in an earlier reply reaches the "
        "reader in the same thread. Needs no claim and changes no comment's state; a "
        "resolved thread stays resolved. KEY works as a reply's does: the same KEY again "
        "prints the message stored with it, and nothing is stored twice. --revision and "
        "--image work as a reply's do. Needs a credential with reply.",
    )
    follow.add_argument("id", type=_comment_id, metavar="ID",
                        help="the id of the thread's first comment")
    follow.add_argument("--key", required=True, metavar="KEY",
                        help="the idempotency key of this message, chosen before acting")
    text = follow.add_mutually_exclusive_group(required=True)
    text.add_argument("--text", metavar="TEXT", help="the message's text")
    text.add_argument("--text-file", metavar="PATH",
                      help="a UTF-8 file holding the message's text")
    follow.add_argument("--revision", default=None, metavar="R",
                        help="the page's revision after the agent revised it")
    follow.add_argument("--image", action="append", default=[], metavar="PATH",
                        help="a PNG, JPEG, WebP or GIF file to attach; repeat for up to four")
    follow.add_argument("--json", action="store_true", help="print the socket's JSON")
    cli.add_agent_options(follow)
    follow.set_defaults(func=cmd_follow_up)

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

    for action, func in (("resolve", cmd_resolve), ("reopen", cmd_reopen)):
        change = actions.add_parser(
            action,
            help=f"{action} a thread on a page the credential owns or whose first comment is "
            "routed to it",
            description=f"{action.capitalize()} the thread whose first comment is ID, as the "
            "page's owner when the credential holds it, else as the handle the first comment "
            "is routed to; the change is kept with who made it and when, and written to the "
            "audit trail. Changes no comment's routing. Needs a credential with reply.",
        )
        change.add_argument("id", type=_comment_id, metavar="ID",
                            help="the id of the thread's first comment")
        change.add_argument("--json", action="store_true", help="print the socket's JSON")
        cli.add_agent_options(change)
        change.set_defaults(func=func)
