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

from lotuspod import agents, db, decisions, machine  # noqa: E402
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


class LapsedDoneTests(InboxTestCase):
    claim_sec = 1

    def test_a_session_whose_claim_lapsed_replies_nothing(self):
        row, item = self.queue("Please file a ticket.", "file a ticket for X")
        rc, first = self.claim("one", item["id"])
        self.assertEqual(rc, 0, first)
        time.sleep(2)
        rc, second = self.claim("two", item["id"])
        self.assertEqual(rc, 0, second)
        rc, refused = self.inbox("one", "done", str(item["id"]), "--owner", "operator",
                                 "--claim", first["claimToken"], "--key", "late-1",
                                 "--text", "Filed, late.")
        self.assertEqual((rc, refused), (1, {"error": "not_claimed"}))
        [thread] = [t for t in self.threads("ops") if t["root"]["id"] == row["id"]]
        self.assertEqual(thread["replies"], [])
        rc, done = self.inbox("two", "done", str(item["id"]), "--owner", "operator",
                              "--claim", second["claimToken"], "--key", "late-1",
                              "--text", "Filed.")
        self.assertEqual(rc, 0, done)
        [thread] = [t for t in self.threads("ops") if t["root"]["id"] == row["id"]]
        self.assertEqual([r["text"] for r in thread["replies"]], ["Filed."])


class ResponderCase(InboxTestCase):
    """InboxTestCase with credentials `ra` and `rb` for two responders."""

    def prepare(self) -> None:
        super().prepare()
        database = db.Database(self.db_path)
        for name in ("ra", "rb"):
            path = self.work / f"{name}.token"
            machine.create_credential(database, name, ["responder"],
                                      ["pull", "claim", "reply"], path)
            self.creds[name] = path

    def ask(self, name: str, target: str, body: dict | None = None) -> tuple[int, dict]:
        return machine.request(self.socket_path, machine.read_token(self.creds[name]),
                               "POST", target, body)


class StaleResponderTests(ResponderCase):
    """Two responders: A's claim lapses while its agent runs, B answers,
    then A's reply arrives. Only a stored reply's ask reaches the inbox."""

    claim_sec = 1

    def race(self, b_ask: str | None) -> tuple[dict, tuple[int, dict]]:
        row = self.comment("Please file a ticket.", page="ops")
        status, a = self.ask("ra", f"/v1/comments/{row['id']}/claim")
        self.assertEqual(status, 200, a)
        time.sleep(2)
        status, b = self.ask("rb", f"/v1/comments/{row['id']}/claim")
        self.assertEqual(status, 200, b)
        body = {"claimToken": b["claimToken"], "idempotencyKey": "b-1", "text": "B's answer."}
        if b_ask is not None:
            body["ask"] = b_ask
        status, replied = self.ask("rb", f"/v1/comments/{row['id']}/reply", body)
        self.assertEqual(status, 200, replied)
        late = self.ask("ra", f"/v1/comments/{row['id']}/reply", {
            "claimToken": a["claimToken"], "idempotencyKey": "a-1", "text": "A's answer.",
            "ask": "ask A"})
        return row, late

    def test_a_stale_reply_never_overwrites_the_ask_that_stands(self):
        _row, late = self.race("ask B")
        self.assertEqual(late, (409, {"error": "not_claimed"}))
        self.assertEqual([item["ask"] for item in self.pulled("one") if item["kind"] == "ask"],
                         ["ask B"])

    def test_a_stale_reply_queues_nothing_after_an_answer_without_an_ask(self):
        _row, late = self.race(None)
        self.assertEqual(late, (409, {"error": "not_claimed"}))
        self.assertEqual(self.asks("one"), [])

    def test_a_retried_reply_queues_its_ask_once(self):
        row = self.comment("Please file a ticket.", page="ops")
        status, a = self.ask("ra", f"/v1/comments/{row['id']}/claim")
        self.assertEqual(status, 200, a)
        body = {"claimToken": a["claimToken"], "idempotencyKey": "a-1", "text": "Queued.",
                "ask": "ask A"}
        for _ in range(2):
            status, replied = self.ask("ra", f"/v1/comments/{row['id']}/reply", body)
            self.assertEqual(status, 200, replied)
        [item] = [item for item in self.pulled("one") if item["kind"] == "ask"]
        self.assertEqual((item["ask"], item["comment"]["id"]), ("ask A", row["id"]))


