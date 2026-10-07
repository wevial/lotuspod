"""Any agent reads what is meant for it through serve's socket: `lotuspod
comments pull|ack-answer|show`, the routing of reader's comments to one
handle each (`pending` while it listens, `unavailable` while it does not),
the answers on an owner's pages until it acknowledges them, and the database
schema that keeps pulls and acknowledgements.

serve runs on a thread with the test Access key trusted; the reader posts
over its port with assertions from that key, and agents use the commands.

Run from the repo root:

    python -m unittest tests.test_agent_pull -v
"""

from __future__ import annotations

import hashlib
import http.client
import io
import json
import os
import re
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from lotuspod import api, cli, db, decisions, machine, media, routing  # noqa: E402
from tests import access_keys as keys  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[1]
HOST = "127.0.0.1"
READER = {"kind": "human", "email": keys.EMAIL}
# The reader as the page's routes show them.
SHOWN = {"kind": "human", "name": "maintainer"}

PLAN = """\
# Plan

What we will do.

## Goals

Ship it.

## Risks

The pond may freeze.

## Decisions for the maintainer

| # | Question | Options |
| --- | --- | --- |
| 1 | Freeze the pond? | Yes / No |
| 2 | Skate on it? | Yes / No |
"""

# A page asking a checklist under the h2 Emails.
MAIL = """\
# Mail

## Emails

What each new reader is sent.

### Checklist for the maintainer

| # | Item | Default |
| --- | --- | --- |
| w | Welcome | on |
| d | Digest | off |
| r | Reminder | ON |
"""

LOOSE = "# Loose\n\nA page nobody owns.\n\n## One\n\nFirst.\n\n## Two\n\nSecond.\n"

MEDIA_FIXTURES = Path(__file__).resolve().parent / "fixtures" / "media"
CHART = MEDIA_FIXTURES / "chart-1600x600.png"
FISH = MEDIA_FIXTURES / "fish-320x240.jpg"


def run_cli(*argv: str) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        rc = cli.main(list(argv))
    return rc, out.getvalue(), err.getvalue()


class PullTestCase(unittest.TestCase):
    """A page `plan` owned by hermes (sections goals and risks, questions
    decision-1 and decision-2) and a page `loose` with no owner, served with
    the test key trusted. Credential `desk` may pull as hermes, hermes-desk,
    claude-3f9a2c and responder; credential `claude` only as claude-3f9a2c."""

    window: int | None = None

    def setUp(self) -> None:
        # A short directory: a Unix socket's path is limited to about 100 bytes.
        tmp = tempfile.TemporaryDirectory(dir="/tmp" if Path("/tmp").is_dir() else None)
        self.addCleanup(tmp.cleanup)
        self.work = Path(tmp.name).resolve()
        self.out_dir = self.work / "artifacts"
        self.out_dir.mkdir()
        self.db_path = self.work / db.DEFAULT_NAME
        self.socket_path = self.work / machine.SOCKET_NAME
        config = self.work / "config.ini"
        config.write_text(keys.config_text(), encoding="utf-8")
        env = mock.patch.dict(os.environ, {"LOTUSPOD_CONFIG": str(config)})
        env.start()
        self.addCleanup(env.stop)
        os.environ.pop(machine.CREDENTIAL_ENV, None)
        for handler in (cli._AllowListHandler, machine._Handler):
            patcher = mock.patch.object(handler, "log_message", lambda *a: None)
            patcher.start()
            self.addCleanup(patcher.stop)

        database = db.Database(self.db_path)
        self.desk = self.work / "desk.token"
        machine.create_credential(database, "desk",
                                  ["hermes", "hermes-desk", "claude-3f9a2c", "responder"],
                                  ["pull", "publish"], self.desk)
        self.claude = self.work / "claude.token"
        machine.create_credential(database, "claude", ["claude-3f9a2c"], ["pull"], self.claude)
        for name, text, extra in (("plan", PLAN, ("--owner", "hermes",
                                                  "--credential", str(self.desk))),
                                  ("loose", LOOSE, ())):
            source = self.work / f"{name}.md"
            source.write_text(text, encoding="utf-8")
            rc, _out, err = run_cli("publish", str(source), "--out-dir", str(self.out_dir),
                                    "--local", *extra)
            self.assertEqual(rc, 0, err)
        self.prepare()
        self.serve()

    def prepare(self) -> None:
        """Anything the database needs before serve starts."""

    def serve(self) -> None:
        made = {}
        ready = threading.Event()
        real_port, real_socket = cli._make_server, machine.SocketServer

        def make_port(*args, **kwargs):
            made["port"] = real_port(*args, **kwargs)
            return made["port"]

        def make_socket(*args, **kwargs):
            made["socket"] = real_socket(*args, **kwargs)
            ready.set()
            return made["socket"]

        argv = ["serve", "--host", HOST, "--port", "0", "--out-dir", str(self.out_dir)]
        if self.window is not None:
            argv += ["--owner-window", str(self.window)]
        thread = threading.Thread(target=cli.main, args=(argv,), daemon=True)
        patches = (mock.patch.object(cli, "_make_server", make_port),
                   mock.patch.object(machine, "SocketServer", make_socket))
        for patcher in patches:
            patcher.start()
        output = io.StringIO()
        with redirect_stdout(output), redirect_stderr(output):
            thread.start()
            started = ready.wait(15)
            # serve prints once its socket is made: keep that out of the
            # commands' output.
            deadline = time.monotonic() + 15
            while started and "ctrl-c to stop" not in output.getvalue():
                self.assertLess(time.monotonic(), deadline, output.getvalue())
                time.sleep(0.01)
        for patcher in patches:
            patcher.stop()
        self.assertTrue(started, output.getvalue())
        self.port = made["port"].server_address[1]

        def stop() -> None:
            made["port"].shutdown()
            thread.join(timeout=15)

        self.addCleanup(stop)

    # The reader, over serve's port.

    def reader(self, method: str, path: str, body: object = None) -> tuple[int, dict]:
        headers = {"Cf-Access-Jwt-Assertion": keys.assertion()}
        data = None
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        conn = http.client.HTTPConnection(HOST, self.port, timeout=15)
        try:
            conn.request(method, path, body=data, headers=headers)
            response = conn.getresponse()
            payload = response.read()
        finally:
            conn.close()
        return response.status, json.loads(payload.decode("utf-8"))

    def comment(self, text: str, page: str = "plan", section: str = "risks",
                **extra) -> dict:
        status, row = self.reader("POST", "/api/comments",
                                  {"page": page, "section": section, "text": text, **extra})
        self.assertEqual(status, 201, row)
        return row

    def decision_thread(self, text: str, question: str = "decision-1",
                        page: str = "plan") -> dict:
        status, row = self.reader("POST", "/api/comments",
                                  {"page": page, "question": question, "text": text})
        self.assertEqual(status, 201, row)
        return row

    def reply(self, parent: int, text: str, page: str = "plan") -> dict:
        status, row = self.reader("POST", "/api/comments",
                                  {"page": page, "parent": parent, "text": text})
        self.assertEqual(status, 201, row)
        return row

    def answer(self, question: str = "decision-1", choice: str = "yes") -> dict:
        page = (self.out_dir / "plan.html").read_text(encoding="utf-8")
        version = decisions.read_forms(page)[question].version
        status, row = self.reader("POST", "/api/answers", {
            "page": "plan", "question": question, "version": version, "choice": choice,
            "note": "Before the frost.",
        })
        self.assertEqual(status, 201, row)
        return row

    def threads(self, page: str = "plan") -> list[dict]:
        status, payload = self.reader("GET", f"/api/comments?page={page}")
        self.assertEqual(status, 200, payload)
        return payload["threads"]

    def row(self, comment_id: int, page: str = "plan") -> dict:
        for thread in self.threads(page):
            for row in (thread["root"], *thread["replies"]):
                if row["id"] == comment_id:
                    return row
        self.fail(f"no comment {comment_id}")

    # The agents, through the commands.

    def agent(self, *argv: str, credential: Path | None = None) -> tuple[int, str, str]:
        return run_cli("comments", *argv, "--socket", str(self.socket_path),
                       "--credential", str(credential or self.desk))

    def pull(self, owner: str, credential: Path | None = None) -> list[dict]:
        rc, out, err = self.agent("pull", "--owner", owner, "--json", credential=credential)
        self.assertEqual(rc, 0, out + err)
        payload = json.loads(out)
        self.assertEqual(payload["owner"], owner)
        return payload["items"]

    def pulled_comments(self, owner: str) -> list[int]:
        return [item["comment"]["id"] for item in self.pull(owner) if item["kind"] == "comment"]

    def revision(self, page: str = "plan") -> str:
        text = (self.out_dir / f"{page}.html").read_text(encoding="utf-8")
        return re.search(r'<meta name="lotuspod:revision" content="([0-9a-f]+)">', text).group(1)


