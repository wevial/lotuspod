"""Witness: an owner dismisses a decision that no longer matters. The
reader's answers route has the dismissal current, labelled "Dismissed";
the page owner's `lotuspod comments pull` hands it out as an answer marked
dismissed, its reason once; `lotuspod answers` prints it as a dismissal
with its reason, and `lotuspod comments ack-answer` acknowledges it. Undo
leaves a question with no other answer unanswered, and brings an earlier
answer back as current.

The site is served by `lotuspod serve` on loopback with its agent socket,
the reader one of its [access] owners; the reader's requests carry Access
assertions signed with a test key the site trusts, and the agent runs the
real commands (tests.test_agent_pull_witness).
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

from tests.test_agent_pull_witness import READER, Site

NAME = "pond-model"
REASON = "Superseded by the pump plan"
PAGE = """\
# Pond model

Which model runs the pond.

## Decisions for the maintainer

| # | Question | Options |
| --- | --- | --- |
| 1 | Which model? | Sonnet / Opus |
| 2 | Run it nightly? | Yes / No |
"""
FORM = re.compile(r'<form class="artifact-decision[^"]*"[^>]*'
                  r'data-question="(decision-\d)"[^>]*data-version="([^"]+)"')


class DismissalsWitness(Site):
    def setUp(self):
        super().setUp()
        config = Path(self.env["LOTUSPOD_CONFIG"])
        config.write_text(config.read_text(encoding="utf-8") + f"owners = {READER}\n",
                          encoding="utf-8")
        self.hermes = self.credential("hermes", ["hermes"], ["pull", "publish"])
        path = self.tmp / f"{NAME}.md"
        path.write_text(PAGE, encoding="utf-8")
        done = self.cli("publish", str(path), "--comments", "--owner", "hermes",
                        "--credential", str(self.hermes), "--db", str(self.db),
                        "--out-dir", str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)
        html = (self.out / f"{NAME}.html").read_text(encoding="utf-8")
        self.versions = dict(FORM.findall(html))
        self.assertEqual(sorted(self.versions), ["decision-1", "decision-2"], html[:2000])
        self.start_server()

    def answers(self) -> dict:
        status, _, body = self.api("GET", f"/api/answers?page={NAME}")
        self.assertEqual(status, 200, body)
        return body["questions"]

    def post(self, body: dict) -> tuple[int, dict]:
        status, _, payload = self.api("POST", "/api/answers", {"page": NAME, **body})
        return status, payload

    def dismiss(self, question: str, reason: str = "") -> dict:
        status, row = self.post({"question": question, "version": self.versions[question],
                                 "dismissed": True, "reason": reason})
        self.assertEqual(status, 201, row)
        return row

    def undo(self, question: str) -> tuple[int, dict]:
        return self.post({"question": question, "dismissed": False})

    def test_a_dismissal_reaches_the_owner_and_undo_takes_it_back(self):
        dismissal = self.dismiss("decision-1", REASON)
        self.assertEqual((dismissal["dismissed"], dismissal["choice"], dismissal["note"]),
                         (True, "", REASON))
        current = self.answers()["decision-1"]["current"]
        self.assertEqual((current["id"], current["asked"]["label"]),
                         (dismissal["id"], "Dismissed"))

        code, pulled = self.agent(self.hermes, "pull", "--owner", "hermes")
        self.assertEqual(code, 0, pulled)
        [item] = [item for item in pulled["items"] if item["kind"] == "answer"]
        self.assertEqual((item["answer"]["id"], item["answer"]["dismissed"],
                          item["answer"]["note"]), (dismissal["id"], True, REASON))

        done = self.cli("comments", "pull", "--owner", "hermes", "--credential",
                        str(self.hermes), "--socket", str(self.sock))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn(f"- Chosen: Dismissed: {REASON}\n", done.stdout)
        self.assertEqual(done.stdout.count(REASON), 1, done.stdout)

        done = self.cli("answers", NAME, "--db", str(self.db), "--out-dir", str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn(f"Dismissed (answer {dismissal['id']}", done.stdout)
        self.assertIn(f"reason: {REASON}", done.stdout)

        done = self.cli("comments", "ack-answer", str(dismissal["id"]), "--credential",
                        str(self.hermes), "--socket", str(self.sock))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual([item for item in self.pull(self.hermes, "hermes")
                          if item["kind"] == "answer"], [])

        self.assertEqual(self.undo("decision-1"),
                         (200, {"page": NAME, "question": "decision-1", "current": None,
                                "earlier": []}))
        self.assertNotIn("decision-1", self.answers())
        self.assertEqual(self.undo("decision-1"), (409, {"error": "not_dismissed"}))

    def test_undo_brings_the_earlier_answer_back(self):
        status, yes = self.post({"question": "decision-2",
                                 "version": self.versions["decision-2"], "choice": "yes",
                                 "note": ""})
        self.assertEqual(status, 201, yes)
        dismissal = self.dismiss("decision-2")
        self.assertEqual(dismissal["supersedes"], yes["id"])
        status, undone = self.undo("decision-2")
        self.assertEqual(status, 200, undone)
        entry = self.answers()["decision-2"]
        self.assertEqual(entry["current"]["id"], yes["id"])
        self.assertEqual(entry["current"]["choice"], "yes")
        [earlier] = entry["earlier"]
        self.assertEqual((earlier["id"], earlier["dismissed"]), (dismissal["id"], True))
        self.assertIn("undoneAt", earlier)
        self.assertEqual(entry, {"current": undone["current"], "earlier": undone["earlier"]})

        done = self.cli("answers", NAME, "--db", str(self.db), "--out-dir", str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn(f"Dismissed (answer {dismissal['id']}, replaces answer {yes['id']}), "
                      f"undone at {earlier['undoneAt']}", done.stdout)


if __name__ == "__main__":
    unittest.main()
