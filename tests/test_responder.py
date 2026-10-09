"""The default responder, `lotuspod respond`: what its agent command is
given, how a command that fails leaves a comment, HTML sources and pages
with no kept source, which command runs, the loop and its stop, a
credential without publish, and the systemd unit that runs it.

serve runs as a subprocess with the test Access key trusted, as in
tests.test_responder_witness; the agent commands are stand-in scripts.

Run from the repo root:

    python -m unittest tests.test_responder -v
"""

from __future__ import annotations

import configparser
import hashlib
import json
import os
import re
import shlex
import signal
import sqlite3
import subprocess
import sys
import time
import unittest
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from lotuspod import cli, decisions, media, responder  # noqa: E402
from tests.test_responder_witness import (  # noqa: E402
    ASSERTION, REPO, READER, Site, assertion, git)

MEDIA_FIXTURES = Path(__file__).resolve().parent / "fixtures" / "media"

ORPHAN = """\
# Orphan page

## Greeting

A distinctive source line: lilies at dusk.

## Other

Nothing here.
"""

HTML_PAGE = """\
<h1>Pond notes</h1>
<h2>Greeting</h2>
<p>Written as HTML.</p>
<h2>Other</h2>
<p>Nothing here.</p>
"""

DECIDED = """\
# Pond plan

## Heater

A heater keeps a hole open.

## Decisions for the maintainer

| # | Question | Options |
| --- | --- | --- |
| 1 | Buy a heater? | Gas / Electric / Neither |
"""

OPS = ["pull", "claim", "reply", "publish"]

# A stand-in agent: it records its standard input, its environment's page
# variables, its working directory, the SHA-256 of each file in its images
# directory (None without one) and its arguments to $RECORD, appends
# $APPEND to the source copy when set, and prints $ANSWER.
RECORDER = """\
import hashlib, json, os, pathlib, sys
prompt = sys.stdin.read()
source = os.environ.get("LOTUSPOD_PAGE_SOURCE", "")
record = {"prompt": prompt, "argv": sys.argv[1:], "source": source,
          "page": os.environ.get("LOTUSPOD_PAGE"), "cwd": os.getcwd(),
          "files": sorted(os.listdir(".")),
          "credential": os.environ.get("LOTUSPOD_CREDENTIAL"),
          "images": {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
                     for path in pathlib.Path("images").iterdir()}
          if os.path.isdir("images") else None}
with open(os.environ["RECORD"], "a", encoding="utf-8") as log:
    log.write(json.dumps(record) + "\\n")
if os.environ.get("APPEND") and source:
    path = pathlib.Path(source)
    path.write_text(path.read_text(encoding="utf-8") + os.environ["APPEND"], encoding="utf-8")
print(os.environ.get("ANSWER", "An answer."))
"""


class ResponderCase(Site):
    """A page `orphan` with no owner, published from markdown, served with a
    database and a socket; credential `responder` for the responder. serve's
    claims last claim_sec seconds when it is set."""

    claim_sec: int | None = None

    def setUp(self):
        super().setUp()
        if self.claim_sec is not None:
            config = Path(self.env["LOTUSPOD_CONFIG"])
            config.write_text(config.read_text(encoding="utf-8")
                              + f"[comments]\nclaim_sec = {self.claim_sec}\n", encoding="utf-8")
        self.record = self.tmp / "record.jsonl"
        recorder = self.tmp / "recorder.py"
        recorder.write_text(RECORDER, encoding="utf-8")
        self.recorder = shlex.join([sys.executable, str(recorder)])
        self.env.update(RECORD=str(self.record))
        self.responder = self.credential("responder", ["responder"], OPS)
        self.publish("orphan", ORPHAN)
        self.server = self.start_server()

    def publish(self, name, text, suffix=".md"):
        source = self.tmp / f"{name}{suffix}"
        source.write_text(text, encoding="utf-8")
        done = self.cli("publish", str(source), "--name", name, "--db", str(self.db),
                        "--out-dir", str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)

    def respond(self, *extra, command=None, credential=None, env=None):
        argv = ["respond", "--once", "--credential", str(credential or self.responder),
                "--socket", str(self.sock), "--out-dir", str(self.out), "--db", str(self.db)]
        if command is not False:
            argv += ["--command", command or self.recorder]
        return self.cli(*argv, *extra, env=env)

    def stand_in(self, name, body) -> str:
        script = self.tmp / f"{name}.py"
        script.write_text(body, encoding="utf-8")
        return shlex.join([sys.executable, str(script)])

    def records(self):
        if not self.record.exists():
            return []
        return [json.loads(line) for line in self.record.read_text().splitlines() if line]

    def root(self, page, root_id):
        return self.thread(page, root_id)["root"]

    def replies(self, page, root_id):
        return [(r.get("text"), (r.get("actor") or {}).get("handle"), r.get("revision"))
                for r in self.thread(page, root_id)["replies"]]


