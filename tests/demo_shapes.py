"""The shapes of the /api answers the demo's shim imitates, as the real
`lotuspod serve` gives them.

Run inside the capture fixture, as a reader on the demo's own try-it page:

    python -m tests.capture_site python -m tests.demo_shapes [--write]

It publishes demo/pages/try-it.md into the capture site as `try-it`, owned
by hermes, with the real `lotuspod publish --local`, so the page's section
and question ids are the demo's. Then it runs SCRIPT against the served
site, sending the fixture's assertion, and records each answer's status and
shape. The agent's reply to the first comment goes through the real
`lotuspod comments` commands with the fixture's hermes credential; it is not
an /api request, so nothing is recorded for it.

It prints the document of shapes to stdout, sorted and stable; with
--write it writes it to FIXTURE instead. The fixture's
`expected_differences` are written by hand and carried over as they are:
each names a request and a key where the demo answers differently by design,
and only the demo's check (e2e/demo/shapes.spec.ts) reads them.

A shape keeps no values (ids, times, texts):

- an object maps each key to the shape of its value;
- a list holds the merged shape of its elements, [] when it is empty;
- a scalar is its JSON type name: string, number, boolean or null;
- a value seen as more than one type records each: scalar types as one
  name, joined by "|" ("null|number"), and otherwise {"oneOf": [...]}.

Merging two objects keeps every key of either. e2e/demo/shape.js is the same
rule in JS, for the shim's answers.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.error
import urllib.request
from pathlib import Path
from typing import Callable

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC = REPO_ROOT / "src"
sys.path.insert(0, str(SRC))

from lotuspod import comments, decisions  # noqa: E402
from tests import capture_site  # noqa: E402

FIXTURE = REPO_ROOT / "tests" / "fixtures" / "demo" / "api-shapes.json"
SOURCE = REPO_ROOT / "demo" / "pages" / "try-it.md"
PAGE = "try-it"
OWNER = capture_site.OWNER
ASSERTION_HEADER = "Cf-Access-Jwt-Assertion"
ONE_OF = "oneOf"
# The longest object or list the fixture keeps on one line.
INLINE = 88

# What the script writes. The sections and the quote are try-it's own.
SECTION = "what-goes-in"
PASSAGE_SECTION = "the-pond-today"
QUOTE = {"exact": "the first algae", "prefix": "from edge to edge and ",
         "suffix": " are showing"}
UNKNOWN_SECTION = "no-such-section"
UNKNOWN_QUESTION = "no-such-question"
STALE_VERSION = "stale"
MODEL = "scripted"

_REVISION_META = re.compile(r'<meta name="lotuspod:revision" content="([^"]*)"')


class RecordError(Exception):
    pass


# The shape rule.

def shape(value: object) -> object:
    """The shape of a JSON value."""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, list):
        merged: list = []
        for item in value:
            merged = [merge(merged[0], shape(item))] if merged else [shape(item)]
        return merged
    if isinstance(value, dict):
        return {key: shape(item) for key, item in value.items()}
    raise TypeError(f"not a JSON value: {value!r}")


def _alternatives(found: object) -> list:
    if isinstance(found, str):
        return found.split("|")
    if isinstance(found, dict) and list(found) == [ONE_OF]:
        return list(found[ONE_OF])
    return [found]


def _kind(found: object) -> str:
    if isinstance(found, dict):
        return "object"
    if isinstance(found, list):
        return "list"
    return str(found)


def _merge_kind(a: object, b: object) -> object:
    """Two shapes of one kind merged."""
    if isinstance(a, dict) and isinstance(b, dict):
        return {key: merge(a[key], b[key]) if key in a and key in b else a.get(key, b.get(key))
                for key in sorted(a.keys() | b.keys())}
    if isinstance(a, list) and isinstance(b, list):
        return [merge(a[0], b[0])] if a and b else a or b
    return a


def merge(a: object, b: object) -> object:
    """The shape of a value seen as a once and as b another time."""
    if a == b:
        return a
    kinds: dict[str, object] = {}
    for found in _alternatives(a) + _alternatives(b):
        kind = _kind(found)
        kinds[kind] = _merge_kind(kinds[kind], found) if kind in kinds else found
    merged = [kinds[kind] for kind in sorted(kinds)]
    if len(merged) == 1:
        return merged[0]
    if all(isinstance(found, str) for found in merged):
        return "|".join(merged)
    return {ONE_OF: merged}


def differences(expected: object, actual: object, key: str = "") -> list[tuple[str, str]]:
    """(key, what differs) for each place shape actual differs from expected."""
    union = isinstance(expected, dict) and list(expected) == [ONE_OF] or \
        isinstance(actual, dict) and list(actual) == [ONE_OF]
    if isinstance(expected, dict) and isinstance(actual, dict) and not union:
        found = []
        for name in sorted(expected.keys() | actual.keys()):
            at = f"{key}.{name}" if key else name
            if name not in actual:
                found.append((at, "the fixture has it, the answer does not"))
            elif name not in expected:
                found.append((at, "the answer has it, the fixture does not"))
            else:
                found.extend(differences(expected[name], actual[name], at))
        return found
    if isinstance(expected, list) and isinstance(actual, list) and expected and actual:
        return differences(expected[0], actual[0], f"{key}[]")
    if expected != actual:
        return [(key or "(body)", f"the fixture has {json.dumps(expected, sort_keys=True)}, "
                                  f"the answer {json.dumps(actual, sort_keys=True)}")]
    return []


def compare(fixture: dict, recorded: dict) -> list[str]:
    """Each way the recorded requests differ from the fixture's, naming the
    request and the key."""
    found = []
    expected, actual = fixture["requests"], recorded["requests"]
    if [entry["request"] for entry in expected] != [entry["request"] for entry in actual]:
        found.append(f"the requests differ: the fixture has "
                     f"{[entry['request'] for entry in expected]}, the recording "
                     f"{[entry['request'] for entry in actual]}")
    for want, got in zip(expected, actual):
        for field in ("method", "path", "status"):
            if want[field] != got[field]:
                found.append(f"{want['request']}: {field}: the fixture has {want[field]!r}, "
                             f"the answer {got[field]!r}")
        for key, what in differences(want["shape"], got["shape"]):
            found.append(f"{want['request']}: key {key}: {what}")
    return found


# The script: a reader on try-it, in order. Each step's label names it in
# the fixture.

Api = Callable[[str, str, "dict | None"], tuple[int, object]]


def run(api: Api, agent_reply: Callable[[int], None], page_html: str) -> list[dict]:
    """The script's requests through api(method, path, body) -> (status, JSON),
    with agent_reply(comment id) as step 5; each request's entry."""
    found = _REVISION_META.search(page_html)
    if found is None:
        raise RecordError(f"{PAGE} names no revision")
    revision = found.group(1)
    if {SECTION, PASSAGE_SECTION} - set(comments.read_boxes(page_html)):
        raise RecordError(f"{PAGE} has no comment box on {SECTION} or {PASSAGE_SECTION}")
    forms = list(decisions.read_forms(page_html).values())
    if not forms or len(forms[0].options) < 2:
        raise RecordError(f"{PAGE} asks no question with two options")
    form = forms[0]
    first, second = form.options[0][0], form.options[1][0]
    comments_path, answers_path = "/api/comments", "/api/answers"
    query = f"?page={PAGE}"
    entries: list[dict] = []

    def ask(label: str, method: str, path: str, body: dict | None = None) -> object:
        status, payload = api(method, path, body)
        entries.append({"request": label, "method": method, "path": path.split("?")[0],
                        "status": status, "shape": shape(payload)})
        return payload

    def answer(choice: str, version: str) -> dict:
        return {"page": PAGE, "question": form.question, "version": version,
                "choice": choice, "note": ""}

    ask("1. GET comments, none yet", "GET", comments_path + query)
    made = ask("2. POST a section comment", "POST", comments_path,
               {"page": PAGE, "section": SECTION, "text": "Which lilies go in first?"})
    ask("3. POST a passage comment, with a quote", "POST", comments_path,
        {"page": PAGE, "section": PASSAGE_SECTION, "text": "Is this algae a worry?",
         "quote": QUOTE, "revision": revision})
    ask("4. GET comments", "GET", comments_path + query)
    if not isinstance(made, dict) or not isinstance(made.get("id"), int):
        raise RecordError(f"the section comment was not stored: {made!r}")
    agent_reply(made["id"])
    ask("6. GET comments, after the agent's reply", "GET", comments_path + query)
    ask("7. POST a reader reply", "POST", comments_path,
        {"page": PAGE, "parent": made["id"], "text": "Thanks, that helps."})
    ask("8a. POST a resolution, resolved", "POST", comments_path,
        {"page": PAGE, "thread": made["id"], "resolved": True})
    ask("8b. POST a resolution, reopened", "POST", comments_path,
        {"page": PAGE, "thread": made["id"], "resolved": False})
    # Before the answers: the shim adds a thread of its own on an answer.
    ask("8c. POST a question about a decision", "POST", comments_path,
        {"page": PAGE, "question": form.question, "text": "Is it warm enough by then?"})
    ask("8d. POST a question about a decision the page does not ask", "POST", comments_path,
        {"page": PAGE, "question": UNKNOWN_QUESTION, "text": "What about this one?"})
    ask("8e. GET comments, with a decision thread", "GET", comments_path + query)
    ask("9. GET answers, none yet", "GET", answers_path + query)
    ask("10. POST an answer", "POST", answers_path, answer(first, form.version))
    ask("11. POST a second answer to the same question", "POST", answers_path,
        answer(second, form.version))
    ask("12. POST an answer with a stale version", "POST", answers_path,
        answer(first, STALE_VERSION))
    ask("13. GET answers", "GET", answers_path + query)
    ask("14. GET revision", "GET", "/api/revision" + query)
    ask("15. POST a comment on an unknown section", "POST", comments_path,
        {"page": PAGE, "section": UNKNOWN_SECTION, "text": "Where does this go?"})
    return entries