class PullTests(PullTestCase):
    def test_pulling_twice_returns_the_same_comment_and_answer(self):
        self.assertEqual(self.pull("hermes"), [])
        comment = self.comment("Is the heater enough?")
        answer = self.answer()

        first = self.pull("hermes")
        second = self.pull("hermes")
        self.assertEqual(first, second)
        self.assertEqual([item["kind"] for item in first], ["comment", "answer"])
        comment_item, answer_item = first

        page = {
            "name": "plan", "title": "Plan", "owner": "hermes", "revision": self.revision(),
            "sourceFile": "plan.md",
            "source": (self.out_dir / "plan.md").read_text(encoding="utf-8"),
        }
        self.assertEqual(page["source"], PLAN)
        self.assertEqual(set(comment_item),
                         {"kind", "comment", "thread", "omitted", "resolution", "page"})
        self.assertEqual(comment_item["resolution"], db.UNRESOLVED)
        self.assertEqual(comment_item["page"], page)
        got = comment_item["comment"]
        self.assertEqual(got["id"], comment["id"])
        self.assertEqual(got["actor"], READER)
        self.assertEqual(got["text"], "Is the heater enough?")
        self.assertEqual(got["revision"], self.revision())
        self.assertEqual((got["state"], got["owner"]), ("pending", "hermes"))
        self.assertNotIn("arrival", got)
        self.assertEqual((comment_item["thread"], comment_item["omitted"]), ([got], 0))

        self.assertEqual(set(answer_item), {"kind", "answer", "question", "page"})
        self.assertEqual(answer_item["page"], page)
        # The page is shown the reader's name; the agents get the address.
        self.assertEqual(api.shown(answer_item["answer"]), answer)
        self.assertEqual(answer_item["answer"]["actor"], READER)
        self.assertEqual(answer_item["question"], {"id": "decision-1", "text": "Freeze the pond?",
                                                   "label": "Yes", "reworded": False})

        # Reading took nothing off the queue: the reader's page still shows it waiting.
        self.assertEqual(self.row(comment["id"])["state"], "pending")

    def test_a_credential_pulls_only_as_its_own_handles(self):
        self.pull("hermes")
        self.comment("For hermes.")
        self.answer()
        rc, out, _err = self.agent("pull", "--owner", "hermes", "--json", credential=self.claude)
        self.assertNotEqual(rc, 0)
        self.assertEqual(json.loads(out), {"error": "handle_not_allowed"})
        rc, _out, err = self.agent("pull", "--owner", "hermes", credential=self.claude)
        self.assertNotEqual(rc, 0)
        self.assertIn("handle_not_allowed", err)
        self.assertEqual(self.pull("claude-3f9a2c", credential=self.claude), [])

    def test_a_thread_is_its_root_and_its_last_twenty_messages(self):
        root = self.comment("Message 1", page="loose", section="one")
        rows = [root] + [self.reply(root["id"], f"Message {n}", page="loose")
                         for n in range(2, 31)]
        [item] = [item for item in self.pull("responder")
                  if item["kind"] == "comment" and item["comment"]["id"] == rows[-1]["id"]]
        thread = item["thread"]
        self.assertEqual(thread[0]["id"], root["id"])
        self.assertEqual([row["text"] for row in thread[1:]],
                         [f"Message {n}" for n in range(11, 31)])
        self.assertEqual(item["omitted"], 9)