class PromptTests(ResponderCase):
    def test_the_agent_reads_the_limits_the_thread_the_revision_and_the_source(self):
        first = self.comment("orphan", "greeting", "What are lilies doing here?")
        # Another agent answered it once; the reader follows up.
        helper = self.credential("helper", ["responder"], OPS)
        code, claimed = self.agent(helper, "claim", str(first["id"]))
        self.assertEqual(code, 0, claimed)
        code, replied = self.agent(helper, "reply", str(first["id"]), "--claim",
                                   claimed["claimToken"], "--key", "helper-1",
                                   "--text", "They bloom at dusk.")
        self.assertEqual(code, 0, replied)
        status, _, follow = self.api("POST", "/api/comments", {
            "page": "orphan", "parent": first["id"], "text": "Which ones, exactly?"})
        self.assertEqual(status, 201, follow)

        done = self.respond()
        self.assertEqual(done.returncode, 0, done.stderr)
        [record] = self.records()
        prompt = record["prompt"]
        self.assertIn(responder.LIMITS, prompt)
        self.assertIn('"Greeting"', prompt)
        for text, author in (("What are lilies doing here?", READER),
                             ("They bloom at dusk.", "responder"),
                             ("Which ones, exactly?", READER)):
            self.assertIn(text, prompt)
            self.assertIn(author, prompt)
        # The follow-up to answer comes first in full, then the thread in order.
        self.assertIn(f"comment to answer: comment {follow['id']}", prompt)
        self.assertLess(prompt.index("Which ones"), prompt.index("The thread it belongs to"))
        thread = prompt[prompt.index("The thread it belongs to"):]
        self.assertLess(thread.index("What are lilies"), thread.index("They bloom"))
        self.assertLess(thread.index("They bloom"), thread.index("Which ones"))
        page = (self.out / "orphan.html").read_text(encoding="utf-8")
        revision = page.split('name="lotuspod:revision" content="', 1)[1].split('"', 1)[0]
        self.assertIn(f"Revision: {revision}", prompt)
        self.assertIn(ORPHAN, prompt)

        self.assertEqual(record["files"], ["orphan.md"])
        self.assertEqual(Path(record["source"]).name, "orphan.md")
        self.assertEqual(str(Path(record["source"]).parent), record["cwd"])
        self.assertEqual(record["page"], "orphan")
        self.assertIsNone(record["credential"])
        self.assertFalse(Path(record["cwd"]).exists())
        self.assertEqual(self.replies("orphan", first["id"])[-1],
                         ("An answer.", "responder", ""))


    def test_the_agent_reads_the_passage_and_the_revision_it_was_highlighted_on(self):
        read = self.page_revision()
        quote = {"exact": "lilies ````at```` dusk", "prefix": "source line: ",
                 "suffix": ". ```Other```"}
        status, _, row = self.api("POST", "/api/comments", {
            "page": "orphan", "section": "greeting", "text": "Why dusk?", "quote": quote,
            "revision": read})
        self.assertEqual(status, 201, row)
        self.publish("orphan", ORPHAN.replace("Nothing here.", "Something here."))
        now = self.page_revision()
        self.assertNotEqual(now, read)

        done = self.respond()
        self.assertEqual(done.returncode, 0, done.stderr)
        [record] = self.records()
        prompt = record["prompt"]
        start = prompt.index(f"## The comment to answer: comment {row['id']}")
        end = prompt.index("### The thread it belongs to")
        answer, thread = prompt[start:end], prompt[end:]
        self.assertIn('On the section headed "Greeting" (`greeting`).', answer)
        self.assertIn(f"The reader highlighted a passage of this section on revision {read}; "
                      f"the page is now at revision {now}. Answer about that passage.", answer)
        around = quote["prefix"] + quote["exact"] + quote["suffix"]
        for part, lead in ((answer, "The passage:"),
                           (thread, f"The reader highlighted, on revision {read}:")):
            with self.subTest(lead=lead):
                found = re.search(re.escape(lead) + r"\n\n(`{3,})\n(.*?)\n\1\n\n"
                                  r"With the words around it:\n\n(`{3,})\n(.*?)\n\3\n",
                                  part, re.DOTALL)
                self.assertIsNotNone(found, part)
                exact_marks, exact, around_marks, got = found.groups()
                self.assertEqual((exact, got), (quote["exact"], around))
                self.assertGreater(len(exact_marks), 4)
                self.assertGreater(len(around_marks), 4)
        self.assertLess(answer.index("Answer about that passage."), answer.index("Why dusk?"))
        self.assertNotIn("Quoting the page", prompt)

    def page_revision(self) -> str:
        page = (self.out / "orphan.html").read_text(encoding="utf-8")
        return page.split('name="lotuspod:revision" content="', 1)[1].split('"', 1)[0]


