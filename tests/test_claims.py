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

import hashlib
import json
import secrets
import socket
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from lotuspod import db, machine, media  # noqa: E402
from tests.test_agent_pull import (  # noqa: E402
    CHART, FISH, MEDIA_FIXTURES, PLAN, READER, PullTestCase, run_cli,
)

FROG = MEDIA_FIXTURES / "frog-140x100.gif"
LILY = MEDIA_FIXTURES / "lily-lossy-240x160.webp"
POND = MEDIA_FIXTURES / "pond-progressive-300x200.jpg"
LOGO = MEDIA_FIXTURES / "logo.svg"


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


class ModelTests(ClaimTestCase):
    """A reply may name the model that wrote it."""

    def socket_reply(self, comment_id: int, token: str, body: dict) -> tuple[int, dict]:
        credential = machine.read_token(self.creds["hermes"])
        return machine.request(self.socket_path, credential, "POST",
                               f"/v1/comments/{comment_id}/reply",
                               {"claimToken": token, **body})

    def test_a_reply_through_the_cli_carries_its_model_everywhere_it_is_read(self):
        self.pull("hermes")
        comment = self.comment("Is the heater enough?")
        token = self.claim("hermes", comment["id"])
        rc, reply = self.send_reply("hermes", comment["id"], token, "model-1", "It is.",
                                    "--model", "Claude Opus 5.5")
        self.assertEqual(rc, 0, reply)
        self.assertEqual(reply["model"], "Claude Opus 5.5")
        rc, shown = self.act("hermes", "show", "plan")
        self.assertEqual(rc, 0, shown)
        [thread] = shown["threads"]
        [row] = thread["replies"]
        self.assertEqual((row["id"], row["model"]), (reply["id"], "Claude Opus 5.5"))
        [row] = self.replies(comment["id"])
        self.assertEqual((row["id"], row["model"]), (reply["id"], "Claude Opus 5.5"))

    def test_a_reply_without_a_model_has_no_model_key(self):
        self.pull("hermes")
        comment = self.comment("Is the heater enough?")
        token = self.claim("hermes", comment["id"])
        rc, reply = self.send_reply("hermes", comment["id"], token, "model-1", "It is.")
        self.assertEqual(rc, 0, reply)
        self.assertNotIn("model", reply)
        credential = machine.read_token(self.creds["hermes"])
        status, payload = machine.request(self.socket_path, credential, "GET",
                                          "/v1/threads?page=plan")
        self.assertEqual(status, 200, payload)
        [thread] = payload["threads"]
        [row] = thread["replies"]
        self.assertEqual(row["id"], reply["id"])
        self.assertNotIn("model", row)
        [row] = self.replies(comment["id"])
        self.assertNotIn("model", row)
        self.assertNotIn("model", self.row(comment["id"]))

    def test_a_model_that_is_not_1_to_40_printable_characters_is_refused(self):
        self.pull("hermes")
        comment = self.comment("Is the heater enough?")
        token = self.claim("hermes", comment["id"])
        for number, model in enumerate(("", "x" * 41, "Opus\n", " Opus", "Opus ", 5, None)):
            with self.subTest(model=model):
                status, payload = self.socket_reply(comment["id"], token, {
                    "idempotencyKey": f"bad-{number}", "text": "It is.", "model": model})
                self.assertEqual((status, payload), (400, {"error": "invalid_body"}))
                self.assertEqual(self.row(comment["id"])["state"], "claimed")
                self.assertEqual(self.replies(comment["id"]), [])
        status, reply = self.socket_reply(comment["id"], token, {
            "idempotencyKey": "good", "text": "It is.", "model": "y" * 40})
        self.assertEqual(status, 200, reply)
        self.assertEqual(reply["model"], "y" * 40)
        self.assertEqual(self.replies(comment["id"]), [reply])

    def test_a_retried_key_returns_the_model_first_stored(self):
        self.pull("hermes")
        comment = self.comment("Is the heater enough?")
        token = self.claim("hermes", comment["id"])
        status, reply = self.socket_reply(comment["id"], token, {
            "idempotencyKey": "K", "text": "It is.", "model": "gpt-6-astra"})
        self.assertEqual(status, 200, reply)
        status, again = self.socket_reply(comment["id"], token, {
            "idempotencyKey": "K", "text": "It is.", "model": "other"})
        self.assertEqual((status, again), (200, reply))
        self.assertEqual(again["model"], "gpt-6-astra")
        self.assertEqual(self.replies(comment["id"]), [reply])


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


