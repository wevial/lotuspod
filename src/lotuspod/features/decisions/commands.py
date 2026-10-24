"""The decisions slice's commands: `lotuspod answers`, the answers given to a
page's decisions (lotuspod.features.decisions.decisions)."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from lotuspod.features.agents import agents
from lotuspod.core import DEFAULT_OUTPUT_DIR
from lotuspod.features.decisions import decisions
from lotuspod.features.publish.publish import _PAGE_NAME
from lotuspod.features.serve import api
from lotuspod.features.serve.serve_files import serve_database
from lotuspod.store import db


def answers_text(name: str, questions: dict, forms: dict[str, decisions.Form]) -> str:
    """`lotuspod answers` without --json: each answered question, its
    current answer and, under it, the earlier ones, newest first. A
    checklist's answer is its change summary, read against the page's form
    while it asks at the answer's version, else the summary kept with it. A
    decision answered at its form's version with another option than the
    form's default says so: "LABEL, was: DEFAULT-LABEL". An answer an agent
    recorded from elsewhere names the handle that recorded it and where it
    was given. A dismissal is "Dismissed", its note its reason, and says
    when it was undone, if it was."""
    if not questions:
        return f"no answers to {name}"

    def entry(row: dict, form: decisions.Form | None, indent: str) -> list[str]:
        if row.get("dismissed"):
            label = "Dismissed"
        elif "checked" in row:
            if form is not None and row["version"] == form.version:
                label = api.summary(api.changes(dict(form.options), form.defaults,
                                                row["checked"]))
            else:
                label = row["asked"]["label"]
        else:
            label = form.label(row["choice"]) if form else row["choice"]
            if (form is not None and row["version"] == form.version and form.default
                    and row["choice"] != form.default):
                label += f", was: {form.label(form.default)}"
        head = f"{indent}{label} (answer {row['id']}"
        if row["supersedes"] is not None:
            head += f", replaces answer {row['supersedes']}"
        head += ")"
        if form is None or row["version"] != form.version:
            head += ", to an earlier wording"
        if "undoneAt" in row:
            head += f", undone at {row['undoneAt']}"
        if "source" in row:
            by = (f"recorded by {row['actor'].get('handle', '')} at {row['createdAt']}, "
                  f"answered elsewhere: {row['source']}")
        else:
            by = f"by {row['actor'].get('email', '')} at {row['createdAt']}"
        lines = [head, f"{indent}  {by}"]
        if row["note"]:
            if row.get("dismissed"):
                lines.append(f"{indent}  reason: {agents.one_line(row['note'])}")
            else:
                lines.append(f"{indent}  note: {row['note']}")
        return lines

    lines = []
    for question, answered in questions.items():
        form = forms.get(question)
        lines.append(f"{question}: {form.text}" if form else question)
        lines += entry(answered["current"], form, "  ")
        if answered["earlier"]:
            lines.append("  earlier:")
            for row in answered["earlier"]:
                lines += entry(row, form, "    ")
    return "\n".join(lines)


def cmd_answers(args: argparse.Namespace) -> int:
    name = args.page
    if not _PAGE_NAME.fullmatch(name):
        print(f"error: not a page name: {name!r}", file=sys.stderr)
        return 1
    try:
        questions = serve_database(args).answers(name, asked=True)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    if args.json:
        print(json.dumps({"page": name, "questions": questions}, indent=2))
        return 0
    out_dir = Path(args.out_dir) if args.out_dir else DEFAULT_OUTPUT_DIR
    page = out_dir / f"{name}.html"
    forms = decisions.read_forms(page.read_text(encoding="utf-8")) if page.is_file() else {}
    print(agents.printable(answers_text(name, questions, forms)))
    return 0


def add_parser(sub: argparse._SubParsersAction) -> None:
    """Register `lotuspod answers`."""
    answers = sub.add_parser(
        "answers", help="show the answers given to a page's decisions, with their history"
    )
    answers.add_argument("page", metavar="PAGE", help="the page's name")
    answers.add_argument("--json", action="store_true", help="print JSON, as GET /api/answers")
    answers.add_argument(
        "--out-dir", default="", help="artifacts directory (default: artifacts/)"
    )
    answers.add_argument(
        "--db", default="", metavar="PATH",
        help=f"serve's database (default: {db.DEFAULT_NAME} beside the artifacts directory)",
    )
    answers.set_defaults(func=cmd_answers)


# This slice's subcommands by slot, the order `lotuspod --help` lists them in.
COMMANDS = (
    (60, add_parser),
)