class DecisionPromptTests(ResponderCase):
    """A thread on a decision: the prompt names the decision, its options
    and its current answer."""

    def ask(self, text: str) -> dict:
        status, _, row = self.api("POST", "/api/comments",
                                  {"page": "pond", "question": "decision-1", "text": text})
        self.assertEqual(status, 201, row)
        self.assertEqual((row["question"], row["owner"]), ("decision-1", "responder"))
        return row

    def answer_section(self, prompt: str, row: dict) -> str:
        start = prompt.index(f"## The comment to answer: comment {row['id']}")
        return prompt[start:prompt.index("### The thread it belongs to")]

    def test_the_prompt_names_the_decision_and_its_answer_or_none(self):
        self.publish("pond", DECIDED)
        first = self.ask("Which heater is quieter?")
        done = self.respond()
        self.assertEqual(done.returncode, 0, done.stderr)
        [record] = self.records()
        section = self.answer_section(record["prompt"], first)
        self.assertIn("The reader asks about the decision `decision-1`: \"Buy a heater?\"",
                      section)
        self.assertIn("Its options: Gas (`gas`), Electric (`electric`), Neither (`neither`).",
                      section)
        self.assertIn("Its current answer: not answered yet.", section)
        self.assertLess(section.index('On the section headed "Decisions for the maintainer"'),
                        section.index("The reader asks about the decision"))
        self.assertLess(section.index("Its current answer"),
                        section.index("Which heater is quieter?"))

        page = (self.out / "pond.html").read_text(encoding="utf-8")
        version = decisions.read_forms(page)["decision-1"].version
        status, _, answer = self.api("POST", "/api/answers", {
            "page": "pond", "question": "decision-1", "version": version,
            "choice": "electric", "note": "The quiet one."})
        self.assertEqual(status, 201, answer)
        second = self.ask("And how much power?")
        done = self.respond()
        self.assertEqual(done.returncode, 0, done.stderr)
        section = self.answer_section(self.records()[-1]["prompt"], second)
        self.assertIn(f"Its current answer: Electric (`electric`), by {READER} at "
                      f"{answer['createdAt']}.", section)
        self.assertIn("The quiet one.", section)
        self.assertNotIn("not answered yet", section)
        self.assertEqual(self.replies("pond", second["id"]),
                         [("An answer.", "responder", "")])

    def test_a_section_thread_names_no_decision(self):
        self.publish("pond", DECIDED)
        status, _, row = self.api("POST", "/api/comments",
                                  {"page": "pond", "section": "heater", "text": "How big?"})
        self.assertEqual(status, 201, row)
        done = self.respond()
        self.assertEqual(done.returncode, 0, done.stderr)
        [record] = self.records()
        self.assertNotIn("asks about the decision", record["prompt"])
        self.assertNotIn("Its current answer", record["prompt"])


