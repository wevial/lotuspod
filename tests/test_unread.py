"""`lotuspod serve` counts the replies in a reader's own threads as unread
until they open the thread: `unread` on the comments read, the thread post
on /api/seen and the counts on its read, over HTTP, with hermes replying
through the agents' socket, and a database from the previous schema step.

Run from the repo root:

    python -m unittest tests.test_unread -v
"""

from __future__ import annotations

import io
import json
import sqlite3
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stderr, redirect_stdout
from functools import partial
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from lotuspod import cli, db, machine, routing  # noqa: E402
from tests import access_keys as keys  # noqa: E402
from tests.test_api import ACTOR, CREATED_AT, DECISIONS_BODY, ApiTestCase, run_cli  # noqa: E402

# Reader a, the maintainer, and reader b.
A = keys.EMAIL
B = "heron@example.com"
OWNER = "hermes"


class UnreadTestCase(ApiTestCase):
    """The ApiTestCase site with `plan` and `other` owned by hermes, whose
    credential may pull, claim, reply and publish, readers a and b allowed,
    and the agents' socket served over the same database."""

    def setUp(self) -> None:
        super().setUp()
        self.stop()
        # A short directory: a Unix socket's path is limited to about 100 bytes.
        tmp = tempfile.TemporaryDirectory(dir="/tmp" if Path("/tmp").is_dir() else None)
        self.addCleanup(tmp.cleanup)
        self.socket_path = Path(tmp.name) / machine.SOCKET_NAME
        self.token = self.work / "hermes.token"
        machine.create_credential(db.Database(self.db_path), OWNER, [OWNER],
                                  ["pull", "claim", "reply", "publish"], self.token)
        owned = ("--owner", OWNER, "--credential", str(self.token), "--db", str(self.db_path))
        run_cli("publish", str(self.work / "plan.md"), "--name", "plan", "--out-dir",
                str(self.out_dir), "--local", *owned)
        run_cli("render", "--name", "other", "--title", "Other", "--comments", "--body",
                DECISIONS_BODY, "--out-dir", str(self.out_dir), *owned)
        self.revision = self.page_revision()
        self.start(allowed_emails=f"{A} {B}")
        patcher = mock.patch.object(machine._Handler, "log_message", lambda *a: None)
        patcher.start()
        self.addCleanup(patcher.stop)
        sockets = machine.SocketServer(
            self.socket_path, db.Database(self.db_path),
            pages=partial(cli.api_page, self.out_dir),
            describe=partial(cli.agent_page, self.out_dir), window=routing.DEFAULT_WINDOW,
            claim_sec=routing.DEFAULT_CLAIM,
        )
        thread = threading.Thread(target=sockets.serve_forever, daemon=True)
        thread.start()

        def stop() -> None:
            sockets.shutdown()
            sockets.server_close()
            thread.join(timeout=5)

        self.addCleanup(stop)

    # The readers, over serve's port.

    def post(self, email: str, body: dict) -> dict:
        status, row = self.ask("POST", "/api/comments", body, assertion=keys.assertion(email))
        self.assertEqual(status, 201, row)
        return row

    def open_thread(self, email: str, text: str, page: str = "plan",
                    section: str = "risks") -> dict:
        return self.post(email, {"page": page, "section": section, "text": text})

    def reply(self, email: str, parent: int, text: str, page: str = "plan") -> dict:
        return self.post(email, {"page": page, "parent": parent, "text": text})

    def unread(self, email: str = A, page: str = "plan") -> list[int]:
        status, got = self.ask("GET", f"/api/comments?page={page}",
                               assertion=keys.assertion(email))
        self.assertEqual(status, 200, got)
        return got["unread"]

    def seen(self, body: dict, email: str = A, **options):
        return self.ask("POST", "/api/seen", body, assertion=keys.assertion(email), **options)

    def marks(self) -> list[tuple]:
        """Every stored (reader, thread, comment)."""
        with db.Database(self.db_path)._connect() as conn:
            return [tuple(row) for row in conn.execute(
                "SELECT reader, thread, comment FROM thread_views ORDER BY reader, thread")]

    # hermes, through the commands on the agents' socket.

    def hermes(self, *argv: str) -> dict:
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            rc = cli.main(["comments", *argv, "--json", "--socket", str(self.socket_path),
                           "--credential", str(self.token)])
        self.assertEqual(rc, 0, out.getvalue() + err.getvalue())
        return json.loads(out.getvalue())

    def answer(self, comment: dict, text: str) -> dict:
        """hermes claims a reader's comment and replies to it."""
        claim = self.hermes("claim", str(comment["id"]))
        return self.hermes("reply", str(comment["id"]), f"--claim={claim['claimToken']}",
                           "--key", f"answer-{comment['id']}", "--text", text)

    def follow_up(self, root: dict, text: str) -> dict:
        return self.hermes("follow-up", str(root["id"]), "--key", f"follow-{text}",
                           "--text", text)


