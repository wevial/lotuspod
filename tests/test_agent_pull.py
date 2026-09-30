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

from lotuspod import cli, db, decisions, machine, routing  # noqa: E402
from tests import access_keys as keys  # noqa: E402

REPO_ROOT = Path(__file__).resolve().parents[1]
HOST = "127.0.0.1"
READER = {"kind": "human", "email": keys.EMAIL}

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

LOOSE = "# Loose\n\nA page nobody owns.\n\n## One\n\nFirst.\n\n## Two\n\nSecond.\n"


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

    def comment(self, text: str, page: str = "plan", section: str = "risks") -> dict:
        status, row = self.reader("POST", "/api/comments",
                                  {"page": page, "section": section, "text": text})
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
        self.assertEqual(set(comment_item), {"kind", "comment", "thread", "page"})
        self.assertEqual(comment_item["page"], page)
        got = comment_item["comment"]
        self.assertEqual(got["id"], comment["id"])
        self.assertEqual(got["actor"], READER)
        self.assertEqual(got["text"], "Is the heater enough?")
        self.assertEqual(got["revision"], self.revision())
        self.assertEqual((got["state"], got["owner"]), ("pending", "hermes"))
        self.assertNotIn("arrival", got)
        self.assertEqual(comment_item["thread"], {"root": got, "replies": [], "omitted": 0})

        self.assertEqual(set(answer_item), {"kind", "answer", "question", "page"})
        self.assertEqual(answer_item["page"], page)
        self.assertEqual(answer_item["answer"], answer)
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
        self.assertEqual(thread["root"]["id"], root["id"])
        self.assertEqual([row["text"] for row in thread["replies"]],
                         [f"Message {n}" for n in range(11, 31)])
        self.assertEqual(thread["omitted"], 9)


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
        self.assertNotIn(comment["id"], self.pulled_comments("hermes"))
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
        self.assertEqual(shown, {"page": "plan", "threads": self.threads()})

        rc, out, err = self.agent("show", "plan")
        self.assertEqual(rc, 0, err)
        self.assertIn("First thread.", out)
        self.assertIn("A reply.", out)

        rc, out, _err = self.agent("show", "nowhere", "--json")
        self.assertNotEqual(rc, 0)
        self.assertEqual(json.loads(out), {"error": "unknown_page"})


class SchemaTests(PullTestCase):
    def prepare(self) -> None:
        # The database again as the previous schema wrote it, with the
        # credentials and a comment in it: serve is the first to open it.
        credentials = db.Database(self.db_path).credentials()
        for path in self.work.glob(db.DEFAULT_NAME + "*"):
            path.unlink()
        conn = sqlite3.connect(str(self.db_path))
        for step in (1, 2):
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
        conn.execute("PRAGMA user_version = 2")
        conn.commit()
        conn.close()

    def test_a_previous_database_keeps_its_rows(self):
        conn = sqlite3.connect(str(self.db_path))
        try:
            self.assertEqual(conn.execute("PRAGMA user_version").fetchone()[0], 2)
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
        self.assertEqual(db.SCHEMA_VERSION, 3)


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
        readme = (REPO_ROOT / "README.md").read_text(encoding="utf-8")
        start = readme.index("## Agents: the pull loop\n")
        end = readme.index("\n## ", start + 1)
        section = readme[start:end]
        for needle in ("lotuspod comments pull --owner", "comments ack-answer",
                       "comments show", "Claude Code", "Codex", "Hermes", "#!/bin/sh"):
            self.assertIn(needle, section)


if __name__ == "__main__":
    unittest.main()