class ImageTests(ResponderCase):
    """The images of the comment and its thread, copied beside the source."""

    def upload(self, fixture: str, media_type: str) -> dict:
        request = urllib.request.Request(
            f"http://127.0.0.1:{self.port}/api/media",
            data=(MEDIA_FIXTURES / fixture).read_bytes(),
            headers={ASSERTION: assertion(), "Content-Type": media_type}, method="POST")
        with urllib.request.urlopen(request, timeout=30) as response:
            self.assertEqual(response.status, 201)
            return json.loads(response.read().decode("utf-8"))

    def post(self, body: dict) -> dict:
        status, _, row = self.api("POST", "/api/comments", {"page": "orphan", **body})
        self.assertEqual(status, 201, row)
        return row

    def media_dir(self) -> Path:
        return media.media_dir(self.out)

    def message(self, prompt: str, level: str, kind: str, row: dict) -> str:
        """The part of prompt under one message's heading."""
        start = prompt.index(f"{level} {kind} {row['id']} by ")
        end = prompt.find("\n#", start)
        return prompt[start:] if end < 0 else prompt[start:end]

    def test_the_agent_finds_each_image_beside_the_source_under_its_message(self):
        chart = self.upload("chart-1600x600.png", "image/png")
        fish = self.upload("fish-320x240.jpg", "image/jpeg")
        root = self.post({"section": "greeting", "text": "Look at the pond."})
        earlier = self.post({"parent": root["id"], "text": "Here it is.",
                             "images": [chart["name"]]})
        target = self.post({"parent": root["id"], "text": "And this fish?",
                            "images": [fish["name"]]})
        revision = self.page_revision()

        done = self.respond()
        self.assertEqual(done.returncode, 0, done.stderr)
        [record] = [r for r in self.records()
                    if f"comment to answer: comment {target['id']}\n" in r["prompt"]]
        stored = {image["name"]: hashlib.sha256(
            (self.media_dir() / image["name"]).read_bytes()).hexdigest()
            for image in (chart, fish)}
        self.assertEqual(record["images"], stored)
        self.assertEqual(record["files"], ["images", "orphan.md"])
        prompt = record["prompt"]
        chart_line = f"- Image images/{chart['name']}, 1600x600\n"
        fish_line = f"- Image images/{fish['name']}, 320x240\n"
        answer = prompt[prompt.index("## The comment to answer"):
                        prompt.index("### The thread it belongs to")]
        self.assertIn(fish_line, answer)
        self.assertNotIn(chart_line, answer)
        for row, line, other in ((earlier, chart_line, fish_line),
                                 (target, fish_line, chart_line)):
            with self.subTest(message=row["text"]):
                shown = self.message(prompt, "####", "Reply", row)
                self.assertIn(row["text"], shown)
                self.assertIn(line, shown)
                self.assertNotIn(other, shown)
        self.assertNotIn("- Image ", self.message(prompt, "####", "Comment", root))
        self.assertNotIn("missing", prompt)
        self.assertFalse(Path(record["cwd"]).exists())
        # The copies are no edit: the page stays at its revision.
        self.assertEqual(self.page_revision(), revision)
        # Each of the three reader's messages is answered, the last one last.
        replies = self.replies("orphan", root["id"])
        self.assertEqual(replies.count(("An answer.", "responder", "")), 3)
        self.assertEqual(replies[-1], ("An answer.", "responder", ""))

    def test_an_image_whose_file_is_gone_is_named_missing(self):
        fish = self.upload("fish-320x240.jpg", "image/jpeg")
        row = self.post({"section": "greeting", "text": "What fish is this?",
                         "images": [fish["name"]]})
        (self.media_dir() / fish["name"]).unlink()

        done = self.respond()
        self.assertEqual(done.returncode, 0, done.stderr)
        [record] = self.records()
        self.assertEqual(record["images"], {})
        prompt = record["prompt"]
        missing = (f"- Image {fish['name']}, 320x240: missing, no longer in the media store, "
                   "so you cannot see it\n")
        answer = prompt[prompt.index("## The comment to answer"):
                        prompt.index("### The thread it belongs to")]
        self.assertIn(missing, answer)
        self.assertIn(missing, self.message(prompt, "####", "Comment", row))
        self.assertNotIn("images/", prompt.replace(responder.LIMITS, ""))
        self.assertEqual(self.replies("orphan", row["id"]), [("An answer.", "responder", "")])

    def test_a_comment_with_no_images_has_no_image_lines_and_no_images_directory(self):
        row = self.comment("orphan", "greeting", "No pictures here.")
        done = self.respond()
        self.assertEqual(done.returncode, 0, done.stderr)
        [record] = self.records()
        self.assertNotIn("- Image ", record["prompt"])
        self.assertIsNone(record["images"])
        self.assertEqual(record["files"], ["orphan.md"])
        self.assertEqual(self.replies("orphan", row["id"]), [("An answer.", "responder", "")])

    page_revision = PromptTests.page_revision


class FailureTests(ResponderCase):
    def test_a_command_that_fails_prints_nothing_or_overruns_fails_its_comment(self):
        commands = (
            ("exit 1", "import sys; sys.stdin.read(); sys.exit(1)", "exited 1"),
            ("silent", "import sys; sys.stdin.read()", "printed no answer"),
            ("slow", "import sys, time; sys.stdin.read(); time.sleep(30); print('Late.')",
             "ran past 2 seconds"),
        )
        rows = []
        for name, body, reason in commands:
            row = self.comment("orphan", "other", f"Comment for the {name} command.")
            started = time.monotonic()
            done = self.respond("--timeout", "2", command=self.stand_in(name, body))
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertLess(time.monotonic() - started, 20)
            root = self.root("orphan", row["id"])
            self.assertEqual(root.get("state"), "failed")
            self.assertIn(reason, root.get("reason", ""))
            self.assertEqual(self.replies("orphan", row["id"]), [])
            rows.append(row)

        done = self.respond()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.records(), [])
        for row in rows:
            self.assertEqual(self.root("orphan", row["id"]).get("state"), "failed")


# A stand-in that records that it ran, outlives a one-second claim, then
# exits with $EXIT, printing $ANSWER.
SLOW = """\
import os, sys, time
sys.stdin.read()
with open(os.environ["RECORD"], "a", encoding="utf-8") as log:
    log.write("{}\\n")
time.sleep(2)
print(os.environ.get("ANSWER", ""))
sys.exit(int(os.environ.get("EXIT", "0")))
"""


class ClaimLapseTests(ResponderCase):
    claim_sec = 1

    def test_a_failure_whose_claim_lapsed_still_fails_the_comment_once(self):
        row = self.comment("orphan", "other", "Will this fail?")
        env = dict(self.env, EXIT="1", ANSWER="Never posted.")
        for _ in range(2):
            done = self.respond(command=self.stand_in("slow", SLOW), env=env)
            self.assertEqual(done.returncode, 0, done.stderr)
            root = self.root("orphan", row["id"])
            self.assertEqual(root.get("state"), "failed")
            self.assertIn("exited 1", root.get("reason", ""))
        self.assertEqual(len(self.records()), 1)
        self.assertEqual(self.replies("orphan", row["id"]), [])

    def test_a_reply_whose_claim_lapsed_is_still_posted_once(self):
        row = self.comment("orphan", "other", "Are you slow?")
        env = dict(self.env, ANSWER="Slow, but here.")
        for _ in range(2):
            done = self.respond(command=self.stand_in("slow", SLOW), env=env)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertEqual(self.replies("orphan", row["id"]),
                             [("Slow, but here.", "responder", "")])
        self.assertEqual(len(self.records()), 1)


