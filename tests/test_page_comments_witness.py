"""Witness: a reader's thread on the whole page, section "", is carried as
any thread. hermes pulls it as "the whole page", claims and answers it, and
adds a follow-up, each reply stored in the thread with section ""; once the
reader resolves it, `lotuspod comments show` heads it "The whole page" and
says it is resolved.

The site is served by `lotuspod serve` on loopback with its agent socket;
the reader's requests carry Access assertions signed with a test key the
site trusts, and hermes runs the real commands (tests.test_agent_pull_witness).
"""

from __future__ import annotations

import unittest

from tests.test_agent_pull_witness import Site

NAME = "pond-plan"
PAGE = """\
# Pond plan

What we will do.

## Goals

Ship it.

## Risks

The pond may freeze.
"""


class PageCommentsWitness(Site):
    def setUp(self):
        super().setUp()
        self.hermes = self.credential("hermes", ["hermes"], ["pull", "claim", "reply", "publish"])
        path = self.tmp / f"{NAME}.md"
        path.write_text(PAGE, encoding="utf-8")
        done = self.cli("publish", str(path), "--owner", "hermes", "--credential",
                        str(self.hermes), "--db", str(self.db), "--out-dir", str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.start_server()

    def markdown(self, *argv: str) -> str:
        """`lotuspod comments ...` as hermes, without --json."""
        done = self.cli("comments", *argv, "--credential", str(self.hermes),
                        "--socket", str(self.sock))
        self.assertEqual(done.returncode, 0, done.stderr)
        return done.stdout

    def test_hermes_pulls_answers_and_follows_up_a_thread_on_the_whole_page(self):
        # hermes is listening, so the reader's thread is routed to it.
        self.assertEqual(self.pull(self.hermes, "hermes"), [])
        root = self.comment(NAME, "", "Is this plan still current?")
        self.assertEqual((root["section"], root["sectionTitle"], root["quote"], root["owner"]),
                         ("", "", None, "hermes"))
        self.assertNotIn("question", root)

        (item,) = self.pull(self.hermes, "hermes")
        self.assertEqual((item["kind"], item["comment"]["id"], item["comment"]["section"]),
                         ("comment", root["id"], ""))
        pulled = self.markdown("pull", "--owner", "hermes")
        self.assertIn(f"## 1. Comment {root['id']} on `{NAME}`, the whole page\n", pulled)

        code, claimed = self.agent(self.hermes, "claim", str(root["id"]))
        self.assertEqual(code, 0, claimed)
        code, reply = self.agent(self.hermes, "reply", str(root["id"]), "--claim",
                                 claimed["claimToken"], "--key", "hermes-page-1",
                                 "--text", "Yes, as of today.")
        self.assertEqual(code, 0, reply)
        self.assertEqual((reply["parent"], reply["section"], reply["sectionTitle"]),
                         (root["id"], "", ""))
        code, follow = self.agent(self.hermes, "follow-up", str(root["id"]), "--key",
                                  "hermes-page-2", "--text", "The risks still hold.")
        self.assertEqual(code, 0, follow)
        self.assertEqual((follow["parent"], follow["section"]), (root["id"], ""))
        thread = self.thread(NAME, root["id"])
        self.assertEqual([row["id"] for row in thread["replies"]], [reply["id"], follow["id"]])
        self.assertEqual([row["section"] for row in thread["replies"]], ["", ""])
        self.assertEqual(self.pull(self.hermes, "hermes"), [])

        status, _, resolved = self.api("POST", "/api/comments",
                                       {"page": NAME, "thread": root["id"], "resolved": True})
        self.assertEqual(status, 200, resolved)
        shown = self.markdown("show", NAME)
        self.assertIn("\n## The whole page\n\nResolved by ", shown)
        self.assertNotIn("## Section", shown)
        for text in ("Is this plan still current?", "Yes, as of today.", "The risks still hold."):
            self.assertIn(text, shown)


if __name__ == "__main__":
    unittest.main()
