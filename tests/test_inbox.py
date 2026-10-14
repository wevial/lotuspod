"""An owner's inbox: `lotuspod inbox pull|claim|done --owner HANDLE` over
serve's socket, a claim's expiry and lapse, done with and without a reply
in the thread, decision answers waiting in it until acknowledged, and the
migration that adds its table.

serve runs on a thread with the test Access key trusted, as in
tests.test_agent_pull; the reader posts over its port, the responder's
queueing is stood in for by the database's own queue(), and the owner's
sessions use the commands.

Run from the repo root:

    python -m unittest tests.test_inbox -v
"""

from __future__ import annotations

import json
import sqlite3
import sys
import tempfile
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from lotuspod import db, decisions, machine  # noqa: E402
from tests.test_agent_pull import PLAN, READER, PullTestCase, run_cli  # noqa: E402


class InboxTestCase(PullTestCase):
    """PullTestCase's site, with a page `ops` owned by operator (PLAN's
    sections and decisions) and credentials `one` and `two` for two sessions
    of operator, which may pull, claim, reply and publish as it."""

    claim_sec: int | None = None

    def prepare(self) -> None:
        if self.claim_sec is not None:
            config = self.work / "config.ini"
            config.write_text(config.read_text(encoding="utf-8")
                              + f"\n[comments]\nclaim_sec = {self.claim_sec}\n",
                              encoding="utf-8")
        database = db.Database(self.db_path)
        self.creds = {}
        for name in ("one", "two"):
            path = self.work / f"{name}.token"
            machine.create_credential(database, name, ["operator"],
                                      ["pull", "claim", "reply", "publish"], path)
            self.creds[name] = path
        source = self.work / "ops.md"
        source.write_text(PLAN, encoding="utf-8")
        rc, _out, err = run_cli("publish", str(source), "--out-dir", str(self.out_dir),
                                "--local", "--owner", "operator",
                                "--credential", str(self.creds["one"]))
        self.assertEqual(rc, 0, err)

    def inbox(self, name: str, *argv: str, json_out: bool = True) -> tuple[int, object]:
        """`lotuspod inbox ARGV` as credential name: exit code and JSON, or
        the printed text without json_out."""
        rc, out, err = run_cli("inbox", *argv, *(("--json",) if json_out else ()),
                               "--socket", str(self.socket_path),
                               "--credential", str(self.creds.get(name, name)))
        if not json_out:
            return rc, out + err
        try:
            return rc, json.loads(out)
        except ValueError:
            self.fail(out + err)

    def pulled(self, name: str) -> list[dict]:
        rc, payload = self.inbox(name, "pull", "--owner", "operator")
        self.assertEqual(rc, 0, payload)
        self.assertEqual(payload["owner"], "operator")
        return payload["items"]

    def asks(self, name: str) -> list[int]:
        return [item["id"] for item in self.pulled(name) if item["kind"] == "ask"]

    def claim(self, name: str, item_id: int) -> tuple[int, dict]:
        return self.inbox(name, "claim", str(item_id), "--owner", "operator")

    def queue(self, text: str, ask: str) -> tuple[dict, dict]:
        """A reader's comment on ops, and the item the responder queued from it."""
        row = self.comment(text, page="ops")
        item = db.Database(self.db_path).queue(owner="operator", page="ops",
                                               comment=row["id"], ask=ask)
        return row, item


class ClaimTests(InboxTestCase):
    claim_sec = 1

    def test_a_claimed_item_leaves_the_pull_until_its_claim_lapses(self):
        _row, first = self.queue("Please file a ticket.", "file a ticket for X")
        _row, second = self.queue("Please change the page.", "change the risks")
        self.assertEqual(self.asks("two"), [first["id"], second["id"]])

        rc, claimed = self.claim("one", first["id"])
        self.assertEqual(rc, 0, claimed)
        self.assertEqual((claimed["item"], claimed["owner"]), (first["id"], "operator"))
        self.assertTrue(claimed["claimToken"] and claimed["expiresAt"])
        # The other session sees only item 2, and cannot take item 1.
        self.assertEqual(self.asks("two"), [second["id"]])
        self.assertEqual(self.claim("two", first["id"]), (1, {"error": "claimed"}))
        # Nor can the same credential, from another session.
        self.assertEqual(self.claim("one", first["id"]), (1, {"error": "claimed"}))

        time.sleep(2)
        # Lapsed: open again, and the old token closes nothing.
        self.assertEqual(self.asks("two"), [first["id"], second["id"]])
        rc, again = self.claim("two", first["id"])
        self.assertEqual(rc, 0, again)
        rc, refused = self.inbox("one", "done", str(first["id"]), "--owner", "operator",
                                 "--claim", claimed["claimToken"])
        self.assertEqual((rc, refused), (1, {"error": "not_claimed"}))
        self.assertEqual(self.asks("one"), [second["id"]])