class RecoveryTests(ResponderCase):
    """A crash right after a republish, a newer edit by someone else, then a
    pass: the reply lands with the responder's revision, without the agent
    running again, whichever record of the republish the crash lost."""

    def crash_then_edit(self):
        row = self.comment("orphan", "greeting", "Please add a line.")
        crashing = dict(self.env, APPEND="Added by the responder.\n",
                        LOTUSPOD_RESPONDER_CRASH_AFTER="publish")
        done = self.respond(env=crashing)
        self.assertNotEqual(done.returncode, 0)
        [published] = [e["revision"] for e in self.audit() if e["action"] == "publish"]
        self.assertTrue(published)
        # Someone publishes a newer edit before the responder comes back.
        self.publish("orphan", ORPHAN + "Added by the responder.\n\nA newer edit.\n")
        page = (self.out / "orphan.html").read_text(encoding="utf-8")
        self.assertNotIn(f'content="{published}"', page)
        return row, published

    def audit(self):
        done = self.cli("audit", "--json", "--db", str(self.db))
        self.assertEqual(done.returncode, 0, done.stderr)
        return json.loads(done.stdout)

    def finish(self, row, published):
        done = self.respond()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.replies("orphan", row["id"]),
                         [("An answer.", "responder", published)])
        self.assertEqual(self.root("orphan", row["id"]).get("state"), "answered")
        self.assertEqual(len(self.records()), 1)
        self.assertEqual([e["revision"] for e in self.audit() if e["action"] == "publish"],
                         [published])

    def test_a_reply_finished_after_a_newer_edit_keeps_its_revision(self):
        self.finish(*self.crash_then_edit())

    def forget_audit(self):
        conn = sqlite3.connect(str(self.db))
        with conn:
            conn.execute("DELETE FROM audit WHERE action = 'publish'")
        conn.close()

    def forget_journal(self):
        journal = self.tmp / responder.JOURNAL_NAME
        lines = journal.read_text(encoding="utf-8").splitlines(keepends=True)
        kept = [line for line in lines if '"published"' not in line]
        self.assertEqual(len(kept), len(lines) - 1)
        journal.write_text("".join(kept), encoding="utf-8")

    def test_a_reply_finished_after_a_restart_names_the_model_that_wrote_it(self):
        row = self.comment("orphan", "greeting", "Please add a line.")
        crashing = dict(self.env, APPEND="Added by the responder.\n",
                        LOTUSPOD_RESPONDER_CRASH_AFTER="publish")
        done = self.respond(command=f"{self.recorder} --model opus", env=crashing)
        self.assertNotEqual(done.returncode, 0)
        done = self.respond(command=f"{self.recorder} --model=sonnet")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(len(self.records()), 1)
        [reply] = self.thread("orphan", row["id"])["replies"]
        self.assertEqual(reply.get("model"), "opus")

    def test_a_lost_audit_row_is_written_again(self):
        row, published = self.crash_then_edit()
        self.forget_audit()
        self.finish(row, published)

    def test_a_lost_journal_record_is_found_in_the_audit_trail(self):
        row, published = self.crash_then_edit()
        self.forget_journal()
        self.finish(row, published)

    def test_a_publish_with_no_record_is_found_in_the_repository_history(self):
        # A crash between the publish and both of its records.
        for argv in (("init", "-q", "-b", "main"), ("config", "user.name", "Test"),
                     ("config", "user.email", "test@example.com"),
                     ("config", "commit.gpgsign", "false"), ("add", "-A"),
                     ("commit", "-q", "-m", "start")):
            done = git(self.out, *argv)
            self.assertEqual(done.returncode, 0, done.stderr)
        row, published = self.crash_then_edit()
        self.forget_audit()
        self.forget_journal()
        self.finish(row, published)

    def test_without_a_repository_an_unrecorded_publish_is_failed_not_guessed(self):
        row, published = self.crash_then_edit()
        self.forget_audit()
        self.forget_journal()
        done = self.respond()
        self.assertEqual(done.returncode, 0, done.stderr)
        root = self.root("orphan", row["id"])
        self.assertEqual(root.get("state"), "failed")
        self.assertIn("found no sign my edit was published", root.get("reason", ""))
        self.assertEqual(self.replies("orphan", row["id"]), [])
        self.assertEqual(len(self.records()), 1)


