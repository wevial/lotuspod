"""A thread is resolved and reopened, and each change is kept: by an agent
with `lotuspod comments resolve|reopen` on serve's socket, its audit rows,
who may, the database a version before, and the commands' help.

serve runs on a thread with the test Access key trusted, as in
tests.test_claims; the reader posts over its port and agents use the
commands.

Run from the repo root:

    python -m unittest tests.test_resolutions -v
"""

from __future__ import annotations

import json
import re
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from lotuspod import db, machine  # noqa: E402
from tests.test_agent_pull import READER, run_cli  # noqa: E402
from tests.test_claims import ClaimTestCase  # noqa: E402
from tests.test_cli_surface import run_lotuspod  # noqa: E402

STAMP = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$")


class ResolutionTestCase(ClaimTestCase):
    """ClaimTestCase's site, with credential `claude-reply` that may pull and
    reply as claude-3f9a2c."""

    def prepare(self) -> None:
        super().prepare()
        path = self.work / "claude-reply.token"
        machine.create_credential(db.Database(self.db_path), "claude-reply",
                                  ["claude-3f9a2c"], ["pull", "reply"], path)
        self.creds["claude-reply"] = path

    def shown(self, thread: int) -> dict:
        """The thread as the threads route on the socket shows it."""
        rc, out, err = self.agent("show", "plan", "--json")
        self.assertEqual(rc, 0, out + err)
        [found] = [found for found in json.loads(out)["threads"]
                   if found["root"]["id"] == thread]
        return found

    def audit(self) -> list[dict]:
        rc, out, err = run_cli("audit", "--json", "--out-dir", str(self.out_dir))
        self.assertEqual(rc, 0, err)
        return json.loads(out)

    def stored(self, thread: int) -> list[dict]:
        """Every change to the thread, oldest first, read from the database."""
        return db.Database(self.db_path).resolutions(thread)


class AgentResolutionTests(ResolutionTestCase):
    def test_the_owner_resolves_and_reopens_a_thread(self):
        self.pull("hermes")
        root = self.comment("Is the heater enough?")
        self.reply(root["id"], "And the pump?")
        hermes = {"kind": "agent", "handle": "hermes", "credential": "hermes"}

        rc, got = self.act("hermes", "resolve", str(root["id"]))
        self.assertEqual(rc, 0, got)
        self.assertEqual(set(got), {"thread", "resolution"})
        self.assertEqual(got["thread"], root["id"])
        resolved = got["resolution"]
        self.assertEqual((resolved["resolved"], resolved["actor"]), (True, hermes))
        self.assertRegex(resolved["at"], STAMP)
        self.assertEqual(self.shown(root["id"])["resolution"], resolved)
        self.assertEqual(self.threads()[0]["resolution"], resolved)
        [row] = self.audit()
        self.assertEqual((row["action"], row["comment"], row["page"], row["credential"],
                          row["handle"], row["key"]),
                         ("resolve", root["id"], "plan", "hermes", "hermes", None))
        # A resolution changes no comment's routing state.
        self.assertEqual(self.shown(root["id"])["root"]["state"], "pending")

        rc, got = self.act("hermes", "reopen", str(root["id"]))
        self.assertEqual(rc, 0, got)
        reopened = got["resolution"]
        self.assertEqual((reopened["resolved"], reopened["actor"]), (False, hermes))
        self.assertEqual(self.shown(root["id"])["resolution"], reopened)
        self.assertEqual([(row["action"], row["comment"], row["credential"])
                          for row in self.audit()],
                         [("resolve", root["id"], "hermes"), ("reopen", root["id"], "hermes")])
        self.assertEqual([change["resolved"] for change in self.stored(root["id"])],
                         [True, False])

    def test_a_change_that_changes_nothing_stores_nothing(self):
        root = self.comment("Is the heater enough?")
        rc, got = self.act("hermes", "reopen", str(root["id"]))
        self.assertEqual((rc, got), (0, {"thread": root["id"], "resolution": db.UNRESOLVED}))
        rc, first = self.act("hermes", "resolve", str(root["id"]))
        self.assertEqual(rc, 0, first)
        rc, again = self.act("hermes-two", "resolve", str(root["id"]))
        self.assertEqual((rc, again), (0, first))
        self.assertEqual(len(self.stored(root["id"])), 1)
        self.assertEqual([row["action"] for row in self.audit()], ["resolve"])

    def test_without_json_the_commands_print_who_and_when(self):
        root = self.comment("Is the heater enough?")
        rc, out, err = self.agent("resolve", str(root["id"]), credential=self.creds["hermes"])
        self.assertEqual(rc, 0, err)
        at = self.shown(root["id"])["resolution"]["at"]
        self.assertEqual(out, f"thread {root['id']} resolved by hermes at {at}\n")
        rc, out, err = self.agent("reopen", str(root["id"]), credential=self.creds["hermes"])
        self.assertEqual(rc, 0, err)
        at = self.shown(root["id"])["resolution"]["at"]
        self.assertEqual(out, f"thread {root['id']} reopened by hermes at {at}\n")

    def test_only_the_owner_or_the_routed_handle_with_reply_may(self):
        self.pull("hermes")
        plain = self.comment("Is the heater enough?")
        rc, got = self.act("claude-reply", "resolve", str(plain["id"]))
        self.assertEqual((rc, got), (1, {"error": "not_routed"}))
        rc, got = self.act("mute", "resolve", str(plain["id"]))
        self.assertEqual((rc, got), (1, {"error": "operation_not_allowed"}))
        rc, got = self.act("claude-reply", "reopen", str(plain["id"]))
        self.assertEqual((rc, got), (1, {"error": "not_routed"}))
        self.assertEqual(self.stored(plain["id"]), [])
        self.assertEqual(self.audit(), [])
        self.assertEqual(self.shown(plain["id"])["resolution"], db.UNRESOLVED)

        named = self.comment("@claude-3f9a2c is this right?")
        rc, got = self.act("claude-reply", "resolve", str(named["id"]))
        self.assertEqual(rc, 0, got)
        self.assertEqual(got["resolution"]["actor"],
                         {"kind": "agent", "handle": "claude-3f9a2c",
                          "credential": "claude-reply"})
        # The page's owner may resolve a thread routed elsewhere, as the owner.
        rc, got = self.act("hermes", "reopen", str(named["id"]))
        self.assertEqual(rc, 0, got)
        self.assertEqual(got["resolution"]["actor"]["handle"], "hermes")
        self.assertEqual([(row["action"], row["credential"], row["handle"])
                          for row in self.audit()],
                         [("resolve", "claude-reply", "claude-3f9a2c"),
                          ("reopen", "hermes", "hermes")])

    def test_only_a_threads_first_comment_names_it(self):
        root = self.comment("Is the heater enough?")
        reply = self.reply(root["id"], "And the pump?")
        for thread in (reply["id"], 999999):
            with self.subTest(thread=thread):
                rc, got = self.act("hermes", "resolve", str(thread))
                self.assertEqual((rc, got), (1, {"error": "unknown_thread"}))
        self.assertEqual(self.audit(), [])
        self.assertEqual(self.shown(root["id"])["resolution"], db.UNRESOLVED)


