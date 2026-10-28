"""Emoji reactions on comments: a reader's through POST /api/comments, an
agent's through `lotuspod comments react` on serve's socket, and `reactions`
on every comment of both threads reads, over the real servers. A reaction
is never a comment: it routes nothing, is no reply and makes nothing unread.

Run from the repo root:

    python -m unittest tests.features.comments.test_reactions -v
"""

from __future__ import annotations

import io
import json
import sqlite3
import sys
import unittest
from contextlib import redirect_stderr, redirect_stdout
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "src"))

from lotuspod import cli  # noqa: E402
from lotuspod.features.agents import machine  # noqa: E402
from lotuspod.store import db  # noqa: E402
from tests import access_keys as keys  # noqa: E402
from tests.features.serve.test_api import ACTOR, ApiTestCase, run_cli  # noqa: E402
from tests.test_unread import A, B, OWNER, UnreadTestCase  # noqa: E402

THUMBS = "\U0001F44D"
HEART = "❤️"
EYES = "\U0001F440"
# The schema step before the one that keeps reactions.
BEFORE_REACTIONS = 18


class ReactionsTestCase(UnreadTestCase):
    """UnreadTestCase's site with the maintainer's thread on `plan`, which
    names hermes, and hermes's claimed reply to it."""

    def setUp(self) -> None:
        super().setUp()
        self.hermes("pull", "--owner", OWNER)
        self.root = self.open_thread(A, "@hermes Is the heater enough?")
        self.reply_row = self.answer(self.root, "It is, down to minus ten.")

    def react(self, email: str, emoji: str, reacted: bool = True, comment: int | None = None,
              page: str = "plan", **extra) -> tuple[int, dict]:
        body = {"page": page, "comment": self.reply_row["id"] if comment is None else comment,
                "emoji": emoji, "reacted": reacted, **extra}
        return self.ask("POST", "/api/comments", body, assertion=keys.assertion(email))

    def reacted(self, email: str, emoji: str, reacted: bool = True,
                comment: int | None = None) -> list[dict]:
        status, got = self.react(email, emoji, reacted, comment)
        self.assertEqual(status, 200, got)
        self.assertEqual(got["comment"], self.reply_row["id"] if comment is None else comment)
        return got["reactions"]

    def read(self, email: str = A) -> dict:
        status, got = self.ask("GET", "/api/comments?page=plan", assertion=keys.assertion(email))
        self.assertEqual(status, 200, got)
        return got

    def rows(self, email: str = A) -> dict[int, dict]:
        """Every comment of the reader's read of `plan`, by id."""
        return {row["id"]: row for thread in self.read(email)["threads"]
                for row in (thread["root"], *thread["replies"])}

    def reactions(self, email: str = A, comment: int | None = None) -> list[dict]:
        return self.rows(email)[self.reply_row["id"] if comment is None else comment]["reactions"]

    def agent(self, token: Path, *argv: str) -> tuple[int, dict]:
        """(exit code, printed JSON) of `lotuspod comments ARGV --json` with token."""
        out, err = io.StringIO(), io.StringIO()
        with redirect_stdout(out), redirect_stderr(err):
            rc = cli.main(["comments", *argv, "--json", "--socket", str(self.socket_path),
                           "--credential", str(token)])
        return rc, json.loads(out.getvalue())

    def stored(self) -> int:
        with db.Database(self.db_path)._connect() as conn:
            return conn.execute("SELECT COUNT(*) FROM reactions").fetchone()[0]


