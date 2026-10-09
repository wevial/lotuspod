"""Witness: a reader's note on a saved answer opens a thread on that
decision. The answer's 201 body carries the note's comment, routed to the
page's owner; the owner's real `lotuspod comments pull` has the comment, in
a thread on the decision, and the answer pointing to it, so the note is
printed once. The owner claims and replies with the real commands and the
reader reads the reply; a later note joins the same thread, and reopens it
once resolved.

The site is served by `lotuspod serve` on loopback with its agent socket;
the reader's requests carry Access assertions signed with a test key the
site trusts, and the agent runs the real commands (tests.test_agent_pull_witness).
"""

from __future__ import annotations

import unittest

from tests.test_agent_pull_witness import READER, Site

NAME = "note-threads"
PAGE = """\
# Model choice

Which model runs at night.

## Decisions for the maintainer

| # | Question | Options |
| --- | --- | --- |
| 1 | Which model? | Sonnet / Opus |
| 2 | Run it nightly? | Yes / No |
"""
NOTE = "Why not Sonnet for nightly runs?"


class AnswerNoteThreadsWitness(Site):
    def setUp(self):
        super().setUp()
        self.hermes = self.credential("hermes", ["hermes"], ["pull", "claim", "reply", "publish"])
        path = self.tmp / f"{NAME}.md"
        path.write_text(PAGE, encoding="utf-8")
        done = self.cli("publish", str(path), "--comments", "--owner", "hermes", "--credential",
                        str(self.hermes), "--db", str(self.db), "--out-dir", str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.start_server()
        # hermes is listening, so the reader's comments are routed to it.
        self.assertEqual(self.pull(self.hermes, "hermes"), [])

    def answer(self, choice, note, question="decision-1"):
        """The reader's answer at the version the page's form asks it."""
        html = (self.out / f"{NAME}.html").read_text(encoding="utf-8")
        marker = f'data-question="{question}" data-version="'
        start = html.index(marker) + len(marker)
        status, _, body = self.api("POST", "/api/answers", {
            "page": NAME, "question": question, "version": html[start:html.index('"', start)],
            "choice": choice, "note": note})
        self.assertEqual(status, 201, body)
        return body

    def threads(self):
        status, _, body = self.api("GET", f"/api/comments?page={NAME}")
        self.assertEqual(status, 200, body)
        return body["threads"]

    def text_pull(self):
        done = self.cli("comments", "pull", "--owner", "hermes", "--credential",
                        str(self.hermes), "--socket", str(self.sock))
        self.assertEqual(done.returncode, 0, done.stderr)
        return done.stdout

    def test_a_note_is_a_thread_the_owner_pulls_claims_and_replies_to(self):
        answer = self.answer("opus", NOTE)
        comment = answer["comment"]
        self.assertEqual(
            (comment["parent"], comment["question"], comment["text"], comment["actor"]["kind"],
             comment["owner"], comment["answer"]),
            (None, "decision-1", NOTE, "human", "hermes",
             {"id": answer["id"], "choice": "opus", "label": "Opus"}))
        self.assertEqual([thread["root"]["id"] for thread in self.threads()], [comment["id"]])

        items = self.pull(self.hermes, "hermes")
        [noted] = [item for item in items if item["kind"] == "comment"]
        self.assertEqual(noted["comment"]["id"], comment["id"])
        self.assertEqual(noted["comment"]["actor"], {"kind": "human", "email": READER})
        self.assertEqual(noted["decision"]["answer"]["id"], answer["id"])
        [answered] = [item for item in items if item["kind"] == "answer"]
        self.assertEqual((answered["answer"]["id"], answered["noteComment"]),
                         (answer["id"], comment["id"]))

        out = self.text_pull()
        self.assertEqual(out.count(NOTE), 1, out)
        start = out.index(f"Answer {answer['id']} on `{NAME}`")
        self.assertIn(f"- Note: comment {comment['id']}, in a thread on this decision", out[start:])
        part = out[out.index(f"Comment {comment['id']} on `{NAME}`"):start]
        self.assertNotIn("The answer's note:", part)
        self.assertIn(f"- With answer {answer['id']}: Opus (`opus`)", part)

        code, claimed = self.agent(self.hermes, "claim", str(comment["id"]))
        self.assertEqual(code, 0, claimed)
        code, reply = self.agent(self.hermes, "reply", str(comment["id"]), "--claim",
                                 claimed["claimToken"], "--key", "note-1",
                                 "--text", "Sonnet is slower at night.")
        self.assertEqual(code, 0, reply)
        [thread] = self.threads()
        self.assertEqual([(row["text"], row["actor"].get("handle")) for row in thread["replies"]],
                         [("Sonnet is slower at night.", "hermes")])

        later = self.answer("sonnet", "Sonnet then, if it keeps up.")
        self.assertEqual((later["comment"]["parent"], later["comment"]["answer"]["choice"]),
                         (comment["id"], "sonnet"))
        on = [thread for thread in self.threads() if thread["root"].get("question") == "decision-1"]
        self.assertEqual(len(on), 1)

        status, _, resolved = self.api("POST", "/api/comments", {
            "page": NAME, "thread": comment["id"], "resolved": True})
        self.assertEqual(status, 200, resolved)
        self.assertTrue(resolved["resolution"]["resolved"])
        back = self.answer("opus", "Back to Opus.")
        self.assertEqual(back["comment"]["parent"], comment["id"])
        [thread] = self.threads()
        self.assertEqual(thread["replies"][-1]["id"], back["comment"]["id"])
        self.assertFalse(thread["resolution"]["resolved"])


if __name__ == "__main__":
    unittest.main()