class TokenTests(ClaimTestCase):
    """A claim token never starts with "-", so `--claim TOKEN` parses."""

    def dashed(self) -> mock._patch:
        """token_urlsafe, stubbed to start every token it makes with "-"."""
        real = secrets.token_urlsafe
        return mock.patch.object(machine.secrets, "token_urlsafe",
                                 lambda nbytes=None: "-" + real(nbytes)[1:])

    def test_a_token_that_would_start_with_a_dash_does_not(self):
        self.pull("hermes")
        comment = self.comment("Is the heater enough?")
        with self.dashed():
            token = self.claim("hermes", comment["id"])
        self.assertFalse(token.startswith("-"), token)
        self.assertEqual(len(token), len(secrets.token_urlsafe(machine.CLAIM_BYTES)))

    def test_a_reply_parses_such_a_token_after_dash_dash_claim(self):
        self.pull("hermes")
        comment = self.comment("Is the heater enough?")
        with self.dashed():
            token = self.claim("hermes", comment["id"])
        rc, reply = self.send_reply("hermes", comment["id"], token, "dash-1", "It is.")
        self.assertEqual(rc, 0, reply)
        self.assertEqual(self.replies(comment["id"]), [reply])
        self.assertEqual(self.row(comment["id"])["state"], "answered")

    def test_no_token_starts_with_a_dash(self):
        self.pull("hermes")
        comment = self.comment("Is the heater enough?")
        # Each claim of a credential's own current claim renews it with a new token.
        tokens = [self.claim("hermes", comment["id"]) for _ in range(2000)]
        self.assertEqual(len(set(tokens)), 2000)
        self.assertEqual([token for token in tokens if token.startswith("-")], [])


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