class RoutingTests(PullTestCase):
    def test_a_mention_waits_for_its_handle_alone(self):
        self.pull("hermes")
        self.pull("responder")
        named = self.comment("@hermes-desk can you check the pump?")
        self.assertEqual((named["state"], named["owner"]), ("unavailable", "hermes-desk"))
        row = self.row(named["id"])
        self.assertEqual((row["state"], row["owner"]), ("unavailable", "hermes-desk"))
        self.assertNotIn(named["id"], self.pulled_comments("hermes"))
        self.assertNotIn(named["id"], self.pulled_comments("responder"))

        self.assertIn(named["id"], self.pulled_comments("hermes-desk"))
        row = self.row(named["id"])
        self.assertEqual((row["state"], row["owner"]), ("pending", "hermes-desk"))
        self.assertNotIn(named["id"], self.pulled_comments("hermes"))

    def test_a_mention_is_a_handle_at_the_very_start(self):
        self.pull("hermes")
        upper = self.comment("@Claude-3f9a2c, is this right?")
        colon = self.comment("@claude-3f9a2c: see the risks")
        email = self.comment("email@claude-3f9a2c is where I sent it")
        self.assertEqual(self.pulled_comments("claude-3f9a2c"), [upper["id"], colon["id"]])
        self.assertEqual(self.pulled_comments("hermes"), [email["id"]])
        self.assertEqual(self.pulled_comments("responder"), [])

    def test_mentions(self):
        cases = {
            "@hermes": "hermes", "@HERMES-Desk hi": "hermes-desk", "@responder.": "responder",
            "@hermes\nnext line": "hermes", "@hermes!": "hermes", "@hermes-desk?": "hermes-desk",
            "@hermesé": None, " @hermes": None, "hermes": None, "@": None, "@-x": None,
            "@" + "a" * 64: None, "@" + "a" * 63: "a" * 63,
        }
        for text, handle in cases.items():
            with self.subTest(text=text):
                self.assertEqual(routing.mention(text), handle)

    def test_a_page_with_no_owner_goes_to_the_responder_at_once(self):
        loose = self.comment("Who reads this?", page="loose", section="one")
        self.assertEqual((loose["state"], loose["owner"]), ("unavailable", "responder"))
        self.assertIn(loose["id"], self.pulled_comments("responder"))
        self.assertEqual(self.row(loose["id"], "loose")["state"], "pending")

    def test_an_owner_not_listening_leaves_it_to_the_responder(self):
        comment = self.comment("Nobody pulled yet.")
        self.pull("hermes")
        self.assertNotIn(comment["id"], self.pulled_comments("hermes"))
        self.assertIn(comment["id"], self.pulled_comments("responder"))


class OwnerWindowTests(PullTestCase):
    window = 1

    def test_the_responder_gets_it_once_the_owner_window_passes(self):
        self.pull("hermes")
        comment = self.comment("Still waiting?")
        time.sleep(2)
        # The owner still reads it, as the responder's.
        [item] = [item for item in self.pull("hermes") if item["kind"] == "comment"]
        self.assertEqual((item["comment"]["id"], item["comment"]["owner"]),
                         (comment["id"], "responder"))
        self.assertIn(comment["id"], self.pulled_comments("responder"))
        row = self.row(comment["id"])
        self.assertEqual((row["state"], row["owner"]), ("pending", "responder"))


class AckTests(PullTestCase):
    def test_an_acknowledged_answer_is_not_pulled_again(self):
        answer = self.answer()
        [item] = self.pull("hermes")
        self.assertEqual(item["answer"]["id"], answer["id"])

        rc, out, _err = self.agent("ack-answer", str(answer["id"]), "--json",
                                   credential=self.claude)
        self.assertNotEqual(rc, 0)
        self.assertEqual(json.loads(out), {"error": "handle_not_allowed"})
        self.assertEqual(len(self.pull("hermes")), 1)

        rc, out, err = self.agent("ack-answer", str(answer["id"]), "--json")
        self.assertEqual(rc, 0, err)
        acked = json.loads(out)
        self.assertEqual((acked["answer"], acked["owner"]), (answer["id"], "hermes"))
        self.assertEqual(self.pull("hermes"), [])

        later = self.answer(choice="no")
        [item] = self.pull("hermes")
        self.assertEqual(item["answer"]["id"], later["id"])
        self.assertEqual(item["answer"]["supersedes"], answer["id"])
        self.assertEqual(item["question"]["label"], "No")

        rc, out, _err = self.agent("ack-answer", "999", "--json")
        self.assertNotEqual(rc, 0)
        self.assertEqual(json.loads(out), {"error": "unknown_answer"})

    def test_an_answer_keeps_the_words_the_reader_answered(self):
        answer = self.answer()
        source = self.work / "plan.md"
        source.write_text(PLAN.replace("Freeze the pond?", "Drain the pond?")
                          .replace("| Yes / No |\n| 2", "| Yes please / No |\n| 2"),
                          encoding="utf-8")
        rc, _out, err = run_cli("publish", str(source), "--out-dir", str(self.out_dir),
                                "--local")
        self.assertEqual(rc, 0, err)
        # An answer stored before the words were kept, to the same question.
        old = db.Database(self.db_path).add_answer(
            page="plan", question="decision-1", version=answer["version"], choice="no",
            note="", revision=answer["revision"], actor=READER,
        )
        items = {item["answer"]["id"]: item for item in self.pull("hermes")}
        self.assertEqual(items[answer["id"]]["question"], {
            "id": "decision-1", "text": "Freeze the pond?", "label": "Yes", "reworded": True,
        })
        self.assertEqual(items[old["id"]]["question"], {
            "id": "decision-1", "text": "", "label": "no", "reworded": True,
        })
        rc, out, err = self.agent("pull", "--owner", "hermes")
        self.assertEqual(rc, 0, err)
        self.assertIn("Freeze the pond? (the page now asks it in other words", out)

    def test_answers_on_pages_it_does_not_own_are_not_its(self):
        self.answer()
        self.assertEqual(self.pull("responder"), [])
        self.assertEqual(self.pull("claude-3f9a2c"), [])


