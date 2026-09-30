"""An agent claims a reader's comment before answering it: `lotuspod comments
claim|reply|release|fail`, the claim's expiry, the reply's idempotency key,
the reply's page revision, the `claimed`, `answered` and `failed` states, and
`lotuspod audit`.

serve runs on a thread with the test Access key trusted, as in
tests.test_agent_pull; the reader posts over its port and agents use the
commands.

Run from the repo root:

    python -m unittest tests.test_claims -v
"""

from __future__ import annotations

import json
import socket
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from lotuspod import db, machine  # noqa: E402
from tests.test_agent_pull import PLAN, READER, PullTestCase, run_cli  # noqa: E402


class ClaimTestCase(PullTestCase):
    """PullTestCase's site, with credentials `hermes` and `hermes-two` that
    may pull, claim and reply as hermes, `mute` that may pull and claim as
    hermes but not reply, and `resp` that may pull, claim and reply as the
    responder."""

    claim_sec: int | None = None

    def prepare(self) -> None:
        if self.claim_sec is not None:
            config = self.work / "config.ini"
            config.write_text(config.read_text(encoding="utf-8")
                              + f"\n[comments]\nclaim_sec = {self.claim_sec}\n",
                              encoding="utf-8")
        database = db.Database(self.db_path)
        self.creds = {}
        for name, handle, ops in (("hermes", "hermes", ["pull", "claim", "reply"]),
                                  ("hermes-two", "hermes", ["pull", "claim", "reply"]),
                                  ("mute", "hermes", ["pull", "claim"]),
                                  ("resp", "responder", ["pull", "claim", "reply"])):
            path = self.work / f"{name}.token"
            machine.create_credential(database, name, [handle], ops, path)
            self.creds[name] = path

    def act(self, name: str, *argv: str) -> tuple[int, dict]:
        """`lotuspod comments ARGV --json` as credential name: exit code and JSON."""
        rc, out, err = self.agent(*argv, "--json", credential=self.creds[name])
        try:
            return rc, json.loads(out)
        except ValueError:
            self.fail(out + err)

    def claim(self, name: str, comment_id: int) -> str:
        rc, claimed = self.act(name, "claim", str(comment_id))
        self.assertEqual(rc, 0, claimed)
        self.assertEqual(claimed["comment"], comment_id)
        return claimed["claimToken"]

    def send_reply(self, name: str, comment_id: int, token: str, key: str,
                   text: str = "An answer.", *extra: str) -> tuple[int, dict]:
        return self.act(name, "reply", str(comment_id), "--claim", token, "--key", key,
                        "--text", text, *extra)

    def replies(self, comment_id: int, page: str = "plan") -> list[dict]:
        for thread in self.threads(page):
            if thread["root"]["id"] == comment_id:
                return thread["replies"]
        self.fail(f"no thread {comment_id}")


class ExpiryTests(ClaimTestCase):
    claim_sec = 1

    def test_an_expired_claim_lapses_and_its_token_answers_nothing(self):
        self.pull("hermes")
        comment = self.comment("Is the heater enough?")
        first = self.claim("hermes", comment["id"])
        rc, refused = self.act("hermes-two", "claim", str(comment["id"]))
        self.assertEqual((rc, refused), (1, {"error": "claimed"}))
        self.assertEqual(self.row(comment["id"])["state"], "claimed")

        time.sleep(2)
        # Lapsed: routed again, and back in its handle's pull.
        self.assertEqual(self.row(comment["id"])["state"], "pending")
        self.assertIn(comment["id"], self.pulled_comments("hermes"))
        self.claim("hermes-two", comment["id"])
        rc, refused = self.send_reply("hermes", comment["id"], first, "late-1")
        self.assertEqual((rc, refused), (1, {"error": "not_claimed"}))
        self.assertEqual(self.replies(comment["id"]), [])
        self.assertEqual(self.row(comment["id"])["state"], "claimed")

    def test_a_reply_whose_claim_expires_while_it_arrives_is_refused(self):
        self.pull("hermes")
        comment = self.comment("Is the heater enough?")
        token = self.claim("hermes", comment["id"])
        body = json.dumps({"claimToken": token, "idempotencyKey": "slow-1",
                           "text": "Late."}).encode("utf-8")
        credential = machine.read_token(self.creds["hermes"])
        head = (f"POST /v1/comments/{comment['id']}/reply HTTP/1.1\r\nHost: localhost\r\n"
                f"Authorization: Bearer {credential}\r\nContent-Type: application/json\r\n"
                f"Content-Length: {len(body)}\r\nConnection: close\r\n\r\n").encode("ascii")
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
            sock.settimeout(15)
            sock.connect(str(self.socket_path))
            # The claim is current as the request starts, and over by its body.
            sock.sendall(head)
            time.sleep(2)
            sock.sendall(body)
            answer = b""
            while chunk := sock.recv(65536):
                answer += chunk
        status_line, _, rest = answer.partition(b"\r\n")
        self.assertIn(b" 409 ", status_line, answer)
        self.assertEqual(json.loads(rest.partition(b"\r\n\r\n")[2]), {"error": "not_claimed"})
        self.assertEqual(self.replies(comment["id"]), [])
        self.assertEqual(self.row(comment["id"])["state"], "pending")