class OwnerChangeTests(ResponderCase):
    """A page that changes owner while the responder answers a comment on it."""

    def test_the_reply_names_the_owner_the_ask_was_queued_for(self):
        row = self.comment("Please file a ticket.", page="ops")
        status, a = self.ask("ra", f"/v1/comments/{row['id']}/claim")
        self.assertEqual(status, 200, a)
        # The page changes hands while the responder's agent runs.
        path = self.work / "both.token"
        machine.create_credential(db.Database(self.db_path), "both", ["operator", "hermes"],
                                  ["publish"], path)
        rc, _out, err = run_cli("publish", str(self.work / "ops.md"), "--out-dir",
                                str(self.out_dir), "--local", "--owner", "hermes",
                                "--credential", str(path))
        self.assertEqual(rc, 0, err)
        status, replied = self.ask("ra", f"/v1/comments/{row['id']}/reply", {
            "claimToken": a["claimToken"], "idempotencyKey": "a-1", "text": "",
            "ask": "file it"})
        self.assertEqual(status, 200, replied)
        self.assertEqual(replied["text"], "I've queued this for hermes: file it")
        database = db.Database(self.db_path)
        self.assertEqual([item["ask"] for item in database.inbox("hermes", time.time())],
                         ["file it"])
        self.assertEqual(database.inbox("operator", time.time()), [])


class DoneTests(InboxTestCase):
    def test_a_key_used_in_another_thread_closes_nothing(self):
        first, one = self.queue("Please file a ticket.", "file it")
        second, two = self.queue("Please change the page.", "change it")
        rc, claimed = self.claim("one", one["id"])
        self.assertEqual(rc, 0, claimed)
        rc, closed = self.inbox("one", "done", str(one["id"]), "--owner", "operator",
                                "--claim", claimed["claimToken"], "--key", "same",
                                "--text", "Filed.")
        self.assertEqual(rc, 0, closed)
        self.assertEqual(closed["reply"]["parent"], first["id"])
        # A follow-up of its own under the key the next done names.
        rc, out, err = run_cli("comments", "follow-up", str(second["id"]), "--key", "other",
                               "--text", "Looking.", "--json", "--socket",
                               str(self.socket_path), "--credential", str(self.creds["one"]))
        self.assertEqual(rc, 0, out + err)
        rc, claimed = self.claim("one", two["id"])
        self.assertEqual(rc, 0, claimed)
        argv = ("done", str(two["id"]), "--owner", "operator", "--claim",
                claimed["claimToken"])
        self.assertEqual(self.inbox("one", *argv, "--key", "same", "--text", "Changed."),
                         (1, {"error": "key_reused"}))
        # The item stays open: a retry with the key of a message already in its own thread posts it once.
        rc, closed = self.inbox("one", *argv, "--key", "other", "--text", "Looking.")
        self.assertEqual(rc, 0, closed)
        [thread] = [t for t in self.threads("ops") if t["root"]["id"] == second["id"]]
        self.assertEqual([r["text"] for r in thread["replies"]], ["Looking."])

    def test_a_new_ask_for_the_same_comment_replaces_an_open_item_s(self):
        row, item = self.queue("Please file a ticket.", "old task A")
        again = db.Database(self.db_path).queue(owner="operator", page="ops",
                                                comment=row["id"], ask="new task B")
        self.assertEqual((again["id"], again["ask"]), (item["id"], "new task B"))
        rc, claimed = self.claim("one", item["id"])
        self.assertEqual(rc, 0, claimed)
        rc, _done = self.inbox("one", "done", str(item["id"]), "--owner", "operator",
                               "--claim", claimed["claimToken"])
        self.assertEqual(rc, 0, _done)
        kept = db.Database(self.db_path).queue(owner="operator", page="ops",
                                               comment=row["id"], ask="later task C")
        self.assertEqual(kept["ask"], "new task B")


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

    def test_a_reply_through_done_notifies_one_comment_change(self):
        _row, item = self.queue("Please file a ticket.", "file a ticket for X")
        rc, claimed = self.claim("one", item["id"])
        self.assertEqual(rc, 0, claimed)
        notified = []
        self.sockets.routes.changed = lambda what, page: notified.append((what, page))
        rc, done = self.inbox("one", "done", str(item["id"]), "--owner", "operator",
                              "--claim", claimed["claimToken"], "--key", "ticket-1",
                              "--text", "Filed as LOTUS-9.")
        self.assertEqual(rc, 0, done)
        self.assertEqual(notified, [("comment", "ops")])

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

    def test_an_answer_note_is_shown_in_the_inbox_text(self):
        page = (self.out_dir / "ops.html").read_text(encoding="utf-8")
        version = decisions.read_forms(page)["decision-1"].version
        status, answer = self.reader("POST", "/api/answers", {
            "page": "ops", "question": "decision-1", "version": version, "choice": "yes",
            "note": "Only if we buy the safety heater first"})
        self.assertEqual(status, 201, answer)
        [item] = self.pulled("one")
        # The note is kept as a comment, which the inbox does not show.
        self.assertTrue(item.get("noteComment"), item)

        rc, out, err = run_cli("inbox", "pull", "--owner", "operator",
                               "--socket", str(self.socket_path),
                               "--credential", str(self.creds["one"]))
        self.assertEqual(rc, 0, out + err)
        self.assertIn("Only if we buy the safety heater first", out)