class TextTests(PullTestCase):
    def test_reader_text_sits_in_a_fence_longer_than_its_backticks(self):
        self.pull("hermes")
        text = "Run ````rm -rf```` here?\n```\nnot a fence end\n```"
        self.comment(text)
        rc, out, err = self.agent("pull", "--owner", "hermes")
        self.assertEqual(rc, 0, err)
        fences = re.findall(r"^(`{3,})\n(.*?)\n\1$", out, re.MULTILINE | re.DOTALL)
        texts = {body: marks for marks, body in fences}
        self.assertIn(text, texts)
        self.assertGreaterEqual(len(texts[text]), 5)
        self.assertIn("`plan`", out)
        self.assertIn("Risks (`risks`)", out)
        self.assertIn(self.revision(), out)
        self.assertIn("plan.md", out)
        self.assertIn(keys.EMAIL, out)

    def test_show_prints_what_the_threads_route_answers(self):
        first = self.comment("First thread.")
        self.reply(first["id"], "A reply.")
        self.comment("Second thread.", section="goals")
        rc, out, err = self.agent("show", "plan", "--json")
        self.assertEqual(rc, 0, err)
        shown = json.loads(out)
        self.assertEqual(len(shown["threads"]), 2)
        self.assertEqual(api.shown(shown), {"page": "plan", "threads": self.threads()})

        rc, out, err = self.agent("show", "plan")
        self.assertEqual(rc, 0, err)
        self.assertIn("First thread.", out)
        self.assertIn("A reply.", out)

        rc, out, _err = self.agent("show", "nowhere", "--json")
        self.assertNotEqual(rc, 0)
        self.assertEqual(json.loads(out), {"error": "unknown_page"})


class ResolvedThreadTests(PullTestCase):
    """A resolved thread is still pulled, and its markdown says who resolved it."""

    def resolve(self, thread: int) -> dict:
        status, got = self.reader("POST", "/api/comments",
                                  {"page": "plan", "thread": thread, "resolved": True})
        self.assertEqual(status, 200, got)
        return got["resolution"]

    def markdown(self, *argv: str) -> str:
        rc, out, err = self.agent(*argv)
        self.assertEqual(rc, 0, err)
        return out

    def test_a_pending_comment_in_a_resolved_thread_is_pulled_with_the_resolution(self):
        self.pull("hermes")
        done = self.comment("Is the heater enough?")
        resolution = self.resolve(done["id"])
        later = self.reply(done["id"], "One more thing.")
        # The reply reopened it: resolve it again, leaving both comments pending.
        resolution = self.resolve(done["id"])
        self.assertEqual((resolution["resolved"], resolution["actor"]), (True, SHOWN))
        still = self.comment("Who watches the pond?", section="goals")

        items = {item["comment"]["id"]: item for item in self.pull("hermes")
                 if item["kind"] == "comment"}
        self.assertEqual(sorted(items), sorted([done["id"], later["id"], still["id"]]))
        for comment_id in (done["id"], later["id"]):
            item = items[comment_id]
            self.assertEqual(item["comment"]["state"], "pending")
            self.assertEqual(item["resolution"]["actor"], READER)
            self.assertEqual(api.shown(item["resolution"]), resolution)
        self.assertEqual(items[still["id"]]["resolution"], db.UNRESOLVED)
        self.assertEqual(self.row(done["id"])["state"], "pending")

        line = f"Resolved by {keys.EMAIL} at {resolution['at']}"
        out = self.markdown("pull", "--owner", "hermes")
        parts = re.split(r"^## \d+\. ", out, flags=re.MULTILINE)[1:]
        self.assertEqual(len(parts), 3)
        for part in parts:
            thread = part[part.index("### Thread"):]
            if part.startswith(f"Comment {still['id']} "):
                self.assertNotIn("Resolved by", part)
            else:
                _heading, rest = thread.split("\n\n", 1)
                self.assertTrue(rest.startswith(line + "\n"), thread)

        out = self.markdown("show", "plan")
        resolved, plain = out.split("## Section Goals")
        self.assertIn(f"## Section Risks (`risks`)\n\n{line}\n", resolved)
        self.assertEqual(resolved.count("Resolved by"), 1)
        self.assertNotIn("Resolved by", plain)


class FollowUpPullTests(PullTestCase):
    """An agent's follow-up is in the thread a later pull and `show` give."""

    def prepare(self) -> None:
        self.hermes = self.work / "hermes.token"
        machine.create_credential(db.Database(self.db_path), "hermes", ["hermes"],
                                  ["pull", "claim", "reply"], self.hermes)

    def as_hermes(self, *argv: str) -> dict:
        rc, out, err = self.agent(*argv, "--json", credential=self.hermes)
        self.assertEqual(rc, 0, out + err)
        return json.loads(out)

    def test_a_reader_comment_after_a_follow_up_is_pulled_with_it_in_its_thread(self):
        self.pull("hermes", credential=self.hermes)
        asked = self.comment("Is the heater enough?")
        claim = self.as_hermes("claim", str(asked["id"]))
        first = self.as_hermes("reply", str(asked["id"]), f"--claim={claim['claimToken']}",
                               "--key", "pull-1", "--text", "I'll ask the author.")
        follow = self.as_hermes("follow-up", str(asked["id"]), "--key", "pull-2",
                                "--text", "The author says it is.")
        # A follow-up is no reader's comment: nothing new waits.
        self.assertEqual(self.pull("hermes", credential=self.hermes), [])

        later = self.reply(asked["id"], "Thanks. And the pump?")
        [item] = [item for item in self.pull("hermes", credential=self.hermes)
                  if item["kind"] == "comment"]
        self.assertEqual(item["comment"]["id"], later["id"])
        self.assertEqual([row["id"] for row in item["thread"]],
                         [asked["id"], first["id"], follow["id"], later["id"]])

        rc, out, err = self.agent("show", "plan")
        self.assertEqual(rc, 0, err)
        self.assertIn(f"### Reply {follow['id']}, hermes, {follow['createdAt']}\n", out)
        self.assertLess(out.index("I'll ask the author."), out.index("The author says it is."))