class FollowUpTests(ClaimTestCase):
    """`lotuspod comments follow-up`: an agent adds to a thread it answered."""

    def answered(self, name: str = "hermes", page: str = "plan",
                 section: str = "risks") -> tuple[dict, dict]:
        """A reader's comment name has claimed and answered, and the reply."""
        comment = self.comment("Is the heater enough?", page=page, section=section)
        token = self.claim(name, comment["id"])
        rc, reply = self.send_reply(name, comment["id"], token, f"{name}-{comment['id']}-1",
                                    "I'm asking the author; I'll post their answer here.")
        self.assertEqual(rc, 0, reply)
        return comment, reply

    def follow_up(self, name: str, thread: int, key: str,
                  text: str = "The author says it is.", *extra: str) -> tuple[int, dict]:
        return self.act(name, "follow-up", str(thread), "--key", key, "--text", text, *extra)

    def socket_follow_up(self, name: str, thread: int, body: dict) -> tuple[int, dict]:
        token = machine.read_token(self.creds[name])
        return machine.request(self.socket_path, token, "POST",
                               f"/v1/threads/{thread}/follow-up", body)

    def thread_of(self, root: int, page: str = "plan") -> dict:
        for thread in self.threads(page):
            if thread["root"]["id"] == root:
                return thread
        self.fail(f"no thread {root}")

    def test_an_answered_thread_takes_a_follow_up_and_stays_answered(self):
        self.pull("hermes")
        comment, reply = self.answered()
        # The comment is settled: no second claim, so no second reply.
        rc, refused = self.act("hermes", "claim", str(comment["id"]))
        self.assertEqual((rc, refused), (1, {"error": "settled"}))

        rc, follow = self.follow_up("hermes", comment["id"], "hermes-follow-1")
        self.assertEqual(rc, 0, follow)
        self.assertEqual(follow["actor"],
                         {"kind": "agent", "handle": "hermes", "credential": "hermes"})
        self.assertEqual((follow["parent"], follow["text"], follow["revision"]),
                         (comment["id"], "The author says it is.", ""))
        thread = self.thread_of(comment["id"])
        self.assertEqual([row["id"] for row in (thread["root"], *thread["replies"])],
                         [comment["id"], reply["id"], follow["id"]])
        self.assertEqual(thread["replies"][1], follow)
        self.assertEqual(self.row(comment["id"])["state"], "answered")
        self.assertEqual(self.row(comment["id"])["owner"], "hermes")
        self.assertNotIn(comment["id"], self.pulled_comments("hermes"))
        rc, refused = self.act("hermes", "claim", str(comment["id"]))
        self.assertEqual((rc, refused), (1, {"error": "settled"}))

        rc, out, err = self.agent("follow-up", str(comment["id"]), "--key", "hermes-follow-1",
                                  "--text", "The author says it is.",
                                  credential=self.creds["hermes"])
        self.assertEqual(rc, 0, err)
        self.assertEqual(out.strip(),
                         f"reply {follow['id']} stored in the thread of comment {comment['id']}")

    def test_the_same_key_twice_stores_one_follow_up(self):
        self.pull("hermes")
        comment, reply = self.answered()
        text = self.work / "follow.md"
        text.write_text("The author says it is.\n", encoding="utf-8")
        rc, first = self.act("hermes", "follow-up", str(comment["id"]), "--key", "f-1",
                             "--text-file", str(text))
        self.assertEqual(rc, 0, first)
        rc, again = self.act("hermes", "follow-up", str(comment["id"]), "--key", "f-1",
                             "--text-file", str(text))
        self.assertEqual((rc, again), (0, first))
        self.assertEqual(self.replies(comment["id"]), [reply, first])
        # Another credential of the same handle may add its own.
        rc, other = self.follow_up("hermes-two", comment["id"], "f-1", "And one more.")
        self.assertEqual(rc, 0, other)
        self.assertEqual(self.replies(comment["id"]), [reply, first, other])

    def test_a_credential_of_neither_the_owner_nor_the_routed_handle_is_refused(self):
        self.pull("hermes")
        comment, reply = self.answered()
        rc, refused = self.follow_up("resp", comment["id"], "resp-1")
        self.assertEqual((rc, refused), (1, {"error": "not_routed"}))
        status, payload = self.socket_follow_up("resp", comment["id"],
                                                {"idempotencyKey": "resp-2", "text": "Hi"})
        self.assertEqual((status, payload), (403, {"error": "not_routed"}))
        rc, refused = self.follow_up("mute", comment["id"], "mute-1")
        self.assertEqual((rc, refused), (1, {"error": "operation_not_allowed"}))
        rc, refused = self.follow_up("hermes", reply["id"], "on-a-reply")
        self.assertEqual((rc, refused), (1, {"error": "unknown_thread"}))
        rc, refused = self.follow_up("hermes", comment["id"], "rev-1", "Cut.",
                                     "--revision", "000000000000")
        self.assertEqual((rc, refused), (1, {"error": "revision_mismatch"}))
        self.assertEqual(self.replies(comment["id"]), [reply])
        self.assertEqual(self.row(comment["id"])["state"], "answered")

        # On a page with no owner, the handle that answered the thread may.
        self.pull("responder")
        loose, answer = self.answered("resp", page="loose", section="one")
        rc, follow = self.follow_up("resp", loose["id"], "resp-3")
        self.assertEqual(rc, 0, follow)
        self.assertEqual(follow["actor"]["handle"], "responder")
        self.assertEqual(self.replies(loose["id"], page="loose"), [answer, follow])

    def test_a_resolved_thread_is_reopened_only_when_asked(self):
        self.pull("hermes")
        comment, reply = self.answered()
        status, got = self.reader("POST", "/api/comments",
                                  {"page": "plan", "thread": comment["id"], "resolved": True})
        self.assertEqual(status, 200, got)
        resolved = got["resolution"]

        rc, quiet = self.follow_up("hermes", comment["id"], "quiet-1")
        self.assertEqual(rc, 0, quiet)
        thread = self.thread_of(comment["id"])
        self.assertEqual(thread["resolution"], resolved)
        self.assertEqual(thread["replies"], [reply, quiet])

        status, loud = self.socket_follow_up("hermes", comment["id"], {
            "idempotencyKey": "loud-1", "text": "Reopening: the author changed their mind.",
            "reopen": True})
        self.assertEqual(status, 200, loud)
        thread = self.thread_of(comment["id"])
        self.assertEqual(thread["replies"], [reply, quiet, loud])
        self.assertFalse(thread["resolution"]["resolved"])
        self.assertEqual(thread["resolution"]["actor"],
                         {"kind": "agent", "handle": "hermes", "credential": "hermes"})
        self.assertEqual(self.row(comment["id"])["state"], "answered")

        status, refused = self.socket_follow_up("hermes", comment["id"], {
            "idempotencyKey": "bad-1", "text": "x", "reopen": "yes"})
        self.assertEqual((status, refused), (400, {"error": "invalid_body"}))
        self.assertEqual(len(self.replies(comment["id"])), 3)

    def test_a_follow_up_is_one_audit_row(self):
        self.pull("hermes")
        comment, _reply = self.answered()
        self.follow_up("hermes-two", comment["id"], "audit-f-1")
        # A retried key and a refusal are not actions.
        self.follow_up("hermes-two", comment["id"], "audit-f-1")
        self.follow_up("resp", comment["id"], "audit-f-2")
        rc, out, err = run_cli("audit", "--json", "--out-dir", str(self.out_dir))
        self.assertEqual(rc, 0, err)
        rows = [(row["action"], row["comment"], row["page"], row["credential"], row["handle"],
                 row["key"]) for row in json.loads(out)]
        self.assertEqual(rows[-1], ("follow-up", comment["id"], "plan", "hermes-two", "hermes",
                                    "audit-f-1"))
        self.assertEqual([row[0] for row in rows], ["claim", "reply", "follow-up"])