class SchemaTests(unittest.TestCase):
    def test_a_version_five_database_keeps_its_threads_unresolved(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / db.DEFAULT_NAME
            conn = sqlite3.connect(str(path))
            for step in range(1, 6):
                for statement in db._SCHEMA[step]:
                    conn.execute(statement)
            for parent, text in ((None, "Kept from before."), (1, "A reply from before.")):
                conn.execute(
                    "INSERT INTO comments (page, section, section_title, revision, parent,"
                    " text, quote, actor, created_at, state) VALUES ('plan', 'risks', 'Risks',"
                    " 'r', ?, ?, NULL, ?, '2026-01-02T03:04:05.000Z', 'pending')",
                    (parent, text, json.dumps(READER)),
                )
            columns = ", ".join(row[1] for row in conn.execute("PRAGMA table_info(comments)"))
            before = [tuple(row) for row in conn.execute(
                f"SELECT {columns} FROM comments ORDER BY id")]
            conn.execute("PRAGMA user_version = 5")
            conn.commit()
            conn.close()

            [thread] = db.Database(path).threads("plan")
            self.assertEqual((thread["root"]["text"], thread["root"]["state"]),
                             ("Kept from before.", "pending"))
            self.assertEqual([row["text"] for row in thread["replies"]],
                             ["A reply from before."])
            self.assertEqual(thread["resolution"],
                             {"resolved": False, "actor": None, "at": None})
            conn = sqlite3.connect(str(path))
            try:
                self.assertEqual(conn.execute("PRAGMA user_version").fetchone()[0],
                                 db.SCHEMA_VERSION)
                self.assertEqual(
                    [tuple(row) for row in conn.execute(
                        f"SELECT {columns} FROM comments ORDER BY id")], before)
                self.assertEqual(conn.execute("SELECT COUNT(*) FROM resolutions").fetchone()[0],
                                 0)
            finally:
                conn.close()


class HelpTests(unittest.TestCase):
    def test_comments_help_lists_resolve_and_reopen(self):
        proc = run_lotuspod("comments", "--help")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        choices = re.search(r"\{([a-z,-]+)\}", proc.stdout)
        self.assertIsNotNone(choices, proc.stdout)
        listed = choices.group(1).split(",")
        self.assertIn("resolve", listed)
        self.assertIn("reopen", listed)


if __name__ == "__main__":
    unittest.main()