class ModelPullTests(PullTestCase):
    """A reply's model is printed on its line by `pull` and `show`."""

    prepare = FollowUpPullTests.prepare
    as_hermes = FollowUpPullTests.as_hermes

    def test_pull_and_show_name_the_model_of_a_reply_that_names_one(self):
        self.pull("hermes", credential=self.hermes)
        asked = self.comment("Is the heater enough?")
        claim = self.as_hermes("claim", str(asked["id"]))
        named = self.as_hermes("reply", str(asked["id"]), f"--claim={claim['claimToken']}",
                               "--key", "model-1", "--text", "It is.",
                               "--model", "Claude Opus 5.5")
        again = self.reply(asked["id"], "And the pump?")
        claim = self.as_hermes("claim", str(again["id"]))
        plain = self.as_hermes("reply", str(again["id"]), f"--claim={claim['claimToken']}",
                               "--key", "model-2", "--text", "It works.")
        self.reply(asked["id"], "Thanks.")
        for argv, level in ((("pull", "--owner", "hermes"), "####"), (("show", "plan"), "###")):
            with self.subTest(command=argv[0]):
                rc, out, err = self.agent(*argv, credential=self.hermes)
                self.assertEqual(rc, 0, err)
                self.assertIn(f"{level} Reply {named['id']}, hermes, {named['createdAt']}, "
                              "model Claude Opus 5.5\n", out)
                self.assertIn(f"{level} Reply {plain['id']}, hermes, {plain['createdAt']}\n",
                              out)
                self.assertEqual(out.count("model "), 1)


class ImageTests(PullTestCase):
    """A comment's images, as `pull` and `show` give them to an agent: each
    with the path of its file in the media directory on this host."""

    def upload(self, path: Path, media_type: str) -> dict:
        conn = http.client.HTTPConnection(HOST, self.port, timeout=15)
        try:
            conn.request("POST", "/api/media", body=path.read_bytes(),
                         headers={"Cf-Access-Jwt-Assertion": keys.assertion(),
                                  "Content-Type": media_type})
            response = conn.getresponse()
            payload = json.loads(response.read().decode("utf-8"))
        finally:
            conn.close()
        self.assertEqual(response.status, 201, payload)
        return payload

    def thread_with_images(self) -> tuple[dict, dict, list[dict]]:
        """A pending comment for hermes carrying the chart then the fish, and
        a reader's reply carrying none."""
        self.pull("hermes")
        uploaded = [self.upload(CHART, "image/png"), self.upload(FISH, "image/jpeg")]
        root = self.comment("See these.", images=[image["name"] for image in uploaded])
        reply = self.reply(root["id"], "And nothing more.")
        return root, reply, uploaded

    def pulled(self, comment_id: int) -> dict:
        [item] = [item for item in self.pull("hermes")
                  if item["kind"] == "comment" and item["comment"]["id"] == comment_id]
        return item

    def test_a_pull_gives_each_image_s_path_in_the_media_directory(self):
        root, _reply, uploaded = self.thread_with_images()
        media_dir = media.media_dir(self.out_dir)
        item = self.pulled(root["id"])
        images = item["comment"]["images"]
        self.assertEqual([image["name"] for image in images],
                         [image["name"] for image in uploaded])
        for image, sent, size in zip(images, uploaded, ((1600, 600), (320, 240))):
            self.assertEqual(set(image), {"name", "url", "width", "height", "path"})
            self.assertEqual({key: image[key] for key in ("name", "url", "width", "height")},
                             sent)
            self.assertEqual((image["width"], image["height"]), size)
            path = Path(image["path"])
            self.assertTrue(path.is_absolute())
            self.assertEqual(path.parent, media_dir)
            stem, _, _ = image["name"].partition(".")
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), stem)
        self.assertEqual(item["thread"][0]["images"], images)
        self.assertEqual(item["thread"][1]["images"], [])

    def test_show_gives_the_same_paths_as_the_pull(self):
        root, reply, _uploaded = self.thread_with_images()
        pulled = self.pulled(root["id"])["comment"]["images"]
        rc, out, err = self.agent("show", "plan", "--json")
        self.assertEqual(rc, 0, err)
        [thread] = json.loads(out)["threads"]
        self.assertEqual((thread["root"]["id"], thread["root"]["images"]), (root["id"], pulled))
        self.assertEqual([(row["id"], row["images"]) for row in thread["replies"]],
                         [(reply["id"], [])])

    def test_an_image_whose_file_is_gone_has_no_path(self):
        root, _reply, uploaded = self.thread_with_images()
        (media.media_dir(self.out_dir) / uploaded[0]["name"]).unlink()
        images = self.pulled(root["id"])["comment"]["images"]
        self.assertEqual([image["name"] for image in images],
                         [image["name"] for image in uploaded])
        self.assertIsNone(images[0]["path"])
        self.assertEqual(Path(images[1]["path"]),
                         media.media_dir(self.out_dir) / uploaded[1]["name"])

    def test_pull_and_show_print_a_line_for_each_image_under_its_message(self):
        root, reply, uploaded = self.thread_with_images()
        media_dir = media.media_dir(self.out_dir)
        (media_dir / uploaded[0]["name"]).unlink()
        gone = (f"- Image {uploaded[0]['url']}, 1600x600, not in the media directory\n")
        kept = (f"- Image {uploaded[1]['url']}, 320x240, "
                f"file {media_dir / uploaded[1]['name']}\n")
        for argv, level in ((("pull", "--owner", "hermes"), "####"), (("show", "plan"), "###")):
            with self.subTest(command=argv[0]):
                rc, out, err = self.agent(*argv)
                self.assertEqual(rc, 0, err)
                start = out.index(f"{level} Comment {root['id']},")
                end = out.index(f"{level} Reply {reply['id']},")
                message = out[start:end]
                self.assertIn("See these.", message)
                self.assertIn(gone + kept, message)
                self.assertLess(message.index("See these."), message.index(gone))
                after = out[end:]
                after = after[:after.index("\n#")] if "\n#" in after else after
                self.assertNotIn("- Image", after)
        # The comment being pulled lists its images too, as the first message
        # of its own item's thread and of the reply's; the reply lists none.
        rc, out, err = self.agent("pull", "--owner", "hermes")
        self.assertEqual(rc, 0, err)
        self.assertEqual(out.count(gone), 3)
        self.assertEqual(out.count(kept), 3)
        self.assertEqual(out.count("- Image "), 6)
        pulled = out[out.index(f"## 1. Comment {root['id']} "):out.index("### Thread")]
        self.assertLess(pulled.index("See these."), pulled.index(gone + kept))
        self.assertLess(pulled.index(gone + kept), pulled.index("- Claim:"))