class ImageTestCase(ClaimTestCase):
    """An agent's reply or follow-up attaches images: `--image PATH`, each
    uploaded to POST /v1/media and named in the message."""

    def stored(self) -> set[str]:
        """The files in the media directory beside the artifacts directory."""
        directory = media.media_dir(self.out_dir)
        return {path.name for path in directory.iterdir()} if directory.is_dir() else set()

    def socket(self, name: str, method: str, target: str, body: object = None,
               content_type: str | None = None) -> tuple[int, dict]:
        return machine.request(self.socket_path, machine.read_token(self.creds[name]), method,
                               target, body, content_type)

    def expect_image(self, image: dict, fixture: Path, size: tuple[int, int]) -> None:
        name = hashlib.sha256(fixture.read_bytes()).hexdigest() + fixture.suffix
        self.assertEqual(image, {"name": name, "url": f"/media/{name}",
                                 "width": size[0], "height": size[1]})
        self.assertEqual((media.media_dir(self.out_dir) / name).read_bytes(),
                         fixture.read_bytes())


class ImageReplyTests(ImageTestCase):
    def test_a_reply_through_the_cli_carries_its_images_everywhere_it_is_read(self):
        self.pull("hermes")
        comment = self.comment("Is the heater enough?")
        token = self.claim("hermes", comment["id"])
        rc, reply = self.send_reply("hermes", comment["id"], token, "image-1", "See it.",
                                    "--image", str(CHART), "--image", str(FISH))
        self.assertEqual(rc, 0, reply)
        self.assertEqual(len(reply["images"]), 2)
        self.expect_image(reply["images"][0], CHART, (1600, 600))
        self.expect_image(reply["images"][1], FISH, (320, 240))
        # The reader's route: the same images, with no path.
        [row] = self.replies(comment["id"])
        self.assertEqual((row["id"], row["text"], row["images"]),
                         (reply["id"], "See it.", reply["images"]))
        # An agent's: each with its file in the media directory.
        rc, shown = self.act("hermes", "show", "plan")
        self.assertEqual(rc, 0, shown)
        [thread] = shown["threads"]
        [row] = thread["replies"]
        self.assertEqual([{key: image[key] for key in ("name", "url", "width", "height")}
                          for image in row["images"]], reply["images"])
        for image in row["images"]:
            self.assertEqual(Path(image["path"]),
                             media.media_dir(self.out_dir) / image["name"])

    def test_a_follow_up_through_the_cli_carries_its_image(self):
        self.pull("hermes")
        comment = self.comment("Is the heater enough?")
        token = self.claim("hermes", comment["id"])
        rc, reply = self.send_reply("hermes", comment["id"], token, "image-1", "I'll look.")
        self.assertEqual(rc, 0, reply)
        self.assertEqual(reply["images"], [])
        rc, follow = self.act("hermes", "follow-up", str(comment["id"]), "--key", "image-2",
                              "--text", "And this.", "--image", str(FROG))
        self.assertEqual(rc, 0, follow)
        [image] = follow["images"]
        self.expect_image(image, FROG, (140, 100))
        self.assertEqual(self.replies(comment["id"]), [reply, follow])

    def test_a_retried_key_answers_the_reply_first_stored_with_its_images(self):
        self.pull("hermes")
        comment = self.comment("Is the heater enough?")
        token = self.claim("hermes", comment["id"])
        rc, reply = self.send_reply("hermes", comment["id"], token, "K", "See it.",
                                    "--image", str(CHART))
        self.assertEqual(rc, 0, reply)
        rc, again = self.send_reply("hermes", comment["id"], token, "K", "See it.",
                                    "--image", str(FISH), "--image", str(FROG))
        self.assertEqual((rc, again), (0, reply))
        [image] = again["images"]
        self.expect_image(image, CHART, (1600, 600))
        self.assertEqual(self.replies(comment["id"]), [reply])

    def test_a_retried_key_answers_its_message_though_its_image_has_left_the_store(self):
        self.pull("hermes")
        comment = self.comment("Is the heater enough?")
        token = self.claim("hermes", comment["id"])
        status, uploaded = self.socket("hermes", "POST", machine.MEDIA, CHART.read_bytes(),
                                       "image/png")
        self.assertEqual(status, 200, uploaded)
        reply_body = {"claimToken": token, "idempotencyKey": "gone-1", "text": "See it.",
                      "images": [uploaded["name"]]}
        follow_body = {"idempotencyKey": "gone-2", "text": "And again.",
                       "images": [uploaded["name"]]}
        sent = []
        for target, body in ((f"/v1/comments/{comment['id']}/reply", reply_body),
                             (f"/v1/threads/{comment['id']}/follow-up", follow_body)):
            status, row = self.socket("hermes", "POST", target, body)
            self.assertEqual(status, 200, row)
            sent.append((target, body, row))
        (media.media_dir(self.out_dir) / uploaded["name"]).unlink()
        for target, body, row in sent:
            with self.subTest(target=target):
                self.assertEqual(self.socket("hermes", "POST", target, body), (200, row))
        self.assertEqual(self.replies(comment["id"]), [row for _t, _b, row in sent])
        # A new key naming it is refused, with nothing stored.
        status, refused = self.socket("hermes", "POST", f"/v1/threads/{comment['id']}/follow-up",
                                      {**follow_body, "idempotencyKey": "gone-3"})
        self.assertEqual((status, refused), (400, {"error": "unknown_image"}))
        self.assertEqual(len(self.replies(comment["id"])), 2)

    def test_too_many_images_or_an_unreadable_file_uploads_nothing(self):
        self.pull("hermes")
        comment = self.comment("Is the heater enough?")
        token = self.claim("hermes", comment["id"])
        for key, paths, error in (
                ("five", (CHART, FISH, FROG, LILY, POND), "too_many_images"),
                ("missing", (FISH, self.work / "no-such.png"), "unreadable_image")):
            with self.subTest(key=key):
                argv = [arg for path in paths for arg in ("--image", str(path))]
                rc, refused = self.send_reply("hermes", comment["id"], token, key, "See it.",
                                              *argv)
                self.assertEqual((rc, refused), (1, {"error": error}))
                self.assertEqual(self.stored(), set())
                self.assertEqual(self.replies(comment["id"]), [])
                self.assertEqual(self.row(comment["id"])["state"], "claimed")

    def test_a_message_naming_an_image_not_in_the_store_is_refused(self):
        self.pull("hermes")
        comment = self.comment("Is the heater enough?")
        token = self.claim("hermes", comment["id"])
        absent = hashlib.sha256(b"never uploaded").hexdigest() + ".png"
        status, refused = self.socket("hermes", "POST", f"/v1/comments/{comment['id']}/reply",
                                      {"claimToken": token, "idempotencyKey": "absent",
                                       "text": "See it.", "images": [absent]})
        self.assertEqual((status, refused), (400, {"error": "unknown_image"}))
        self.assertEqual(self.replies(comment["id"]), [])
        self.assertEqual(self.row(comment["id"])["state"], "claimed")
        status, uploaded = self.socket("hermes", "POST", machine.MEDIA, FISH.read_bytes(),
                                       "image/jpeg")
        self.assertEqual(status, 200, uploaded)
        # Not a list of 1 to four distinct stored names.
        for images in ([], [uploaded["name"]] * 2, "x.png", [uploaded["name"], "fish.jpg"],
                       [uploaded["name"], *(f"{n:064x}.png" for n in range(4))]):
            with self.subTest(images=images):
                status, refused = self.socket(
                    "hermes", "POST", f"/v1/comments/{comment['id']}/reply",
                    {"claimToken": token, "idempotencyKey": "bad", "text": "See it.",
                     "images": images})
                self.assertEqual((status, refused), (400, {"error": "invalid_body"}))
        self.assertEqual(self.replies(comment["id"]), [])
        # A reply of images alone is still refused: its text is required.
        status, refused = self.socket("hermes", "POST", f"/v1/comments/{comment['id']}/reply",
                                      {"claimToken": token, "idempotencyKey": "bare",
                                       "text": "", "images": [uploaded["name"]]})
        self.assertEqual((status, refused), (400, {"error": "invalid_body"}))
        self.assertEqual(self.replies(comment["id"]), [])

    def test_the_media_route_needs_reply_and_an_image_type(self):
        status, refused = self.socket("mute", "POST", machine.MEDIA, FISH.read_bytes(),
                                      "image/jpeg")
        self.assertEqual((status, refused), (403, {"error": "operation_not_allowed"}))
        self.assertEqual(self.stored(), set())
        for content_type in ("text/plain", "image/svg+xml"):
            with self.subTest(content_type=content_type):
                status, refused = self.socket("hermes", "POST", machine.MEDIA,
                                              FISH.read_bytes(), content_type)
                self.assertEqual((status, refused), (415, {"error": "unsupported_media_type"}))
        status, refused = self.socket("hermes", "GET", machine.MEDIA)
        self.assertEqual((status, refused), (405, {"error": "method_not_allowed"}))
        self.assertEqual(self.stored(), set())
        status, uploaded = self.socket("hermes", "POST", machine.MEDIA, FROG.read_bytes(),
                                       "image/gif")
        self.assertEqual(status, 200, uploaded)
        self.expect_image(uploaded, FROG, (140, 100))