class ReplyTests(ClaimTestCase):
    def test_a_retried_key_returns_the_stored_reply_and_a_new_key_is_refused(self):
        self.pull("hermes")
        comment = self.comment("Is the heater enough?")
        self.assertEqual(self.row(comment["id"])["state"], "pending")
        token = self.claim("hermes", comment["id"])
        self.assertEqual((self.row(comment["id"])["state"], self.row(comment["id"])["owner"]),
                         ("claimed", "hermes"))
        self.assertNotIn(comment["id"], self.pulled_comments("hermes"))

        rc, reply = self.send_reply("hermes", comment["id"], token, "op-1", "It is.")
        self.assertEqual(rc, 0, reply)
        self.assertEqual(reply["actor"],
                         {"kind": "agent", "handle": "hermes", "credential": "hermes"})
        self.assertEqual((reply["parent"], reply["text"], reply["revision"]),
                         (comment["id"], "It is.", ""))
        rc, again = self.send_reply("hermes", comment["id"], token, "op-1", "It is.")
        self.assertEqual((rc, again), (0, reply))
        self.assertEqual(self.replies(comment["id"]), [reply])
        self.assertEqual(self.row(comment["id"])["state"], "answered")

        rc, refused = self.send_reply("hermes", comment["id"], token, "op-2", "It is.")
        self.assertEqual((rc, refused), (1, {"error": "not_claimed"}))
        self.assertEqual(self.replies(comment["id"]), [reply])
        rc, refused = self.act("hermes", "claim", str(comment["id"]))
        self.assertEqual((rc, refused), (1, {"error": "settled"}))
        self.assertNotIn(comment["id"], self.pulled_comments("hermes"))

    def test_a_reply_names_the_current_revision_or_none(self):
        self.pull("hermes")
        comment = self.comment("Can you cut risk two?")
        token = self.claim("hermes", comment["id"])
        rc, refused = self.send_reply("hermes", comment["id"], token, "rev-1", "Cut.",
                                      "--revision", "000000000000")
        self.assertEqual((rc, refused), (1, {"error": "revision_mismatch"}))
        self.assertEqual(self.replies(comment["id"]), [])
        self.assertEqual(self.row(comment["id"])["state"], "claimed")

        text = self.work / "reply.txt"
        text.write_text("Cut, as asked.\n", encoding="utf-8")
        rc, reply = self.act("hermes", "reply", str(comment["id"]), "--claim", token,
                             "--key", "rev-1", "--text-file", str(text),
                             "--revision", self.revision())
        self.assertEqual(rc, 0, reply)
        self.assertEqual((reply["text"], reply["revision"]), ("Cut, as asked.\n", self.revision()))
        self.assertEqual(self.replies(comment["id"]), [reply])

    def test_a_revision_is_checked_as_the_reply_is_decided(self):
        self.pull("hermes")
        comment = self.comment("Can you cut risk two?")
        token = self.claim("hermes", comment["id"])
        before = self.revision()
        credential = machine.read_token(self.creds["hermes"])
        answers = []
        # Another writer holds the lock while the reply arrives.
        lock = sqlite3.connect(str(self.db_path), isolation_level=None, timeout=30)
        self.addCleanup(lock.close)
        lock.execute("BEGIN IMMEDIATE")
        sender = threading.Thread(target=lambda: answers.append(machine.request(
            self.socket_path, credential, "POST", f"/v1/comments/{comment['id']}/reply",
            {"claimToken": token, "idempotencyKey": "rev-1", "text": "Cut.",
             "revision": before})))
        sender.start()
        time.sleep(1)
        # The page is published again before the reply gets the lock.
        source = self.work / "plan.md"
        source.write_text(PLAN.replace("The pond may freeze.", "The pond will not freeze."),
                          encoding="utf-8")
        rc, _out, err = run_cli("publish", str(source), "--out-dir", str(self.out_dir),
                                "--local", "--owner", "hermes", "--credential", str(self.desk))
        self.assertEqual(rc, 0, err)
        self.assertNotEqual(self.revision(), before)
        lock.execute("COMMIT")
        sender.join(30)
        self.assertEqual(answers, [(409, {"error": "revision_mismatch"})])
        self.assertEqual(self.replies(comment["id"]), [])
        self.assertEqual(self.row(comment["id"])["state"], "claimed")

    def test_a_credential_without_reply_is_refused(self):
        self.pull("hermes")
        comment = self.comment("Is the heater enough?")
        token = self.claim("mute", comment["id"])
        rc, refused = self.send_reply("mute", comment["id"], token, "k-1")
        self.assertEqual((rc, refused), (1, {"error": "operation_not_allowed"}))
        mute = machine.read_token(self.creds["mute"])
        status, payload = machine.request(self.socket_path, mute, "POST",
                                          f"/v1/comments/{comment['id']}/reply",
                                          {"claimToken": token, "idempotencyKey": "k-1",
                                           "text": "Hi"})
        self.assertEqual((status, payload), (403, {"error": "operation_not_allowed"}))
        self.assertEqual(self.replies(comment["id"]), [])

    def test_a_claim_is_for_the_handle_the_comment_is_routed_to(self):
        self.pull("hermes")
        comment = self.comment("Is the heater enough?")
        rc, refused = self.act("resp", "claim", str(comment["id"]))
        self.assertEqual((rc, refused), (1, {"error": "not_routed"}))
        rc, refused = self.act("hermes", "claim", "999")
        self.assertEqual((rc, refused), (1, {"error": "unknown_comment"}))
        token = machine.read_token(self.creds["hermes"])
        status, payload = machine.request(self.socket_path, token, "GET",
                                          f"/v1/comments/{comment['id']}/claim")
        self.assertEqual((status, payload), (405, {"error": "method_not_allowed"}))