class PassageTests(PullTestCase):
    """A comment on a highlighted passage, as the markdown prints it."""

    QUOTE = {"exact": "may freeze", "prefix": "The pond ", "suffix": "."}
    # The highlighted words, then the same words with the text around them.
    PASSAGE = re.compile(r"The reader highlighted(?:, on revision ([0-9a-f]+|unknown))?:\n\n"
                         r"(`{3,})\n(.*?)\n\2\n\nWith the words around it:\n\n"
                         r"(`{3,})\n(.*?)\n\4\n", re.DOTALL)

    def republish(self) -> None:
        source = self.work / "plan.md"
        source.write_text(PLAN.replace("Ship it.", "Ship it soon."), encoding="utf-8")
        rc, _out, err = run_cli("publish", str(source), "--out-dir", str(self.out_dir),
                                "--local", "--owner", "hermes", "--credential", str(self.desk))
        self.assertEqual(rc, 0, err)

    def markdown(self, *argv: str) -> str:
        rc, out, err = self.agent(*argv)
        self.assertEqual(rc, 0, err)
        return out

    def test_a_pull_prints_the_passage_and_the_revision_it_was_highlighted_on(self):
        self.pull("hermes")
        read = self.revision()
        comment = self.comment("Freeze how hard?", quote=self.QUOTE, revision=read)
        self.assertEqual(comment["revision"], read)
        out = self.markdown("pull", "--owner", "hermes")
        self.assertIn(f"- Passage: highlighted on revision {read}; "
                      "the page is still at that revision", out)
        self.assertNotIn("Quoting the page", out)

        self.republish()
        now = self.revision()
        self.assertNotEqual(now, read)
        out = self.markdown("pull", "--owner", "hermes")
        self.assertIn(f"- Passage: highlighted on revision {read}; "
                      f"the page is now at revision {now}", out)
        self.assertLess(out.index("- State:"), out.index("- Passage:"))
        # The item's passage, then the thread's first comment's.
        passages = self.PASSAGE.findall(out)
        self.assertEqual(len(passages), 2)
        for highlighted_on, _marks, exact, _around_marks, around in passages:
            self.assertEqual(exact, "may freeze")
            self.assertEqual(around, "The pond may freeze.")
        self.assertEqual([on for on, *_rest in passages], ["", read])
        self.assertLess(out.index("The reader highlighted:"), out.index("Freeze how hard?"))

    def test_a_comment_with_no_quote_prints_no_passage(self):
        self.pull("hermes")
        self.comment("Just a thought.")
        out = self.markdown("pull", "--owner", "hermes")
        self.assertIn("Just a thought.", out)
        for absent in ("Passage:", "The reader highlighted", "Quoting the page"):
            self.assertNotIn(absent, out)

    def test_show_prints_the_passage_of_a_quoted_thread_only(self):
        read = self.revision()
        self.comment("On the words.", quote=self.QUOTE, revision=read)
        self.comment("On the section.", section="goals")
        out = self.markdown("show", "plan")
        quoted, plain = out.split("## Section Goals")
        self.assertEqual(self.PASSAGE.findall(quoted),
                         [(read, "```", "may freeze", "```", "The pond may freeze.")])
        self.assertIn(f"The reader highlighted, on revision {read}:", quoted)
        self.assertIn("On the section.", plain)
        self.assertNotIn("The reader highlighted", plain)
        self.assertNotIn("With the words around it", plain)

    def test_a_passage_sits_in_fences_longer_than_its_backticks(self):
        self.pull("hermes")
        quote = {"exact": "the ````pond```` may", "prefix": "", "suffix": " ```freeze```"}
        self.comment("Which pond?", quote=quote)
        out = self.markdown("pull", "--owner", "hermes")
        passages = self.PASSAGE.findall(out)
        self.assertEqual(len(passages), 2)
        for _on, marks, exact, around_marks, around in passages:
            self.assertEqual(exact, quote["exact"])
            self.assertEqual(around, quote["exact"] + quote["suffix"])
            self.assertGreater(len(marks), 4)
            self.assertGreater(len(around_marks), 4)

    def test_a_quoted_comment_is_routed_as_any_other(self):
        self.pull("hermes")
        self.pull("claude-3f9a2c")
        named = self.comment("@claude-3f9a2c is this the right word?", quote=self.QUOTE)
        plain = self.comment("Is this the right word?", quote=self.QUOTE)
        self.assertEqual(self.pulled_comments("claude-3f9a2c"), [named["id"]])
        self.assertEqual(self.pulled_comments("hermes"), [plain["id"]])


