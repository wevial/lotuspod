"""Witness: an agent that may publish as a page's owner records a decision's
answer given elsewhere with `lotuspod comments record-answer`. The reader's
answers route then has it current, as an agent's answer with its source;
`lotuspod answers` prints who recorded it and where it was given; the
owner's pull leaves it out. Recording it again stores nothing, a reader's
answer still replaces it, and a question or option the page does not ask is
refused with nothing stored.

The site is served by `lotuspod serve` on loopback with its agent socket;
the reader's requests carry Access assertions signed with a test key the
site trusts, and the agent runs the real commands (tests.test_agent_pull_witness).
"""

from __future__ import annotations

import json
import re
import unittest

from tests.test_agent_pull_witness import Site

NAME = "pond-model"
SOURCE = "Chat with the maintainer, 2026-10-09"
PAGE = """\
# Pond model

Which model runs the pond.

## Decisions for the maintainer

| # | Question | Options | Default |
| --- | --- | --- | --- |
| 1 | Which model? | Sonnet / Opus | Sonnet |
| 2 | Run it nightly? | Yes / No | |
"""
# What the command prints, its answer's id captured.
RECORDED = re.compile(rf"answer (\d+) recorded on {NAME}: decision-1 = Opus")
AGAIN = re.compile(rf"answer (\d+) was already recorded on {NAME}: decision-1 = Opus")


class RecordedAnswersWitness(Site):
    def setUp(self):
        super().setUp()
        self.hermes = self.credential("hermes", ["hermes"], ["pull", "publish"])
        path = self.tmp / f"{NAME}.md"
        path.write_text(PAGE, encoding="utf-8")
        done = self.cli("publish", str(path), "--owner", "hermes", "--credential",
                        str(self.hermes), "--db", str(self.db), "--out-dir", str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.start_server()

    def record(self, question="decision-1", option="opus", *extra):
        """`lotuspod comments record-answer` as hermes, without --json."""
        return self.cli("comments", "record-answer", NAME, question, option,
                        "--source", SOURCE, *extra, "--credential", str(self.hermes),
                        "--socket", str(self.sock))

    def answers(self) -> dict:
        status, _, body = self.api("GET", f"/api/answers?page={NAME}")
        self.assertEqual(status, 200, body)
        return body["questions"]

    def test_a_recorded_answer_is_saved_counted_and_replaced_by_a_reader(self):
        done = self.record()
        self.assertEqual(done.returncode, 0, done.stderr)
        found = RECORDED.fullmatch(done.stdout.strip())
        self.assertIsNotNone(found, done.stdout)
        recorded = int(found.group(1))

        entry = self.answers()["decision-1"]
        current = entry["current"]
        self.assertEqual((current["id"], current["choice"], current.get("source")),
                         (recorded, "opus", SOURCE))
        self.assertEqual((current["actor"]["kind"], current["actor"]["handle"]),
                         ("agent", "hermes"))
        self.assertEqual(entry["earlier"], [])
        self.assertNotIn("decision-2", self.answers())

        done = self.cli("answers", NAME, "--db", str(self.db), "--out-dir", str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn(f"  Opus, was: Sonnet (answer {recorded})\n", done.stdout)
        self.assertIn(f"  recorded by hermes at {current['createdAt']}, "
                      f"answered elsewhere: {SOURCE}\n", done.stdout)
        done = self.cli("answers", NAME, "--json", "--db", str(self.db))
        self.assertEqual(done.returncode, 0, done.stderr)
        stored = json.loads(done.stdout)["questions"]["decision-1"]["current"]
        self.assertEqual(stored.get("source"), SOURCE)

        # The owner recorded it, so its pull never hands it back.
        self.assertEqual([item for item in self.pull(self.hermes, "hermes")
                          if item["kind"] == "answer"], [])

        done = self.record()
        self.assertEqual(done.returncode, 0, done.stderr)
        again = AGAIN.fullmatch(done.stdout.strip())
        self.assertIsNotNone(again, done.stdout)
        self.assertEqual(int(again.group(1)), recorded)
        entry = self.answers()["decision-1"]
        self.assertEqual((entry["current"]["id"], entry["earlier"]), (recorded, []))

        form_version = entry["current"]["version"]
        status, _, mine = self.api("POST", "/api/answers", {
            "page": NAME, "question": "decision-1", "version": form_version,
            "choice": "sonnet", "note": ""})
        self.assertEqual(status, 201, mine)
        entry = self.answers()["decision-1"]
        self.assertEqual((entry["current"]["id"], entry["current"]["choice"]),
                         (mine["id"], "sonnet"))
        self.assertNotIn("source", entry["current"])
        self.assertEqual(entry["current"]["supersedes"], recorded)
        self.assertEqual([(row["id"], row.get("source")) for row in entry["earlier"]],
                         [(recorded, SOURCE)])

        done = self.record()
        self.assertEqual(done.returncode, 0, done.stderr)
        again = AGAIN.fullmatch(done.stdout.strip())
        self.assertIsNotNone(again, done.stdout)
        self.assertEqual(int(again.group(1)), recorded)
        entry = self.answers()["decision-1"]
        self.assertEqual((entry["current"]["id"], entry["current"]["choice"]),
                         (mine["id"], "sonnet"))
        self.assertEqual(len(entry["earlier"]), 1)

    def test_a_question_or_option_the_page_does_not_ask_is_refused(self):
        for question, option, error in (("decision-9", "opus", "unknown_question"),
                                        ("decision-1", "haiku", "invalid_choice")):
            with self.subTest(question=question, option=option):
                code, body = self.agent(self.hermes, "record-answer", NAME, question, option,
                                        "--source", SOURCE)
                self.assertEqual(code, 1, body)
                self.assertEqual(body, {"error": error})
                done = self.record(question, option)
                self.assertEqual(done.returncode, 1, done.stdout)
        self.assertEqual(self.answers(), {})


if __name__ == "__main__":
    unittest.main()