class SnapshotTests(ResponderCase):
    def test_a_pull_between_a_publish_s_page_and_source_never_overwrites_it(self):
        # publish writes the page, then its source: freeze the gap between
        # them, the page at a newer edit and its kept source still the old.
        kept = self.out / "orphan.md"
        old = kept.read_bytes()
        self.publish("orphan", ORPHAN.replace("Nothing here.", "A concurrent edit."))
        kept.write_bytes(old)
        page = (self.out / "orphan.html").read_text(encoding="utf-8")
        self.assertNotIn(f'content="{cli.source_revision(old)}"', page)

        row = self.comment("orphan", "greeting", "Please add a line.")
        [item] = self.pull(self.responder, "responder")
        self.assertEqual((item["page"]["source"].encode("utf-8"), item["page"]["revision"]),
                         (old, cli.source_revision(old)))

        done = self.respond(env=dict(self.env, APPEND="The responder's line.\n"))
        self.assertEqual(done.returncode, 0, done.stderr)
        root = self.root("orphan", row["id"])
        self.assertEqual(root.get("state"), "failed")
        self.assertEqual(root.get("reason"), responder.CONFLICT)
        self.assertEqual(self.replies("orphan", row["id"]), [])
        status, _, served = self.api("GET", "/orphan.html")
        self.assertEqual(status, 200)
        self.assertIn("A concurrent edit.", served)
        self.assertNotIn("The responder's line.", served)


class ConcurrencyTests(ResponderCase):
    def test_a_second_pass_leaves_a_running_pass_s_comment_alone(self):
        row = self.comment("orphan", "other", "Take your time.")
        log = open(self.tmp / "first.log", "w+", encoding="utf-8")
        self.addCleanup(log.close)
        first = subprocess.Popen(
            [sys.executable, "-m", "lotuspod", "respond", "--once",
             "--command", self.stand_in("slow", SLOW), "--credential", str(self.responder),
             "--socket", str(self.sock), "--out-dir", str(self.out), "--db", str(self.db)],
            cwd=str(self.tmp), env=dict(self.env, ANSWER="Done at last."), stdout=log,
            stderr=log)
        self.addCleanup(lambda: first.poll() is None and first.kill())
        deadline = time.monotonic() + 15
        while not self.records():
            self.assertLess(time.monotonic(), deadline, "the first pass never ran its agent")
            time.sleep(0.1)

        done = self.respond()
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("another responder pass is running", done.stdout)
        self.assertEqual(self.root("orphan", row["id"]).get("state"), "claimed")

        self.assertEqual(first.wait(30), 0)
        self.assertEqual(self.replies("orphan", row["id"]), [("Done at last.", "responder", "")])
        self.assertEqual(len(self.records()), 1)


class ThreadTests(ResponderCase):
    def test_the_comment_to_answer_is_given_even_past_the_bounded_thread(self):
        root = self.comment("orphan", "other", "Why is this empty?")
        status, _, target = self.api("POST", "/api/comments", {
            "page": "orphan", "parent": root["id"], "text": "The follow-up to answer."})
        self.assertEqual(status, 201, target)
        for number in range(21):
            status, _, row = self.api("POST", "/api/comments", {
                "page": "orphan", "parent": root["id"], "text": f"Later message {number}."})
            self.assertEqual(status, 201, row)
        done = self.respond()
        self.assertEqual(done.returncode, 0, done.stderr)
        [prompt] = [r["prompt"] for r in self.records()
                    if f"comment to answer: comment {target['id']}\n" in r["prompt"]]
        self.assertIn("The follow-up to answer.", prompt)
        self.assertIn(READER, prompt)
        self.assertIn("earlier replies are left out", prompt)
        self.assertEqual(self.replies("orphan", root["id"])[-1][:2], ("An answer.", "responder"))