class DoneTests(InboxTestCase):
    def test_done_closes_an_item_and_it_is_not_listed_again(self):
        _row, first = self.queue("Please file a ticket.", "file a ticket for X")
        _row, second = self.queue("Please change the page.", "change the risks")
        rc, claimed = self.claim("one", first["id"])
        self.assertEqual(rc, 0, claimed)
        rc, done = self.inbox("one", "done", str(first["id"]), "--owner", "operator",
                              "--claim", claimed["claimToken"])
        self.assertEqual(rc, 0, done)
        self.assertEqual((done["item"]["id"], done["reply"]), (first["id"], None))
        self.assertTrue(done["item"]["doneAt"])
        self.assertEqual(self.asks("one"), [second["id"]])
        self.assertEqual(self.claim("two", first["id"]), (1, {"error": "settled"}))

    def test_done_with_text_replies_in_the_thread_once_per_key(self):
        row, item = self.queue("Please file a ticket.", "file a ticket for X")
        rc, claimed = self.claim("one", item["id"])
        self.assertEqual(rc, 0, claimed)
        argv = ("done", str(item["id"]), "--owner", "operator", "--claim",
                claimed["claimToken"])
        self.assertEqual(self.inbox("one", *argv, "--text", "Filed."),
                         (1, {"error": "invalid_body"}))
        rc, done = self.inbox("one", *argv, "--key", "ticket-1", "--text", "Filed as LOTUS-9.")
        self.assertEqual(rc, 0, done)
        self.assertEqual((done["reply"]["parent"], done["reply"]["text"]),
                         (row["id"], "Filed as LOTUS-9."))
        [thread] = [t for t in self.threads("ops") if t["root"]["id"] == row["id"]]
        self.assertEqual([(r["text"], r["actor"]["handle"]) for r in thread["replies"]],
                         [("Filed as LOTUS-9.", "operator")])
        self.assertEqual(self.asks("one"), [])
        self.assertEqual(self.inbox("one", *argv, "--key", "ticket-1", "--text", "Again."),
                         (1, {"error": "settled"}))

    def test_another_handle_reads_and_takes_nothing(self):
        _row, item = self.queue("Please file a ticket.", "file a ticket for X")
        rc, refused = self.inbox(str(self.claude), "pull", "--owner", "operator")
        self.assertEqual((rc, refused), (1, {"error": "handle_not_allowed"}))
        rc, refused = self.inbox(str(self.claude), "claim", str(item["id"]),
                                 "--owner", "operator")
        self.assertEqual((rc, refused), (1, {"error": "handle_not_allowed"}))
        rc, unknown = self.claim("one", item["id"] + 1)
        self.assertEqual((rc, unknown), (1, {"error": "unknown_item"}))

    def test_the_pull_prints_each_ask_with_its_comment_and_commands(self):
        row, item = self.queue("Please file a ticket.", "file a ticket for X")
        rc, text = self.inbox("one", "pull", "--owner", "operator", json_out=False)
        self.assertEqual(rc, 0, text)
        self.assertIn("# Inbox of operator: 1 item", text)
        self.assertIn(f"## 1. Item {item['id']} on `ops`, Plan: file a ticket for X", text)
        self.assertIn(f"from comment {row['id']} in thread {row['id']}", text)
        self.assertIn(f"`lotuspod inbox claim {item['id']} --owner operator`", text)
        self.assertIn("```\nPlease file a ticket.\n```", text)


class AnswerTests(InboxTestCase):
    def test_a_decision_answer_waits_in_the_inbox_until_acknowledged(self):
        page = (self.out_dir / "ops.html").read_text(encoding="utf-8")
        version = decisions.read_forms(page)["decision-1"].version
        status, answer = self.reader("POST", "/api/answers", {
            "page": "ops", "question": "decision-1", "version": version, "choice": "yes",
            "note": ""})
        self.assertEqual(status, 201, answer)
        _row, item = self.queue("Please file a ticket.", "file a ticket for X")

        items = self.pulled("one")
        self.assertEqual([(i["kind"], i.get("id") or i["answer"]["id"]) for i in items],
                         [("ask", item["id"]), ("answer", answer["id"])])
        self.assertEqual(items[1]["answer"]["actor"], READER)
        self.assertEqual(items[1]["page"]["name"], "ops")
        # Pulled twice, still there: only acknowledging takes it out.
        self.assertEqual(self.pulled("two"), items)

        rc, out, err = run_cli("comments", "ack-answer", str(answer["id"]), "--json",
                               "--socket", str(self.socket_path),
                               "--credential", str(self.creds["one"]))
        self.assertEqual(rc, 0, out + err)
        self.assertEqual([i["kind"] for i in self.pulled("one")], ["ask"])


class MigrationTests(unittest.TestCase):
    def test_an_older_database_gains_the_inbox_and_nothing_else_changes(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / db.DEFAULT_NAME
            conn = sqlite3.connect(str(path))
            for step in range(1, 16):
                for statement in db._SCHEMA[step]:
                    conn.execute(statement)
            conn.execute(
                "INSERT INTO comments (page, section, section_title, revision, parent, text,"
                " quote, actor, created_at, state) VALUES ('ops', 'risks', 'Risks', 'r', NULL,"
                " 'Kept from before.', NULL, ?, '2026-01-02T03:04:05.000Z', 'pending')",
                (json.dumps(READER),))
            conn.execute(
                "INSERT INTO answers (page, question, version, choice, note, revision, actor,"
                " created_at) VALUES ('ops', 'decision-1', 'v1', 'no', '', 'r', ?,"
                " '2026-01-02T03:06:05.000Z')", (json.dumps(READER),))
            conn.execute("PRAGMA user_version = 15")
            conn.commit()

            def snapshot() -> dict:
                tables = conn.execute(
                    "SELECT name, sql FROM sqlite_master WHERE name NOT LIKE '%inbox%'"
                    " ORDER BY name").fetchall()
                return {name: (sql, conn.execute(f'SELECT * FROM "{name}"').fetchall()
                               if sql and sql.startswith("CREATE TABLE") else None)
                        for name, sql in tables}

            before = snapshot()
            database = db.Database(path)
            self.assertEqual(database.inbox("operator", time.time()), [])
            self.assertEqual(conn.execute("PRAGMA user_version").fetchone()[0], 16)
            self.assertEqual(snapshot(), before)
            item = database.queue(owner="operator", page="ops", comment=1, ask="file it")
            self.assertEqual((item["id"], item["comment"], item["doneAt"]), (1, 1, None))
            conn.close()


if __name__ == "__main__":
    unittest.main()