class UnreadTests(UnreadTestCase):
    def test_a_reply_is_unread_for_the_thread_s_reader_alone_until_they_reply(self):
        # hermes listens, so the comment waits for it.
        self.hermes("pull", "--owner", OWNER)
        root = self.open_thread(A, "Is the heater enough?")
        answered = self.answer(root, "It is, down to minus ten.")
        self.assertEqual(answered["parent"], root["id"])
        self.assertEqual(self.unread(A), [answered["id"]])
        self.assertEqual(self.unread(B), [])

        self.reply(A, root["id"], "Thanks. And the pump?")
        self.assertEqual(self.unread(A), [])

        later = self.follow_up(root, "The pump stops in January.")
        self.assertEqual(self.unread(A), [later["id"]])
        self.assertEqual(self.unread(B), [])
        # Nothing is marked seen by reading or replying.
        self.assertEqual(self.marks(), [])

    def test_a_reader_s_reply_reads_everything_before_it(self):
        root = self.open_thread(B, "Who checks the ice?")
        mine = self.reply(A, root["id"], "I do, every morning.")
        theirs = self.follow_up(root, "I can remind you.")
        self.assertEqual(self.unread(A), [theirs["id"]])
        self.assertNotIn(root["id"], self.unread(A))
        # b started the thread: a's reply and hermes's are both unread for b.
        self.assertEqual(self.unread(B), [mine["id"], theirs["id"]])

    def test_a_resolved_thread_still_counts(self):
        root = self.open_thread(A, "Is the heater enough?")
        status, got = self.ask("POST", "/api/comments",
                               {"page": "plan", "thread": root["id"], "resolved": True})
        self.assertEqual(status, 200, got)
        later = self.follow_up(root, "One more thing.")
        self.assertEqual(self.unread(A), [later["id"]])

    def test_a_post_marks_the_thread_seen_and_the_mark_never_goes_down(self):
        root = self.open_thread(A, "Is the heater enough?")
        first = self.follow_up(root, "It is.")
        self.assertEqual(self.unread(A), [first["id"]])
        body = {"page": "plan", "thread": root["id"], "comment": first["id"]}
        self.assertEqual(self.seen(body), (200, {"thread": root["id"], "comment": first["id"]}))
        self.assertEqual(self.unread(A), [])
        # b's view of the thread is b's own.
        self.assertEqual(self.marks(), [(A, root["id"], first["id"])])

        lower = {**body, "comment": root["id"]}
        self.assertEqual(self.seen(lower), (200, {"thread": root["id"], "comment": first["id"]}))
        self.assertEqual(self.marks(), [(A, root["id"], first["id"])])
        later = self.follow_up(root, "Down to minus ten.")
        self.assertEqual(self.unread(A), [later["id"]])

        # A mark past the thread's newest comment stops there, so a reply
        # still to come is unread when it arrives.
        ahead = {**body, "comment": 2 ** 63 - 1}
        self.assertEqual(self.seen(ahead), (200, {"thread": root["id"], "comment": later["id"]}))
        self.assertEqual(self.unread(A), [])
        latest = self.follow_up(root, "And the pump with it.")
        self.assertEqual(self.unread(A), [latest["id"]])
        self.assertEqual(self.marks(), [(A, root["id"], later["id"])])

        elsewhere = self.open_thread(A, "On the other page.", page="other", section="page")
        self.assertEqual(
            self.seen({"page": "plan", "thread": elsewhere["id"], "comment": elsewhere["id"]}),
            (404, {"error": "unknown_thread"}))
        # A reply is no thread's first comment.
        self.assertEqual(
            self.seen({"page": "plan", "thread": first["id"], "comment": first["id"]}),
            (404, {"error": "unknown_thread"}))
        self.assertEqual(self.marks(), [(A, root["id"], later["id"])])

    def test_a_refused_thread_post_stores_nothing(self):
        root = self.open_thread(A, "Is the heater enough?")
        good = {"page": "plan", "thread": root["id"], "comment": root["id"]}
        for body, options, answer in (
            ({**good, "page": "secret"}, {}, (404, {"error": "unknown_page"})),
            ({**good, "thread": 0}, {}, (400, {"error": "invalid_body"})),
            ({**good, "comment": "1"}, {}, (400, {"error": "invalid_body"})),
            ({**good, "comment": True}, {}, (400, {"error": "invalid_body"})),
            ({"page": "plan", "thread": root["id"]}, {}, (400, {"error": "invalid_body"})),
            ({**good, "revision": self.revision}, {}, (400, {"error": "invalid_body"})),
            (good, {"headers": {"Origin": "https://elsewhere.example"}},
             (403, {"error": "cross_origin"})),
        ):
            with self.subTest(body=body, options=options):
                self.assertEqual(self.seen(body, **options), answer)
        self.assertEqual(self.ask("POST", "/api/seen", good, assertion=None),
                         (401, {"error": "signed_out"}))
        self.assertEqual(self.marks(), [])

    def test_the_seen_read_counts_each_page_s_unread_replies(self):
        root = self.open_thread(A, "Is the heater enough?")
        self.follow_up(root, "It is.")
        self.follow_up(root, "Down to minus ten.")
        elsewhere = self.open_thread(A, "On the other page.", page="other", section="page")
        self.follow_up(elsewhere, "Noted.")
        status, got = self.seen({"page": "plan", "revision": self.revision})
        self.assertEqual(status, 200, got)

        status, got = self.ask("GET", "/api/seen")
        self.assertEqual(status, 200, got)
        seen_at = got["pages"]["plan"]["seenAt"]
        self.assertRegex(seen_at, CREATED_AT)
        self.assertEqual(got, {"pages": {
            "other": {"revision": self.page_revision("other"), "seen": None, "seenAt": None,
                      "replies": 0, "unread": 1},
            "plan": {"revision": self.revision, "seen": self.revision, "seenAt": seen_at,
                     "replies": 0, "unread": 2},
        }})
        # No answer names a reader or carries an address.
        self.assertNotIn("@", json.dumps(got))
        self.assertEqual(self.ask("GET", "/api/seen", assertion=keys.assertion(B)),
                         (200, {"pages": {}}))

    def test_a_page_republished_without_comments_has_no_unread_replies(self):
        root = self.open_thread(A, "Is the heater enough?")
        reply = self.follow_up(root, "It is.")
        self.assertEqual(self.unread(A), [reply["id"]])
        self.republish("--no-comments")

        self.assertEqual(self.unread(A), [])
        # Reader a never opened plan: it was listed only for its unread reply.
        status, got = self.ask("GET", "/api/seen")
        self.assertEqual(status, 200, got)
        self.assertNotIn("plan", got["pages"])

    def republish(self, *options: str) -> None:
        run_cli("publish", str(self.work / "plan.md"), "--name", "plan", "--out-dir",
                str(self.out_dir), "--local", "--owner", OWNER, "--credential",
                str(self.token), "--db", str(self.db_path), *options)

    def test_an_opened_page_without_comments_counts_no_unread_and_they_come_back(self):
        root = self.open_thread(A, "Is the heater enough?")
        reply = self.follow_up(root, "It is.")
        status, got = self.seen({"page": "plan", "revision": self.revision})
        self.assertEqual(status, 200, got)
        self.republish("--no-comments")

        self.assertEqual(self.unread(A), [])
        status, got = self.ask("GET", "/api/seen")
        self.assertEqual(status, 200, got)
        self.assertEqual(got["pages"]["plan"]["unread"], 0)

        # Comments, threads and marks stayed stored: the reply is unread again.
        self.republish()
        self.assertEqual(self.unread(A), [reply["id"]])
        status, got = self.ask("GET", "/api/seen")
        self.assertEqual(status, 200, got)
        self.assertEqual(got["pages"]["plan"]["unread"], 1)