class AnswerTextTests(unittest.TestCase):
    def test_an_undone_dismissal_and_a_reworded_question_say_so(self):
        answer = {"id": 4, "choice": "", "note": "", "createdAt": "2026-10-14T12:00:00.000Z",
                  "actor": READER, "dismissed": True, "undoneAt": "2026-10-14T12:05:00.000Z",
                  "revision": "r"}
        question = {"id": "decision-1", "text": "Freeze the pond?", "label": "Dismissed",
                    "reworded": True, "context": ""}
        text = agents.inbox_text({"owner": "operator", "items": [{
            "kind": "answer", "answer": answer, "question": question,
            "page": {"name": "ops", "title": "Plan", "owner": "operator", "revision": "r"}}]})
        self.assertIn("- Question: Freeze the pond? (the page now asks it in other words, "
                      "or not at all)", text)
        self.assertIn("- Undone at 2026-10-14T12:05:00.000Z", text)

    def test_a_checklist_answer_shows_what_changed(self):
        answer = {"id": 5, "choice": "", "note": "", "createdAt": "2026-10-14T12:00:00.000Z",
                  "actor": READER, "checked": ["heater"], "revision": "r"}
        question = {"id": "decision-2", "text": "Which run?", "reworded": False,
                    "label": "On: Heater · Off: Pump", "context": "Winter only.",
                    "changed": [{"id": "heater", "label": "Heater", "checked": True},
                                {"id": "pump", "label": "Pump", "checked": False}]}
        text = agents.inbox_text({"owner": "operator", "items": [{
            "kind": "answer", "answer": answer, "question": question,
            "page": {"name": "ops", "title": "Plan", "owner": "operator", "revision": "r"}}]})
        self.assertIn("- Chosen: On: Heater · Off: Pump\n", text)
        self.assertIn("- Changed: Heater (`heater`) on", text)
        self.assertIn("- Changed: Pump (`pump`) off", text)
        self.assertIn("Winter only.", text)
        self.assertNotIn("(``)", text)


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
