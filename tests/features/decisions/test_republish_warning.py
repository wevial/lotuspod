"""Witness: `lotuspod publish` says when a republish reopens an answered
decision. With serve's database beside the output directory, a republish
prints one line to standard error for each question whose stored answer
showed as its answer before (decisions.holds) and no longer does on the page
as published, which still asks it; a question taken off, an option added, an
unchanged republish and a site with no database print none. Publish still
writes, commits and exits 0.

Real publishes with `--local`, real git with a local bare repository as the
artifacts remote, and the real database. The CLI runs as a subprocess of
this checkout's src/.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from lotuspod.features.decisions.decisions import Form, holds, read_forms
from lotuspod.store import db

REPO = Path(__file__).resolve().parents[3]
SRC = REPO / "src"
TIMEOUT = 120
NAME = "heater-plan"

FIRST = """\
# Heater plan

Which heater the shed gets.

## Decisions for the maintainer

| # | Question | Options | Default |
| --- | --- | --- | --- |
| 1 | Which heater? | Solar / Electric | Solar |
| 2 | Insulate the roof? | Yes / No | |
"""
REWORDED = """\
# Heater plan

Which heater the shed gets.

## Decisions for the maintainer

| # | Question | Options | Default |
| --- | --- | --- | --- |
| 1 | Which heater for the shed? | Solar / Electric | Solar |
| 3 | Paint the door? | Green / Blue | |
"""
CHECKLIST = """\
# Heater plan

Which heater the shed gets.

## Checklist for the maintainer

| # | Item | Default |
| --- | --- | --- |
| a | Vent the roof | on |
| b | Seal the door | off |
"""
WIDENED = FIRST.replace("| Solar / Electric |", "| Solar / Electric / Gas |")
WARNED = (f'publish: {NAME}: decision-1 was answered "Which heater?" (Electric); '
          'this publish asks "Which heater for the shed?" there, so its card opens again')


def git(cwd: Path, *argv: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(cwd), *argv], capture_output=True,
                          timeout=TIMEOUT)


class RepublishWarning(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name).resolve()
        self.bare = self.tmp / "origin.git"
        self.out = self.tmp / "artifacts"
        # Where serve keeps its database: beside the output directory.
        self.db = self.tmp / db.DEFAULT_NAME
        for argv in (("init", "-q", "--bare", "-b", "main", str(self.bare)),
                     ("clone", "-q", str(self.bare), str(self.out))):
            done = git(self.tmp, *argv)
            self.assertEqual(done.returncode, 0, done.stderr)
        for key, value in (("user.name", "Witness"),
                           ("user.email", "witness@example.com"),
                           ("commit.gpgsign", "false")):
            git(self.out, "config", key, value)
        self.source = self.tmp / f"{NAME}.md"

    def publish(self, text: str) -> subprocess.CompletedProcess:
        self.source.write_text(text, encoding="utf-8")
        env = dict(os.environ, PYTHONPATH=str(SRC),
                   LOTUSPOD_CONFIG=str(self.tmp / "no-config.toml"))
        done = subprocess.run(
            [sys.executable, "-m", "lotuspod", "publish", str(self.source), "--local",
             "--out-dir", str(self.out)],
            cwd=str(self.tmp), env=env, capture_output=True, text=True, timeout=TIMEOUT)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn(f"published {NAME} at revision", done.stdout)
        return done

    def forms(self) -> dict[str, Form]:
        return read_forms((self.out / f"{NAME}.html").read_text(encoding="utf-8"))

    def answer(self, form: Form, choice: str) -> None:
        """Store an answer as the answers route does, in the page's words."""
        db.Database(self.db).add_answer(
            page=NAME, question=form.question, version=form.version, choice=choice,
            note="Out of the wind", revision="r1",
            actor={"kind": "reader", "email": "m@example.com"},
            question_text=form.text, choice_label=form.label(choice))

    def answered(self) -> None:
        self.publish(FIRST)
        forms = self.forms()
        self.answer(forms["decision-1"], "electric")
        self.answer(forms["decision-2"], "yes")

    def warnings(self, done: subprocess.CompletedProcess) -> list[str]:
        return [line for line in done.stderr.splitlines() if line.startswith("publish: ")]

    def test_a_reworded_question_is_named_and_one_taken_off_is_not(self):
        self.answered()
        done = self.publish(REWORDED)
        self.assertEqual(done.stderr.splitlines(), [WARNED])
        self.assertEqual(set(self.forms()), {"decision-1", "decision-3"})
        done = self.publish(REWORDED)
        self.assertEqual(self.warnings(done), [])

    def test_an_option_added_keeps_the_answer_and_prints_nothing(self):
        self.answered()
        done = self.publish(WIDENED)
        self.assertEqual(self.warnings(done), [])
        forms = self.forms()
        current = db.Database(self.db).answers(NAME, asked=True)["decision-1"]["current"]
        self.assertNotEqual(current["version"], forms["decision-1"].version)
        self.assertTrue(holds(forms["decision-1"], current))

    def test_a_checklist_answer_without_its_words_is_named_by_its_items(self):
        self.publish(CHECKLIST)
        form = self.forms()["checklist-1"]
        db.Database(self.db).add_answer(
            page=NAME, question=form.question, version=form.version, choice="",
            note="", revision="r1", actor={"kind": "reader", "email": "m@example.com"},
            checked=["a", "b"])
        done = self.publish(CHECKLIST.replace("Seal the door", "Seal the shed door"))
        self.assertEqual(self.warnings(done), [
            f'publish: {NAME}: checklist-1 was answered "{form.text}" '
            f'(Vent the roof, Seal the door); this publish asks "{form.text}" there, '
            'so its card opens again'])

    def test_no_database_prints_nothing(self):
        self.publish(FIRST)
        done = self.publish(REWORDED)
        self.assertEqual(self.warnings(done), [])
        self.assertFalse(self.db.exists())


class Rule(unittest.TestCase):
    FORM = Form(question="decision-1", text="Which heater?", version="v2",
                options=(("solar", "Solar"), ("electric", "Electric"), ("gas", "Gas")))

    def answer(self, **changes) -> dict:
        found = {"question": "decision-1", "version": "v1", "choice": "electric",
                 "asked": {"text": "Which  heater? ", "label": "Electric"}}
        found.update(changes)
        return found

    def test_the_same_words_and_label_hold_across_versions(self):
        self.assertTrue(holds(self.FORM, self.answer()))
        self.assertTrue(holds(self.FORM, self.answer(version="v2", asked=None)))

    def test_white_space_is_what_python_and_the_page_both_collapse(self):
        for text, same in (("Which\x85heater?", True), ("Which\x1fheater?", True),
                           ("Which\u3000heater?", True), ("Which\ufeffheater?", False)):
            with self.subTest(text=text):
                form = Form(question="decision-1", text=text, version="v2",
                            options=self.FORM.options)
                self.assertEqual(holds(form, self.answer()), same)

    def test_other_words_a_dismissal_a_checklist_or_no_words_do_not(self):
        for changes in ({"asked": {"text": "Which heater for the shed?", "label": "Electric"}},
                        {"asked": {"text": "Which heater?", "label": "Electric coil"}},
                        {"choice": "wind"}, {"dismissed": True}, {"checked": ["a"]},
                        {"asked": None}, {"asked": {"text": None, "label": None}}):
            with self.subTest(changes=changes):
                self.assertFalse(holds(self.FORM, self.answer(**changes)))


if __name__ == "__main__":
    unittest.main()