class ImageRefusalTests(ImageTestCase):
    """A configured [media] max_image_bytes of 5000: the chart (7557 bytes)
    is over it, the fish (4868 bytes) within it."""

    cap = 5000

    def prepare(self) -> None:
        super().prepare()
        config = self.work / "config.ini"
        config.write_text(config.read_text(encoding="utf-8")
                          + f"\n[media]\nmax_image_bytes = {self.cap}\n", encoding="utf-8")

    def test_an_image_refused_by_type_shape_or_size_stores_nothing(self):
        self.assertGreater(CHART.stat().st_size, self.cap)
        short = self.work / "short.png"
        short.write_bytes(CHART.read_bytes()[:2000])
        self.pull("hermes")
        comment = self.comment("Is the heater enough?")
        token = self.claim("hermes", comment["id"])
        for path, error in ((LOGO, "unsupported_media_type"), (short, "invalid_image"),
                            (CHART, "body_too_large")):
            with self.subTest(path=path.name):
                rc, refused = self.send_reply("hermes", comment["id"], token, path.name,
                                              "See it.", "--image", str(path))
                self.assertEqual((rc, refused), (1, {"error": error}))
                self.assertEqual(self.stored(), set())
                self.assertEqual(self.replies(comment["id"]), [])
                self.assertEqual(self.row(comment["id"])["state"], "claimed")
        # Within the cap, the same reply is stored.
        rc, reply = self.send_reply("hermes", comment["id"], token, "fish", "See it.",
                                    "--image", str(FISH))
        self.assertEqual(rc, 0, reply)
        self.expect_image(reply["images"][0], FISH, (320, 240))


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
