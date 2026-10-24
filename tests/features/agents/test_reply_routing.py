"""A reader's reply with no mention goes to the agent that last answered its
thread while that agent is listening, and to the responder otherwise; a
mention still overrides, and a thread's root routes as before.

serve runs on a thread with the test Access key trusted, as in
tests.features.agents.test_agent_pull; the reader posts over its port and agents use the
commands through serve's socket.

Run from the repo root:

    python -m unittest tests.features.agents.test_reply_routing -v
"""

from __future__ import annotations

import gc
import json
import sys
import time
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "src"))

from lotuspod.features.agents import machine, routing  # noqa: E402
from lotuspod.features.serve import api  # noqa: E402
from lotuspod.store import db  # noqa: E402
from tests.features.agents.test_agent_pull import PullTestCase  # noqa: E402


class ReplyRoutingTestCase(PullTestCase):
    """PullTestCase's site, with credentials `claude-a`, `claude-b` and `resp`
    that may pull, claim and reply as the handle of the same name (`resp` as
    the responder)."""

    def prepare(self) -> None:
        database = db.Database(self.db_path)
        self.creds = {}
        for name, handle in (("claude-a", "claude-a"), ("claude-b", "claude-b"),
                             ("resp", "responder")):
            path = self.work / f"{name}.token"
            machine.create_credential(database, name, [handle],
                                      ["pull", "claim", "reply"], path)
            self.creds[name] = path

    def act(self, name: str, *argv: str) -> tuple[int, dict]:
        rc, out, err = self.agent(*argv, "--json", credential=self.creds[name])
        try:
            return rc, json.loads(out)
        except ValueError:
            self.fail(out + err)

    def pulled_as(self, name: str, handle: str) -> list[int]:
        return [item["comment"]["id"] for item in self.pull(handle, self.creds[name])
                if item["kind"] == "comment"]

    def answer_as(self, name: str, comment_id: int) -> None:
        """name claims comment_id and replies to it through the socket."""
        rc, claimed = self.act(name, "claim", str(comment_id))
        self.assertEqual(rc, 0, claimed)
        rc, replied = self.act(name, "reply", str(comment_id), "--claim",
                               claimed["claimToken"], "--key", f"{name}-{comment_id}",
                               "--text", "An answer.")
        self.assertEqual(rc, 0, replied)

    def routed(self, comment_id: int) -> tuple[str, str]:
        row = self.row(comment_id)
        return row["owner"], row["state"]

    def move_clock(self, seconds: float) -> None:
        """Move the clock serve's port and socket route by, seconds ahead."""
        later = lambda: time.time() + seconds  # noqa: E731
        self.sockets.routes.clock = later
        # The port's routes are held by its handler alone.
        ports = [obj for obj in gc.get_objects()
                 if isinstance(obj, api.Api) and obj.database.path == self.db_path]
        self.assertEqual(len(ports), 1)
        ports[0].clock = later


class ReplyRoutingTests(ReplyRoutingTestCase):
    def thread_answered_by_a(self) -> dict:
        self.pull("claude-a", self.creds["claude-a"])
        root = self.comment("@claude-a Is the heater enough?")
        self.answer_as("claude-a", root["id"])
        return root

    def test_a_reply_goes_to_the_listening_agent_that_answered_the_thread(self):
        root = self.thread_answered_by_a()
        reply = self.reply(root["id"], "And for winter?")
        self.assertEqual((reply["owner"], reply["state"]), ("claude-a", "pending"))
        self.assertEqual(self.routed(reply["id"]), ("claude-a", "pending"))
        self.assertIn(reply["id"], self.pulled_as("claude-a", "claude-a"))
        self.assertNotIn(reply["id"], self.pulled_as("resp", "responder"))

    def test_a_reply_goes_to_the_responder_once_the_agent_stops_listening(self):
        root = self.thread_answered_by_a()
        self.move_clock(routing.DEFAULT_WINDOW + 60)
        reply = self.reply(root["id"], "And for winter?")
        self.assertEqual(reply["owner"], "responder")
        self.assertEqual(self.routed(reply["id"])[0], "responder")
        self.assertIn(reply["id"], self.pulled_as("resp", "responder"))
        self.assertNotIn(reply["id"], self.pulled_as("claude-a", "claude-a"))

    def test_a_reply_goes_to_the_latest_agent_to_answer(self):
        root = self.thread_answered_by_a()
        self.pull("claude-b", self.creds["claude-b"])
        asked = self.reply(root["id"], "@claude-b What do you think?")
        self.answer_as("claude-b", asked["id"])
        reply = self.reply(root["id"], "And for winter?")
        self.assertEqual(self.routed(reply["id"]), ("claude-b", "pending"))
        self.assertIn(reply["id"], self.pulled_as("claude-b", "claude-b"))
        self.assertNotIn(reply["id"], self.pulled_as("claude-a", "claude-a"))

    def test_a_reply_after_the_responder_s_answer_goes_to_the_responder(self):
        root = self.thread_answered_by_a()
        self.pull("responder", self.creds["resp"])
        asked = self.reply(root["id"], "@responder What do you think?")
        self.answer_as("resp", asked["id"])
        reply = self.reply(root["id"], "And for winter?")
        self.assertEqual(self.routed(reply["id"]), ("responder", "pending"))
        self.assertNotIn(reply["id"], self.pulled_as("claude-a", "claude-a"))

    def test_a_mention_still_overrides(self):
        root = self.thread_answered_by_a()
        to_b = self.reply(root["id"], "@claude-b Do you agree?")
        to_responder = self.reply(root["id"], "@responder Do you agree?")
        self.assertEqual(self.routed(to_b["id"])[0], "claude-b")
        self.assertEqual(self.routed(to_responder["id"])[0], "responder")

    def test_a_thread_s_root_goes_to_the_responder_as_before(self):
        self.pull("claude-a", self.creds["claude-a"])
        root = self.comment("Is the heater enough?")
        self.assertEqual(root["owner"], "responder")
        self.assertEqual(self.routed(root["id"])[0], "responder")
        self.assertNotIn(root["id"], self.pulled_as("claude-a", "claude-a"))

    def test_only_the_agent_it_is_routed_to_may_claim_the_reply(self):
        root = self.thread_answered_by_a()
        reply = self.reply(root["id"], "And for winter?")
        rc, refused = self.act("resp", "claim", str(reply["id"]))
        self.assertEqual((rc, refused), (1, {"error": "not_routed"}))
        rc, claimed = self.act("claude-a", "claim", str(reply["id"]))
        self.assertEqual(rc, 0, claimed)
        self.assertEqual((claimed["comment"], claimed["handle"]), (reply["id"], "claude-a"))


if __name__ == "__main__":
    unittest.main()