class DecisionPullTests(PullTestCase):
    """A thread on a decision is pulled with the decision as the page asks
    it now, and its current answer."""

    OPTIONS = [{"value": "yes", "label": "Yes"}, {"value": "no", "label": "No"}]

    def items(self, owner: str = "hermes", credential: Path | None = None) -> dict:
        return {item["comment"]["id"]: item for item in self.pull(owner, credential)
                if item["kind"] == "comment"}

    def markdown(self, *argv: str) -> str:
        rc, out, err = self.agent(*argv)
        self.assertEqual(rc, 0, err)
        return out

    def test_the_pull_carries_the_decision_and_its_current_answer(self):
        self.pull("hermes")
        asked = self.decision_thread("I need more context pls.")
        plain = self.comment("On the section.")
        self.assertEqual(asked["question"], "decision-1")
        items = self.items()
        self.assertEqual(items[asked["id"]]["decision"], {
            "id": "decision-1", "text": "Freeze the pond?", "options": self.OPTIONS,
            "answer": None, "asked": True})
        self.assertEqual(items[asked["id"]]["comment"]["question"], "decision-1")
        self.assertEqual([row["question"] for row in items[asked["id"]]["thread"]],
                         ["decision-1"])
        self.assertNotIn("decision", items[plain["id"]])
        self.assertNotIn("question", items[plain["id"]]["comment"])

        answer = self.answer(choice="no")
        decision = self.items()[asked["id"]]["decision"]
        self.assertEqual((decision["answer"]["choice"], decision["answer"]["note"]),
                         ("no", "Before the frost."))
        self.assertEqual(decision["answer"]["actor"], READER)
        self.assertEqual(api.shown(decision["answer"]), answer)

        source = self.work / "plan.md"
        source.write_text(PLAN.replace("| 1 | Freeze the pond? | Yes / No |\n", ""),
                          encoding="utf-8")
        rc, _out, err = run_cli("publish", str(source), "--out-dir", str(self.out_dir),
                                "--local", "--owner", "hermes", "--credential", str(self.desk))
        self.assertEqual(rc, 0, err)
        decision = self.items()[asked["id"]]["decision"]
        self.assertEqual((decision["id"], decision["text"], decision["options"],
                          decision["asked"]), ("decision-1", "", [], False))

    def test_a_decision_thread_is_routed_as_any_comment(self):
        self.pull("hermes")
        self.pull("claude-3f9a2c", credential=self.claude)
        named = self.decision_thread("@claude-3f9a2c which are the same buttons?")
        self.assertEqual(list(self.items("claude-3f9a2c", self.claude)), [named["id"]])
        self.assertNotIn(named["id"], self.items())

    def test_a_decision_thread_whose_owner_is_not_listening_goes_to_the_responder(self):
        asked = self.decision_thread("Nobody pulled yet.")
        self.assertEqual(asked["owner"], "responder")
        self.assertIn(asked["id"], self.items("responder"))
        self.assertEqual(self.items("responder")[asked["id"]]["decision"]["id"], "decision-1")

    def test_pull_and_show_print_the_decision(self):
        self.pull("hermes")
        asked = self.decision_thread("Which are the same buttons?", question="decision-2")
        self.comment("On the section.", section="goals")
        out = self.markdown("pull", "--owner", "hermes")
        mine, plain = out.split("section Goals")
        self.assertIn("- Decision: `decision-2`, Skate on it?\n"
                      "- Options: Yes (`yes`), No (`no`)\n"
                      "- Answer: not answered yet\n", mine)
        self.assertNotIn("- Decision:", plain)
        self.assertNotIn("- Options:", plain)

        page = (self.out_dir / "plan.html").read_text(encoding="utf-8")
        version = decisions.read_forms(page)["decision-2"].version
        status, answer = self.reader("POST", "/api/answers", {
            "page": "plan", "question": "decision-2", "version": version, "choice": "yes",
            "note": "Only ```if``` it holds."})
        self.assertEqual(status, 201, answer)
        out = self.markdown("pull", "--owner", "hermes")
        self.assertIn(f"- Answer: Yes (`yes`), by {keys.EMAIL} at {answer['createdAt']}\n"
                      "\nThe answer's note:\n\n````\nOnly ```if``` it holds.\n````\n", out)
        self.assertNotIn("not answered yet", out)

        out = self.markdown("show", "plan")
        self.assertIn("## Decision `decision-2` in section "
                      "Decisions for the maintainer (`decisions-for-the-maintainer`)\n", out)
        self.assertIn("## Section Goals (`goals`)\n", out)
        self.assertLess(out.index("Which are the same buttons?"), out.index("## Section Goals"))
        self.assertEqual(out.count("## Decision"), 1, asked)


class ChecklistPullTests(PullTestCase):
    """A checklist's answer is pulled with the items the reader changed from
    their defaults."""

    def setUp(self) -> None:
        super().setUp()
        self.publish_mail(MAIL)
        self.pull("hermes")

    def publish_mail(self, text: str) -> None:
        source = self.work / "mail.md"
        source.write_text(text, encoding="utf-8")
        rc, _out, err = run_cli("publish", str(source), "--out-dir", str(self.out_dir),
                                "--local", "--owner", "hermes", "--credential", str(self.desk))
        self.assertEqual(rc, 0, err)

    def answer_checklist(self, checked: list[str]) -> dict:
        page = (self.out_dir / "mail.html").read_text(encoding="utf-8")
        version = decisions.read_forms(page)["checklist-1"].version
        status, row = self.reader("POST", "/api/answers", {
            "page": "mail", "question": "checklist-1", "version": version,
            "checked": checked, "note": ""})
        self.assertEqual(status, 201, row)
        return row

    def pulled(self, answer: dict) -> dict:
        [item] = [item for item in self.pull("hermes")
                  if item["kind"] == "answer" and item["answer"]["id"] == answer["id"]]
        return item

    def markdown(self, answer: dict) -> str:
        rc, out, err = self.agent("pull", "--owner", "hermes")
        self.assertEqual(rc, 0, err)
        start = out.index(f"Answer {answer['id']} on `mail`")
        return out[start:out.index("- Acknowledge:", start)]

    def test_the_pull_gives_the_items_changed_from_their_defaults(self):
        answer = self.answer_checklist(["d", "r"])
        item = self.pulled(answer)
        self.assertEqual(item["answer"]["checked"], ["d", "r"])
        self.assertEqual(item["question"], {
            "id": "checklist-1", "text": "Emails", "label": "On: Digest · Off: Welcome",
            "reworded": False,
            "changed": [{"id": "w", "label": "Welcome", "checked": False},
                        {"id": "d", "label": "Digest", "checked": True}]})
        self.assertIn("- Chosen: On: Digest · Off: Welcome\n"
                      "- Changed: Welcome (`w`) off\n"
                      "- Changed: Digest (`d`) on\n", self.markdown(answer))

        self.publish_mail(MAIL.replace("| r | Reminder | ON |", "| r | Reminder | off |"))
        question = self.pulled(answer)["question"]
        self.assertEqual((question["changed"], question["reworded"], question["label"]),
                         (None, True, "On: Digest · Off: Welcome"))
        text = self.markdown(answer)
        self.assertIn("- Chosen: On: Digest · Off: Welcome\n", text)
        self.assertNotIn("- Changed:", text)

    def test_checking_the_defaults_changes_nothing(self):
        answer = self.answer_checklist(["w", "r"])
        question = self.pulled(answer)["question"]
        self.assertEqual((question["label"], question["changed"]),
                         ("No change from the defaults", []))
        self.assertIn("- Chosen: No change from the defaults\n- Changed: nothing\n",
                      self.markdown(answer))

    def test_a_decision_answer_has_no_changes(self):
        item = self.pulled(self.answer())
        self.assertNotIn("changed", item["question"])
        self.assertNotIn("checked", item["answer"])