class SettleTests(ClaimTestCase):
    def test_release_routes_it_again_and_fail_leaves_it_failed(self):
        self.pull("hermes")
        released = self.comment("Is the heater enough?")
        token = self.claim("hermes", released["id"])
        rc, row = self.act("hermes-two", "release", str(released["id"]), "--claim", token)
        self.assertEqual((rc, row), (1, {"error": "not_claimed"}))
        rc, row = self.act("hermes", "release", str(released["id"]), "--claim", token)
        self.assertEqual(rc, 0, row)
        self.assertEqual((row["state"], row["owner"]), ("pending", "hermes"))
        self.assertEqual(self.row(released["id"])["state"], "pending")
        self.assertIn(released["id"], self.pulled_comments("hermes"))

        failed = self.comment("What does the source say?", section="goals")
        token = self.claim("hermes", failed["id"])
        rc, row = self.act("hermes", "fail", str(failed["id"]), "--claim", token,
                           "--reason", "source missing")
        self.assertEqual(rc, 0, row)
        shown = self.row(failed["id"])
        self.assertEqual((shown["state"], shown["owner"], shown["reason"]),
                         ("failed", "hermes", "source missing"))
        self.assertNotIn("reason", self.row(released["id"]))
        self.assertNotIn(failed["id"], self.pulled_comments("hermes"))
        self.assertNotIn(failed["id"], self.pulled_comments("responder"))
        rc, refused = self.act("hermes", "claim", str(failed["id"]))
        self.assertEqual((rc, refused), (1, {"error": "settled"}))

        other = self.comment("And the pump?")
        token = self.claim("hermes", other["id"])
        rc, refused = self.act("hermes", "fail", str(other["id"]), "--claim", token,
                               "--reason", "x" * 201)
        self.assertEqual((rc, refused), (1, {"error": "invalid_body"}))
        self.assertEqual(self.row(other["id"])["state"], "claimed")