class UnreadSchemaTests(UnreadTestCase):
    def test_a_database_from_the_previous_step_reads_back_with_nothing_unread(self):
        self.stop()
        path = self.work / "before.sqlite3"
        conn = sqlite3.connect(str(path))
        for step in range(1, db.SCHEMA_VERSION):
            for statement in db._SCHEMA[step]:
                conn.execute(statement)
        conn.execute(
            "INSERT INTO comments (page, section, section_title, revision, parent, text,"
            " quote, actor, created_at, state) VALUES ('plan', 'risks', 'Risks', ?, NULL,"
            " 'Kept from before.', NULL, ?, '2026-01-02T03:04:05.000Z', 'pending')",
            (self.revision, json.dumps(ACTOR)),
        )
        conn.execute(
            "INSERT INTO comments (page, section, section_title, revision, parent, text,"
            " quote, actor, created_at, state) VALUES ('plan', 'risks', 'Risks', ?, 1,"
            " 'A reply from before.', NULL, ?, '2026-01-02T03:05:05.000Z', 'answered')",
            (self.revision, json.dumps({"kind": "agent", "handle": OWNER,
                                        "credential": OWNER})),
        )
        conn.execute(f"PRAGMA user_version = {db.SCHEMA_VERSION - 1}")
        conn.commit()
        conn.close()
        self.start(path, allowed_emails=f"{A} {B}")

        for email in (A, B):
            with self.subTest(reader=email):
                status, got = self.ask("GET", "/api/comments?page=plan",
                                       assertion=keys.assertion(email))
                self.assertEqual(status, 200, got)
                [thread] = got["threads"]
                self.assertEqual(thread["root"]["text"], "Kept from before.")
                self.assertEqual([reply["text"] for reply in thread["replies"]],
                                 ["A reply from before."])
                self.assertEqual(got["unread"], [])
        conn = sqlite3.connect(str(path))
        try:
            self.assertEqual(conn.execute("PRAGMA user_version").fetchone()[0],
                             db.SCHEMA_VERSION)
            # a's thread is seen up to its newest comment as the step ran.
            self.assertEqual(conn.execute(
                "SELECT reader, thread, comment FROM thread_views").fetchall(), [(A, 1, 2)])
        finally:
            conn.close()


if __name__ == "__main__":
    unittest.main()