def document(entries: list[dict]) -> dict:
    """The fixture's document: entries, and the fixture's own
    expected_differences, kept as they are."""
    kept = []
    if FIXTURE.is_file():
        kept = json.loads(FIXTURE.read_text(encoding="utf-8")).get("expected_differences", [])
    return {"expected_differences": kept, "requests": entries}


def dumps(found: dict) -> str:
    """found as the fixture keeps it: keys sorted, two spaces of indent, and
    an object or list that is short on one line kept on one."""
    return _dumps(found, "") + "\n"


def _dumps(value: object, indent: str) -> str:
    flat = json.dumps(value, sort_keys=True, ensure_ascii=False)
    if len(flat) <= INLINE or not isinstance(value, (dict, list)) or not value:
        return flat
    inner = indent + "  "
    if isinstance(value, list):
        items = [inner + _dumps(item, inner) for item in value]
        return "[\n" + ",\n".join(items) + "\n" + indent + "]"
    items = [f"{inner}{json.dumps(key, ensure_ascii=False)}: {_dumps(value[key], inner)}"
             for key in sorted(value)]
    return "{\n" + ",\n".join(items) + "\n" + indent + "}"


# The real side: the capture fixture's site, its socket and hermes.

class Site:
    """The capture fixture's site, as its environment names it."""

    def __init__(self, env: dict) -> None:
        names = (capture_site.URL_ENV, capture_site.ASSERTION_ENV, capture_site.SOCKET_ENV,
                 capture_site.HERMES_ENV, capture_site.OUT_ENV)
        missing = [name for name in names if not env.get(name)]
        if missing:
            raise RecordError(f"run inside tests.capture_site: {', '.join(missing)} unset")
        self.url = env[capture_site.URL_ENV]
        self.assertion = env[capture_site.ASSERTION_ENV]
        self.socket = env[capture_site.SOCKET_ENV]
        self.credential = env[capture_site.HERMES_ENV]
        self.out = Path(env[capture_site.OUT_ENV])
        self.python = env.get(capture_site.PYTHON_ENV) or sys.executable
        self.env = {**env, "PYTHONPATH": str(SRC)}

    def lotuspod(self, *args: str) -> str:
        """One real `lotuspod` command's stdout; RecordError when it fails."""
        done = subprocess.run([self.python, "-m", "lotuspod", *args], env=self.env,
                              capture_output=True, text=True, timeout=60, check=False)
        if done.returncode != 0:
            raise RecordError(f"lotuspod {args[0]} {args[1]} failed: {done.stderr.strip()}")
        return done.stdout

    def agent(self, *args: str) -> dict:
        """`lotuspod comments ... --json` as hermes."""
        return json.loads(self.lotuspod("comments", *args, "--json", "--socket", self.socket,
                                        "--credential", self.credential))

    def publish(self) -> None:
        """Publish try-it from a copy of its source, owned by hermes."""
        work = Path(tempfile.mkdtemp(prefix="lotuspod-shapes-"))
        try:
            copy = work / SOURCE.name
            shutil.copyfile(SOURCE, copy)
            self.lotuspod("publish", str(copy), "--local", "--out-dir", str(self.out),
                          "--name", PAGE, "--owner", OWNER, "--credential", self.credential)
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def request(self, method: str, path: str, body: dict | None = None) -> tuple[int, object]:
        headers = {ASSERTION_HEADER: self.assertion}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        request = urllib.request.Request(self.url + path, data=data, method=method,
                                         headers=headers)
        try:
            response = urllib.request.urlopen(request, timeout=30)
        except urllib.error.HTTPError as exc:
            response = exc
        with response:
            return response.status, json.loads(response.read().decode("utf-8"))

    def page_html(self) -> str:
        request = urllib.request.Request(f"{self.url}/{PAGE}.html",
                                         headers={ASSERTION_HEADER: self.assertion})
        with urllib.request.urlopen(request, timeout=30) as response:
            return response.read().decode("utf-8")

    def reply(self, comment: int) -> None:
        """hermes claims comment and replies, naming its model."""
        claim = self.agent("claim", str(comment))
        # A claim token may start with '-': give it to its option in one word.
        self.agent("reply", str(comment), f"--claim={claim['claimToken']}",
                   "--key", f"shapes-{comment}", "--text", "Lilies first, then the marginals.",
                   "--model", MODEL)


def record(env: dict) -> dict:
    """The document of shapes the capture site's serve answers."""
    site = Site(env)
    site.publish()
    # hermes listens, so the reader's comments are routed to it.
    site.agent("pull", "--owner", OWNER)
    return document(run(site.request, site.reply, site.page_html()))


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        prog="python -m tests.demo_shapes",
        description="Record the shapes of serve's /api answers to the demo's request script.",
    )
    parser.add_argument("--write", action="store_true", help=f"write them to {FIXTURE}")
    args = parser.parse_args(argv)
    try:
        found = dumps(record(dict(os.environ)))
    except (RecordError, OSError, ValueError) as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    if args.write:
        FIXTURE.parent.mkdir(parents=True, exist_ok=True)
        FIXTURE.write_text(found, encoding="utf-8")
    else:
        sys.stdout.write(found)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