class AuditTests(ClaimTestCase):
    def audit(self, *argv: str) -> list[dict]:
        rc, out, err = run_cli("audit", "--json", "--out-dir", str(self.out_dir), *argv)
        self.assertEqual(rc, 0, err)
        return json.loads(out)

    def test_every_claim_reply_release_and_failure_is_listed_oldest_first(self):
        self.pull("hermes")
        self.pull("responder")
        planned = self.comment("Is the heater enough?")
        loose = self.comment("Who reads this?", page="loose", section="one")

        token = self.claim("hermes", planned["id"])
        rc, _ = self.act("hermes", "release", str(planned["id"]), "--claim", token)
        self.assertEqual(rc, 0)
        token = self.claim("hermes-two", planned["id"])
        rc, _ = self.send_reply("hermes-two", planned["id"], token, "audit-1")
        self.assertEqual(rc, 0)
        token = self.claim("resp", loose["id"])
        rc, _ = self.act("resp", "fail", str(loose["id"]), "--claim", token,
                         "--reason", "source missing")
        self.assertEqual(rc, 0)
        # A retried reply and a refusal are not actions.
        self.send_reply("hermes-two", planned["id"], token, "audit-1")
        self.act("hermes", "claim", str(planned["id"]))

        rows = self.audit()
        self.assertEqual(
            [(row["action"], row["comment"], row["page"], row["credential"], row["handle"],
              row["key"]) for row in rows],
            [("claim", planned["id"], "plan", "hermes", "hermes", None),
             ("release", planned["id"], "plan", "hermes", "hermes", None),
             ("claim", planned["id"], "plan", "hermes-two", "hermes", None),
             ("reply", planned["id"], "plan", "hermes-two", "hermes", "audit-1"),
             ("claim", loose["id"], "loose", "resp", "responder", None),
             ("fail", loose["id"], "loose", "resp", "responder", None)],
        )
        self.assertEqual([row["at"] for row in rows], sorted(row["at"] for row in rows))
        self.assertEqual([row["action"] for row in self.audit("--page", "loose")],
                         ["claim", "fail"])
        self.assertEqual([row["action"] for row in self.audit("--page", "plan")],
                         ["claim", "release", "claim", "reply"])

        rc, out, err = run_cli("audit", "--page", "loose", "--out-dir", str(self.out_dir))
        self.assertEqual(rc, 0, err)
        self.assertEqual(len(out.splitlines()), 2)
        self.assertIn("credential resp", out)


class SchemaTests(unittest.TestCase):
    def test_a_version_three_database_keeps_its_rows(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / db.DEFAULT_NAME
            conn = sqlite3.connect(str(path))
            for step in (1, 2, 3):
                for statement in db._SCHEMA[step]:
                    conn.execute(statement)
            conn.execute(
                "INSERT INTO comments (page, section, section_title, revision, parent, text,"
                " quote, actor, created_at, state) VALUES ('plan', 'risks', 'Risks', 'r', NULL,"
                " 'Kept from before.', NULL, ?, '2026-01-02T03:04:05.000Z', 'pending')",
                (json.dumps(READER),),
            )
            conn.execute("PRAGMA user_version = 3")
            conn.commit()
            conn.close()
            database = db.Database(path)
            [thread] = database.threads("plan")
            self.assertEqual((thread["root"]["text"], thread["root"]["state"]),
                             ("Kept from before.", "pending"))
            self.assertEqual(database.audit(), [])
            conn = sqlite3.connect(str(path))
            try:
                self.assertEqual(conn.execute("PRAGMA user_version").fetchone()[0],
                                 db.SCHEMA_VERSION)
            finally:
                conn.close()


if __name__ == "__main__":
    unittest.main()