class SchemaTests(PullTestCase):
    # The schema version the database is left at before serve opens it.
    version = 2

    def prepare(self) -> None:
        # The database again as an earlier schema wrote it, with the
        # credentials and a comment in it: serve is the first to open it.
        credentials = db.Database(self.db_path).credentials()
        for path in self.work.glob(db.DEFAULT_NAME + "*"):
            path.unlink()
        conn = sqlite3.connect(str(self.db_path))
        for step in range(1, self.version + 1):
            for statement in db._SCHEMA[step]:
                conn.execute(statement)
        for row in credentials:
            conn.execute(
                "INSERT INTO credentials (name, handles, operations, token_hash, created_at)"
                " VALUES (?, ?, ?, ?, ?)",
                (row["name"], json.dumps(row["handles"]), json.dumps(row["operations"]),
                 row["tokenHash"], row["createdAt"]),
            )
        conn.execute(
            "INSERT INTO comments (page, section, section_title, revision, parent, text,"
            " quote, actor, created_at, state) VALUES ('plan', 'risks', 'Risks', 'r', NULL,"
            " 'Kept from before.', NULL, ?, '2026-01-02T03:04:05.000Z', 'pending')",
            (json.dumps(READER),),
        )
        self.prepare_rows(conn)
        conn.execute(f"PRAGMA user_version = {self.version}")
        conn.commit()
        conn.close()

    def prepare_rows(self, conn: sqlite3.Connection) -> None:
        """Any rows this schema's database holds beside the comment."""

    def test_a_previous_database_keeps_its_rows(self):
        conn = sqlite3.connect(str(self.db_path))
        try:
            self.assertEqual(conn.execute("PRAGMA user_version").fetchone()[0], self.version)
        finally:
            conn.close()
        [thread] = self.threads()
        self.assertEqual(thread["root"]["text"], "Kept from before.")
        self.assertEqual(thread["root"]["owner"], "responder")
        self.assertIn(thread["root"]["id"], self.pulled_comments("responder"))
        conn = sqlite3.connect(str(self.db_path))
        try:
            self.assertEqual(conn.execute("PRAGMA user_version").fetchone()[0],
                             db.SCHEMA_VERSION)
        finally:
            conn.close()
        self.assertEqual(db.SCHEMA_VERSION, 10)


class ReplySchemaTests(SchemaTests):
    """The schema before replies named their model, holding an agent's reply."""

    version = 6
    AGENT = {"kind": "agent", "handle": "hermes", "credential": "hermes"}

    def prepare_rows(self, conn: sqlite3.Connection) -> None:
        conn.execute(
            "INSERT INTO comments (page, section, section_title, revision, parent, text,"
            " quote, actor, created_at, state, reply_credential, reply_key) VALUES ('plan',"
            " 'risks', 'Risks', '', 1, 'Answered before.', NULL, ?,"
            " '2026-01-02T03:05:05.000Z', 'answered', 'hermes', 'old-1')",
            (json.dumps(self.AGENT),),
        )

    def test_a_reply_from_before_keeps_its_text_and_actor_and_names_no_model(self):
        [thread] = self.threads()
        [reply] = thread["replies"]
        self.assertEqual((reply["text"], reply["actor"]), ("Answered before.", self.AGENT))
        self.assertNotIn("model", reply)


class DecisionSchemaTests(SchemaTests):
    """The schema before threads on decisions."""

    version = 8

    def test_a_comment_from_before_names_no_decision(self):
        [thread] = self.threads()
        self.assertEqual(thread["root"]["text"], "Kept from before.")
        self.assertNotIn("question", thread["root"])


class OwnerWindowOptionTests(unittest.TestCase):
    def test_the_window_comes_from_the_flag_then_the_config_then_the_default(self):
        with tempfile.TemporaryDirectory() as tmp:
            config = Path(tmp) / "config.ini"
            with mock.patch.dict(os.environ, {"LOTUSPOD_CONFIG": str(config)}):
                self.assertEqual(cli.owner_window(None), routing.DEFAULT_WINDOW)
                config.write_text("[comments]\nowner_window_sec = 42\n", encoding="utf-8")
                self.assertEqual(cli.owner_window(None), 42)
                self.assertEqual(cli.owner_window(7), 7)
                for bad in (0, -1):
                    with self.subTest(flag=bad), self.assertRaises(cli.ConfigError):
                        cli.owner_window(bad)
                config.write_text("[comments]\nowner_window_sec = soon\n", encoding="utf-8")
                with self.assertRaises(cli.ConfigError):
                    cli.owner_window(None)


class ReadmeTests(unittest.TestCase):
    def test_the_agents_section_shows_the_pull_loop_for_each_kind_of_agent(self):
        readme = (REPO_ROOT / "docs" / "agents.md").read_text(encoding="utf-8")
        start = readme.index("## Agents: the pull loop\n")
        end = readme.index("\n## ", start + 1)
        section = readme[start:end]
        for needle in ("lotuspod comments pull --owner my-agent", "comments ack-answer",
                       "comments show", "Claude Code", "Codex", "#!/bin/sh"):
            self.assertIn(needle, section)
        self.assertNotIn("Hermes", section)
        # Each example agent's own block pulls and reads as my-agent.
        for intro in ("A Claude Code session, told in its prompt",
                      "A Codex session, the same loop"):
            with self.subTest(example=intro):
                at = section.index(intro)
                opening = section.index("```", at)
                block = section[opening:section.index("```", opening + 3)]
                self.assertIn("--owner my-agent", block)
                self.assertIn("~/.config/lotuspod/my-agent.token", block)
                self.assertNotRegex(block, r"claude-[0-9a-f]{6}|codex-[0-9a-f]{6}")


if __name__ == "__main__":
    unittest.main()