class SourceTests(ResponderCase):
    def test_an_html_source_is_copied_under_its_own_name_and_republished(self):
        self.publish("notes", HTML_PAGE, suffix=".body.html")
        row = self.comment("notes", "greeting", "Please add a line.")
        env = dict(self.env, APPEND="<p>Edited as HTML.</p>\n", ANSWER="Added it.")
        done = self.respond(env=env)
        self.assertEqual(done.returncode, 0, done.stderr)
        [record] = self.records()
        self.assertEqual(record["files"], ["notes.body.html"])
        self.assertEqual(Path(record["source"]).name, "notes.body.html")
        status, _, page = self.api("GET", "/notes.html")
        self.assertEqual(status, 200)
        self.assertIn("Edited as HTML.", page)
        self.assertIn("Pond notes", page)
        self.assertIn("Edited as HTML.",
                      (self.out / "notes.body.html").read_text(encoding="utf-8"))
        [(text, handle, revision)] = self.replies("notes", row["id"])
        self.assertEqual((text, handle), ("Added it.", "responder"))
        self.assertIn(f'name="lotuspod:revision" content="{revision}"', page)
        done = self.cli("audit", "--json", "--db", str(self.db))
        published = [(e["action"], e["credential"], e["key"]) for e in json.loads(done.stdout)
                     if e["action"] == "publish"]
        replied = [e["key"] for e in json.loads(done.stdout) if e["action"] == "reply"]
        self.assertEqual(published, [("publish", "responder", replied[0])])

    def test_a_page_with_no_kept_source_is_answered_and_the_prompt_says_so(self):
        source = self.tmp / "old.md"
        source.write_text("## Greeting\n\nFrom before sources were kept.\n\n## Other\n\nMore.\n",
                          encoding="utf-8")
        done = self.cli("render", "--name", "old", "--title", "Old page", "--markdown",
                        str(source), "--comments", "--out-dir", str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertFalse((self.out / "old.md").exists())
        row = self.comment("old", "greeting", "Is this still true?")
        done = self.respond(env=dict(self.env, APPEND="Never written.\n"))
        self.assertEqual(done.returncode, 0, done.stderr)
        [record] = self.records()
        self.assertIn("no kept source", record["prompt"])
        self.assertEqual((record["source"], record["files"]), ("", []))
        self.assertEqual(self.replies("old", row["id"]), [("An answer.", "responder", "")])


class CommandTests(ResponderCase):
    def test_the_default_then_the_config_then_the_flag(self):
        home = self.tmp / "home"
        (home / "bin").mkdir(parents=True)
        claude = home / "bin" / "claude"
        claude.write_text(f"#!{sys.executable}\n" + RECORDER, encoding="utf-8")
        claude.chmod(0o755)
        env = dict(self.env, HOME=str(home), XDG_CONFIG_HOME=str(home / "config"),
                   LOTUSPOD_CONFIG=str(self.tmp / "no-config.ini"),
                   PATH=f"{home / 'bin'}{os.pathsep}{os.environ.get('PATH', '')}")

        self.comment("orphan", "other", "Who runs by default?")
        done = self.respond(command=False, env=env)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual([r["argv"] for r in self.records()],
                         [["-p", "--model", "opus", "--permission-mode", "acceptEdits"]])

        config = self.tmp / "responder.ini"
        config.write_text(f"[responder]\ncommand = {self.recorder} from-config\n",
                          encoding="utf-8")
        env["LOTUSPOD_CONFIG"] = str(config)
        self.comment("orphan", "other", "Who runs with a config?")
        done = self.respond(command=False, env=env)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.comment("orphan", "other", "Who runs with the flag?")
        done = self.respond(command=f"{self.recorder} from-flag", env=env)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual([r["argv"] for r in self.records()][1:],
                         [["from-config"], ["from-flag"]])


class ModelTests(ResponderCase):
    def test_a_reply_names_the_model_its_command_names(self):
        for flags, model in ((["--model", "opus"], "opus"), (["--model=sonnet"], "sonnet"),
                             ([], None), (["--model", "m" * 41], None)):
            with self.subTest(flags=flags):
                row = self.comment("orphan", "other", f"Which model, {len(self.records())}?")
                done = self.respond(command=shlex.join([*shlex.split(self.recorder), *flags]))
                self.assertEqual(done.returncode, 0, done.stderr)
                self.assertEqual(self.records()[-1]["argv"], flags)
                [reply] = self.thread("orphan", row["id"])["replies"]
                self.assertEqual(reply["text"], "An answer.")
                self.assertEqual(reply.get("model"), model)
                self.assertEqual("model" in reply, model is not None)
        self.assertEqual(responder.command_model(shlex.split(responder.DEFAULT_COMMAND)),
                         "opus")


class LoopTests(ResponderCase):
    def test_a_running_responder_answers_a_new_comment_and_stops_on_sigterm(self):
        log = open(self.tmp / "respond.log", "w+", encoding="utf-8")
        self.addCleanup(log.close)
        process = subprocess.Popen(
            [sys.executable, "-m", "lotuspod", "respond", "--interval", "1",
             "--command", self.recorder, "--credential", str(self.responder),
             "--socket", str(self.sock), "--out-dir", str(self.out), "--db", str(self.db)],
            cwd=str(self.tmp), env=self.env, stdout=log, stderr=log)
        self.addCleanup(lambda: process.poll() is None and process.kill())
        time.sleep(1.5)
        self.assertIsNone(process.poll())
        row = self.comment("orphan", "other", "Anyone there?")
        deadline = time.monotonic() + 10
        while not self.replies("orphan", row["id"]):
            self.assertLess(time.monotonic(), deadline, "no reply within 10 seconds")
            time.sleep(0.2)
        process.send_signal(signal.SIGTERM)
        self.assertEqual(process.wait(15), 0)
        log.seek(0)
        self.assertNotIn("waiting for serve", log.read())


class StartupWaitTests(ResponderCase):
    """serve restarted with the responder: a comment waits for it, serve is
    stopped (its socket goes), the responder starts, and serve starts again
    one second later."""

    def setUp(self):
        super().setUp()
        self.row = self.comment("orphan", "other", "Anyone there?")
        self.server.terminate()
        self.server.wait(10)
        self.assertFalse(self.sock.exists())
        self.log = open(self.tmp / "respond.log", "w+", encoding="utf-8")
        self.addCleanup(self.log.close)

    def launch(self, *extra, stderr=None):
        process = subprocess.Popen(
            [sys.executable, "-m", "lotuspod", "respond", *extra,
             "--command", self.recorder, "--credential", str(self.responder),
             "--socket", str(self.sock), "--out-dir", str(self.out), "--db", str(self.db)],
            cwd=str(self.tmp), env=self.env, stdout=self.log,
            stderr=stderr or self.log, text=True)
        self.addCleanup(process.wait, 10)
        self.addCleanup(lambda: process.poll() is None and process.kill())
        return process

    def start_responder(self, *extra):
        process = self.launch(*extra)
        time.sleep(1)
        self.start_server()
        return process

    def output(self):
        self.log.seek(0)
        return self.log.read()

    def test_the_loop_waits_for_serve_and_answers_on_its_first_pass(self):
        started = time.monotonic()
        process = self.start_responder("--interval", "60")
        while not self.replies("orphan", self.row["id"]):
            self.assertLess(time.monotonic() - started, 15,
                            f"no reply within 15 seconds; output:\n{self.output()}")
            time.sleep(0.2)
        self.assertIsNone(process.poll())
        lines = self.output().splitlines()
        self.assertEqual([line for line in lines if line.startswith("error:")], [])
        self.assertEqual(len([line for line in lines
                              if "waiting" in line and str(self.sock) in line]), 1, lines)

    def test_once_waits_for_serve_and_answers(self):
        process = self.start_responder("--once")
        self.assertEqual(process.wait(30), 0, self.output())
        self.assertTrue(self.replies("orphan", self.row["id"]))

    def assert_gives_up(self, *extra):
        started = time.monotonic()
        process = self.launch(*extra, "--wait", "2", stderr=subprocess.PIPE)
        _, stderr = process.communicate(timeout=10)
        self.assertLess(time.monotonic() - started, 10)
        self.assertEqual(process.returncode, 1, stderr)
        lines = stderr.splitlines()
        self.assertEqual(len(lines), 1, lines)
        self.assertIn(str(self.sock), lines[0])
        self.assertIn("2 seconds", lines[0])

    def test_once_gives_up_after_wait_seconds(self):
        self.assert_gives_up("--once")

    def test_the_loop_gives_up_after_wait_seconds(self):
        self.assert_gives_up("--interval", "60")

    def test_sigterm_while_waiting_exits_0(self):
        process = self.launch("--wait", "60")
        deadline = time.monotonic() + 10
        while "waiting for serve" not in self.output():
            self.assertLess(time.monotonic(), deadline, self.output())
            time.sleep(0.1)
        process.send_signal(signal.SIGTERM)
        self.assertEqual(process.wait(5), 0, self.output())


class PermissionTests(ResponderCase):
    def test_a_credential_without_publish_revises_nothing(self):
        before = (self.out / "orphan.html").read_bytes()
        limited = self.credential("limited", ["responder"], ["pull", "claim", "reply"])
        row = self.comment("orphan", "greeting", "Please add a line.")
        done = self.respond(credential=limited, env=dict(self.env, APPEND="Not allowed.\n"))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual((self.out / "orphan.html").read_bytes(), before)
        self.assertEqual((self.out / "orphan.md").read_text(encoding="utf-8"), ORPHAN)
        root = self.root("orphan", row["id"])
        self.assertEqual(root.get("state"), "failed")
        self.assertIn("publish", root.get("reason", ""))
        self.assertEqual(self.replies("orphan", row["id"]), [])


class UnitFileTests(unittest.TestCase):
    def unit(self, name):
        parser = configparser.ConfigParser(interpolation=None, strict=False)
        parser.optionxform = str
        parser.read(REPO / "deploy" / name, encoding="utf-8")
        return parser["Service"]

    def test_the_unit_runs_the_loop_like_serve_s_unit(self):
        serve, respond = self.unit("lotuspod.service"), self.unit("lotuspod-respond.service")
        argv = shlex.split(respond["ExecStart"])
        self.assertEqual(argv[0], shlex.split(serve["ExecStart"])[0])
        self.assertEqual(argv[1], "respond")
        self.assertNotIn("--once", argv)
        self.assertIn("--credential", argv)
        self.assertTrue(argv[argv.index("--credential") + 1])
        self.assertEqual(respond["WorkingDirectory"], serve["WorkingDirectory"])
        self.assertEqual(respond["Restart"], "on-failure")
        for key in ("NoNewPrivileges", "PrivateTmp", "ProtectSystem", "ReadWritePaths"):
            self.assertEqual(respond[key], serve[key], key)


if __name__ == "__main__":
    unittest.main()