class ReaderReactionTests(ReactionsTestCase):
    def test_readers_reactions_are_grouped_by_emoji_with_who_and_whether_mine(self):
        self.assertEqual(self.react(A, THUMBS), (200, {"comment": self.reply_row["id"], "reactions": [
            {"emoji": THUMBS, "count": 1, "mine": True, "by": ["maintainer"]}]}))
        self.reacted(B, THUMBS)
        self.reacted(B, HEART)
        rows = self.rows(A)
        self.assertEqual(rows[self.reply_row["id"]]["reactions"], [
            {"emoji": THUMBS, "count": 2, "mine": True, "by": ["maintainer", "heron"]},
            {"emoji": HEART, "count": 1, "mine": False, "by": ["heron"]}])
        self.assertEqual(rows[self.root["id"]]["reactions"], [])
        self.assertEqual(self.reactions(B)[0], {"emoji": THUMBS, "count": 2, "mine": True,
                                                "by": ["maintainer", "heron"]})
        self.assertNotIn("example.com", json.dumps(self.read(A)["threads"]))

    def test_a_reader_whose_address_starts_with_agent_is_named_as_a_reader(self):
        reader = "agent:hermes@example.com"
        self.stop()
        self.start(allowed_emails=f"{A} {B} {reader}")
        shown = [{"emoji": EYES, "count": 1, "mine": True, "by": ["agent:hermes"]}]
        self.assertEqual(self.reacted(reader, EYES), shown)
        self.assertEqual(self.reactions(reader), shown)
        self.assertEqual(self.reactions(A), [{**shown[0], "mine": False}])

    def test_adding_twice_stores_one_and_removing_is_a_no_op_when_absent(self):
        self.reacted(A, THUMBS)
        self.reacted(B, THUMBS)
        self.reacted(B, HEART)
        self.assertEqual(self.reacted(A, THUMBS)[0]["count"], 2)
        for _ in range(2):
            self.assertEqual(self.reacted(A, THUMBS, reacted=False), [
                {"emoji": THUMBS, "count": 1, "mine": False, "by": ["heron"]},
                {"emoji": HEART, "count": 1, "mine": False, "by": ["heron"]}])
        self.reacted(B, HEART, reacted=False)
        self.assertEqual([entry["emoji"] for entry in self.reactions(A)], [THUMBS])

    def test_a_refused_reaction_stores_nothing(self):
        self.reacted(B, HEART)
        before = self.reactions(A)
        elsewhere = self.open_thread(A, "On the other page.", page="other", section="page")

        def refused(answer: tuple[int, dict], status: int, error: str) -> None:
            self.assertEqual(answer, (status, {"error": error}))
            self.assertEqual(self.reactions(A), before)

        for emoji in ("x", ":+1:", THUMBS + THUMBS, ""):
            with self.subTest(emoji=emoji):
                refused(self.react(A, emoji), 400, "invalid_body")
        refused(self.react(A, THUMBS, reacted="yes"), 400, "invalid_body")
        refused(self.react(A, THUMBS, text="Agreed."), 400, "invalid_body")
        refused(self.react(A, THUMBS, comment=elsewhere["id"]), 404, "unknown_comment")
        refused(self.react(A, THUMBS, comment=999999), 404, "unknown_comment")
        refused(self.react(A, THUMBS, page="nope"), 404, "unknown_page")
        run_cli("archive", "plan", "--out-dir", str(self.out_dir), "--local")
        refused(self.react(A, THUMBS), 409, "archived")


class QuietTests(ReactionsTestCase):
    def pulled(self, token: Path, owner: str) -> list[int]:
        rc, got = self.agent(token, "pull", "--owner", owner)
        self.assertEqual(rc, 0, got)
        return [item["comment"]["id"] for item in got["items"] if item["kind"] == "comment"]

    def standing(self) -> list:
        """Each thread's comments without their reactions, and its resolution."""
        return [([{key: value for key, value in row.items() if key != "reactions"}
                  for row in (thread["root"], *thread["replies"])], thread["resolution"])
                for thread in self.read(A)["threads"]]

    def test_a_reaction_wakes_no_one_and_makes_nothing_unread(self):
        responder = self.work / "responder.token"
        machine.create_credential(db.Database(self.db_path), "responder", ["responder"],
                                  ["pull"], responder)
        self.assertEqual(self.seen({"page": "plan", "revision": self.revision})[0], 200)
        self.assertEqual(self.seen({"page": "plan", "thread": self.root["id"],
                                    "comment": self.reply_row["id"]})[0], 200)
        second = self.open_thread(B, "Is the pond deep enough?")
        self.assertEqual(self.unread(A), [])
        # The pulls first: a pull makes its handle listening, which a state shows.
        pulls = (self.pulled(self.token, OWNER), self.pulled(responder, "responder"))
        self.assertIn(second["id"], pulls[1])
        before = (self.ask("GET", "/api/seen")[1]["pages"]["plan"], self.standing())

        self.reacted(B, HEART)
        for root in (self.root, second):
            rc, got = self.agent(self.token, "react", str(root["id"]), EYES)
            self.assertEqual(rc, 0, got)
        self.assertEqual(self.unread(A), [])
        seen = self.ask("GET", "/api/seen")[1]["pages"]["plan"]
        self.assertEqual((seen["unread"], seen["replies"]), (0, before[0]["replies"]))
        self.assertEqual(self.standing(), before[1])
        self.assertEqual((self.pulled(self.token, OWNER), self.pulled(responder, "responder")),
                         pulls)

        status, got = self.ask("POST", "/api/comments", {"page": "plan", "thread": self.root["id"],
                                                         "resolved": True})
        self.assertEqual(status, 200, got)
        self.reacted(B, THUMBS, comment=self.root["id"])
        [thread] = [found for found in self.read(A)["threads"]
                    if found["root"]["id"] == self.root["id"]]
        self.assertTrue(thread["resolution"]["resolved"])


class AgentReactionTests(ReactionsTestCase):
    def test_an_agent_reacts_and_removes_its_reaction_on_the_socket(self):
        reply = str(self.reply_row["id"])
        got = self.hermes("react", reply, EYES)
        self.assertEqual(got, {"comment": self.reply_row["id"], "reactions": [
            {"emoji": EYES, "count": 1, "mine": True, "by": ["hermes"]}]})
        self.assertEqual(self.reactions(A), [
            {"emoji": EYES, "count": 1, "mine": False, "by": ["hermes"]}])
        shown = self.hermes("show", "plan")
        rows = [row for thread in shown["threads"] for row in (thread["root"], *thread["replies"])]
        self.assertTrue(all("reactions" in row for row in rows))
        self.assertEqual([row["reactions"] for row in rows if row["id"] == self.reply_row["id"]],
                         [[{"emoji": EYES, "count": 1, "mine": True, "by": ["hermes"]}]])
        got = self.hermes("react", reply, ":eyes:", "--remove")
        self.assertEqual(got, {"comment": self.reply_row["id"], "reactions": []})
        self.assertEqual(self.reactions(A), [])

    def test_the_command_prints_one_line_per_emoji(self):
        self.reacted(B, THUMBS)
        out = io.StringIO()
        with redirect_stdout(out), redirect_stderr(io.StringIO()):
            rc = cli.main(["comments", "react", str(self.reply_row["id"]), ":eyes:", "--socket",
                           str(self.socket_path), "--credential", str(self.token)])
        self.assertEqual(rc, 0)
        self.assertEqual(out.getvalue(), f"{THUMBS} 1: heron\n{EYES} 1: hermes\n")

    def test_a_refused_agent_reaction_stores_nothing(self):
        database = db.Database(self.db_path)
        stranger, puller = self.work / "stranger.token", self.work / "puller.token"
        machine.create_credential(database, "stranger", ["stranger"], ["pull", "reply"], stranger)
        machine.create_credential(database, "puller", [OWNER], ["pull"], puller)
        reply = str(self.reply_row["id"])
        for token, target, error in ((stranger, reply, "not_routed"),
                                     (puller, reply, "operation_not_allowed"),
                                     (self.token, "999999", "unknown_comment"),
                                     # Past SQLite's largest integer.
                                     (self.token, "9223372036854775808", "unknown_comment"),
                                     (self.token, "nope", "invalid_body")):
            with self.subTest(error=error):
                self.assertEqual(self.agent(token, "react", target, EYES), (1, {"error": error}))
                self.assertEqual(self.stored(), 0)


class SchemaTests(ApiTestCase):
    def test_a_database_from_before_reactions_takes_them(self):
        self.stop()
        path = self.work / "before.sqlite3"
        conn = sqlite3.connect(str(path))
        for step in range(1, BEFORE_REACTIONS + 1):
            for statement in db._SCHEMA[step]:
                conn.execute(statement)
        conn.execute(
            "INSERT INTO comments (page, section, section_title, revision, parent, text,"
            " quote, actor, created_at, state) VALUES ('plan', 'risks', 'Risks', ?, NULL,"
            " 'Kept from before.', NULL, ?, '2026-01-02T03:04:05.000Z', 'pending')",
            (self.revision, json.dumps(ACTOR)),
        )
        conn.execute(f"PRAGMA user_version = {BEFORE_REACTIONS}")
        conn.commit()
        conn.close()
        self.start(path)
        status, got = self.ask("GET", "/api/comments?page=plan")
        self.assertEqual(status, 200, got)
        [thread] = got["threads"]
        self.assertEqual((thread["root"]["text"], thread["root"]["reactions"]),
                         ("Kept from before.", []))
        conn = sqlite3.connect(str(path))
        try:
            self.assertEqual(conn.execute("PRAGMA user_version").fetchone()[0],
                             db.SCHEMA_VERSION)
        finally:
            conn.close()
        status, got = self.comment(comment=thread["root"]["id"], emoji=THUMBS, reacted=True)
        self.assertEqual((status, got["reactions"]), (200, [
            {"emoji": THUMBS, "count": 1, "mine": True, "by": ["maintainer"]}]))


if __name__ == "__main__":
    unittest.main()
