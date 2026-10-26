"""Witness: each option in a decisions table is its own radio, under an
`Options` header alone or followed by a parenthesised note, and every
decision ends in a "Something else" radio that is not part of its version.
A row whose Options cell gives fewer than two options, with a Default, asks
as a row with no Options column does, the cell shown as context. An answer
saved through "Accept the default" shows as the default option once the
question offers its own options (decisions.shown).

The forms are read by parsing the markup. The republish cases use real
publishes with `--local`, real git with a local bare repository as the
artifacts remote, and the real database; the CLI runs as a subprocess of
this checkout's src/.
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "src"))

from lotuspod.features.decisions import decisions
from lotuspod.features.decisions.decisions import Form, holds, read_forms, shown
from lotuspod.store import db
from tests.features.decisions.test_decisions import read

REPO = Path(__file__).resolve().parents[3]
SRC = REPO / "src"
TIMEOUT = 120
NAME = "today-log"

H1 = ('| H1 | Should "PR opened" be a Today\'s log highlight? | '
      'It shows on every run; merge rows already link the PR | Off / On | Off |')
NOTED = "| # | Question | Context | Options (a / b) | Default |"
# The version main rendered for the row `| 1 | Which model replies? |
# Sonnet / Opus | Sonnet |` under a plain Options header.
MAIN_VERSION = "87f71d1b09cb"

DEFAULT_ONLY = """\
# Today's log

What the log shows.

## Decisions for the maintainer

| # | Question | Context | Default |
| --- | --- | --- | --- |
| H1 | Should "PR opened" be a Today's log highlight? | It shows on every run | Off |
"""
WITH_OPTIONS = DEFAULT_ONLY.replace(
    "| # | Question | Context | Default |\n| --- | --- | --- | --- |",
    "| # | Question | Context | Options (a / b) | Default |\n| --- | --- | --- | --- | --- |",
).replace("| It shows on every run | Off |", "| It shows on every run | Off / On | Off |")
REWORDED = WITH_OPTIONS.replace('Should "PR opened" be a Today\'s log highlight?',
                                'Should "PR opened" be highlighted?')


def body(header: str, *rows: str) -> str:
    """A decisions section whose table is header and rows, as markdown
    renders one."""
    def cells(line: str, tag: str) -> str:
        parts = [part.strip() for part in line.strip().strip("|").split("|")]
        return "<tr>" + "".join(f"<{tag}>{part}</{tag}>" for part in parts) + "</tr>"
    return ("<h2>Decisions for the maintainer</h2>\n<table>\n<thead>\n" + cells(header, "th")
            + "\n</thead>\n<tbody>\n" + "\n".join(cells(row, "td") for row in rows)
            + "\n</tbody>\n</table>\n")


def render(header: str, *rows: str) -> tuple[str, bool]:
    return decisions.render_decisions(body(header, *rows), "plan")


class Headers(unittest.TestCase):
    def check_h1(self, header: str) -> None:
        page_html, made = render(header, H1)
        self.assertTrue(made)
        page = read(page_html)
        [form] = page.forms
        self.assertEqual(form["attrs"]["data-question"], "decision-h1")
        self.assertEqual([radio["value"] for radio in form["radios"]], ["off", "on", "other"])
        self.assertEqual([label["text"] for label in form["labels"]],
                         ["Off default", "On", "Something else"])
        self.assertEqual([label["marks"] for label in form["labels"]], [["default"], [], []])
        self.assertEqual(form["attrs"]["data-default"], "off")
        self.assertEqual(form["context"],
                         ["It shows on every run; merge rows already link the PR"])
        self.assertFalse([line for line in form["context"]
                          if "Options" in line or "Default:" in line])
        [read_back] = read_forms(page_html).values()
        self.assertEqual(read_back.options,
                         (("off", "Off"), ("on", "On"), ("other", "Something else")))
        self.assertEqual(read_back.default, "off")
        self.assertEqual(read_back.version, decisions.version(read_back.text, ["Off", "On"]))

    def test_an_options_header_with_a_note_gives_one_radio_per_option(self):
        self.check_h1(NOTED)

    def test_a_default_header_with_a_note_gives_the_same_form(self):
        self.check_h1(NOTED.replace("| Default |", "| Default (if unsure) |"))
        self.assertEqual(render(NOTED, H1)[0],
                         render(NOTED.replace("| Default |", "| Default (if unsure) |"), H1)[0])

    def test_headers_match_in_any_case(self):
        self.check_h1(NOTED.replace("Options (a / b)", "OPTIONS (pick one)")
                      .replace("Default", "default"))

    def test_other_words_after_options_are_context(self):
        page_html, _ = render("| # | Question | Options to weigh | Default |",
                              "| 1 | Keep it? | Yes / No | Yes |")
        [form] = read(page_html).forms
        self.assertEqual([radio["value"] for radio in form["radios"]], ["accept", "other"])
        self.assertIn("Options to weigh: Yes / No", form["context"])


class SomethingElse(unittest.TestCase):
    def test_a_plain_options_row_keeps_main_s_version_and_ends_in_something_else(self):
        page_html, _ = render("| # | Question | Options | Default |",
                              "| 1 | Which model replies? | Sonnet / Opus | Sonnet |")
        [form] = read(page_html).forms
        self.assertEqual(form["attrs"]["data-version"], MAIN_VERSION)
        self.assertEqual(form["labels"][-1]["text"], "Something else")
        self.assertEqual(form["radios"][-1]["value"], "other")

    def test_a_cell_offering_something_else_offers_it_once(self):
        page_html, _ = render("| # | Question | Options | Default |",
                              "| 1 | Ship it? | Yes / No / Something else | Yes |")
        [form] = read(page_html).forms
        self.assertEqual(len(form["radios"]), 3)
        self.assertEqual([label["text"] for label in form["labels"]].count("Something else"), 1)

    def test_an_option_already_something_else_is_not_offered_twice(self):
        page_html, _ = render("| # | Question | Options | Default |",
                              "| 1 | Ship it? | Yes / No / something ELSE | Yes |")
        [form] = read(page_html).forms
        self.assertEqual(len(form["radios"]), 3)
        self.assertEqual([label["text"].casefold() for label in form["labels"]].count(
            "something else"), 1)

    def test_an_option_valued_other_is_not_offered_twice(self):
        page_html, _ = render("| # | Question | Options |", "| 1 | Ship it? | Yes / Other |")
        [form] = read(page_html).forms
        self.assertEqual([radio["value"] for radio in form["radios"]], ["yes", "other"])


class Fallback(unittest.TestCase):
    ROWS = ("| 1 | How long to wait? | Any time after nine | Ten minutes |",
            "| 2 | Which colour? | Lavender | Lavender |",
            "| 3 | Keep it? | Yes / No | Yes |")

    def test_fewer_than_two_options_with_a_default_asks_to_accept_it(self):
        page_html, made = render("| # | Question | Options | Default |", *self.ROWS)
        self.assertTrue(made)
        forms = read(page_html).forms
        alone = {form["attrs"]["data-question"]: form for form in read(render(
            "| # | Question | Default |", "| 1 | How long to wait? | Ten minutes |",
            "| 2 | Which colour? | Lavender |")[0]).forms}
        for form, cell, default in ((forms[0], "Any time after nine", "Ten minutes"),
                                    (forms[1], "Lavender", "Lavender")):
            with self.subTest(question=form["attrs"]["data-question"]):
                self.assertEqual([radio["value"] for radio in form["radios"]],
                                 ["accept", "other"])
                self.assertEqual([label["text"] for label in form["labels"]],
                                 ["Accept the default", "Something else"])
                self.assertEqual(form["attrs"]["data-default"], "accept")
                self.assertEqual(form["context"], [f"Options: {cell}", f"Default: {default}"])
                self.assertEqual(form["attrs"]["data-version"],
                                 alone[form["attrs"]["data-question"]]["attrs"]["data-version"])
        self.assertEqual([radio["value"] for radio in forms[2]["radios"]], ["yes", "no", "other"])
        self.assertEqual(forms[2]["attrs"]["data-default"], "yes")

    def test_the_cell_shows_under_its_header_s_own_label(self):
        page_html, _ = render(NOTED, "| 1 | Which colour? | Pick one | Lavender | Lavender |")
        [form] = read(page_html).forms
        self.assertEqual(form["context"],
                         ["Pick one", "Options (a / b): Lavender", "Default: Lavender"])

    def test_fewer_than_two_options_and_no_default_is_left_as_written(self):
        written = body("| # | Question | Options | Default |", "| 1 | Which colour? | Lavender | |")
        self.assertEqual(decisions.render_decisions(written, "plan"), (written, False))


class Rule(unittest.TestCase):
    FORM = Form(question="decision-h1", text="Should it be a highlight?", version="v2",
                options=(("off", "Off"), ("on", "On"), ("other", "Something else")),
                default="off")

    def answer(self, **changes) -> dict:
        found = {"question": "decision-h1", "version": "v1", "choice": "accept",
                 "asked": {"text": "Should it be  a highlight?", "label": "Accept the default"}}
        found.update(changes)
        return found

    def test_an_accept_at_the_form_s_own_version_shows_as_its_default_option(self):
        form = Form(question="decision-1", text="Ship it?", version="v1",
                    options=(("accept-the-default", "Accept the default"),
                             ("something-else", "Something else")),
                    default="accept-the-default")
        answer = {"question": "decision-1", "version": "v1", "choice": "accept",
                  "asked": {"text": "Ship it?", "label": "Accept the default"}}
        self.assertEqual(shown(form, answer), "accept-the-default")

    def test_an_answer_to_an_offered_option_shows_as_itself(self):
        self.assertEqual(shown(self.FORM, self.answer(choice="on",
                                                      asked={"text": self.FORM.text,
                                                             "label": "On"})), "on")
        self.assertEqual(shown(self.FORM, self.answer(version="v2", choice="other")), "other")

    def test_other_words_another_label_a_dismissal_or_no_default_do_not(self):
        cases = (
            (self.FORM, {"asked": {"text": "Should it be highlighted?",
                                   "label": "Accept the default"}}),
            (self.FORM, {"asked": {"text": self.FORM.text, "label": "Accept"}}),
            (self.FORM, {"dismissed": True}),
            (self.FORM, {"asked": None}),
            (Form(question="decision-h1", text=self.FORM.text, version="v2",
                  options=self.FORM.options), {}),
            (Form(question="decision-h1", text=self.FORM.text, version="v2",
                  options=self.FORM.options, default="maybe"), {}),
        )
        for form, changes in cases:
            with self.subTest(changes=changes, default=form.default):
                self.assertFalse(holds(form, self.answer(**changes)))
                self.assertIsNone(shown(form, self.answer(**changes)))


def git(cwd: Path, *argv: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(cwd), *argv], capture_output=True,
                          timeout=TIMEOUT)


class Republished(unittest.TestCase):
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

    def form(self) -> Form:
        return read_forms((self.out / f"{NAME}.html").read_text(encoding="utf-8"))["decision-h1"]

    def current(self) -> dict:
        return db.Database(self.db).answers(NAME, asked=True)["decision-h1"]["current"]

    def accepted(self) -> None:
        """Publish the Default-only row and accept its default as the page
        asked it."""
        self.publish(DEFAULT_ONLY)
        form = self.form()
        self.assertEqual(form.options, (decisions.ACCEPT, decisions.OTHER))
        db.Database(self.db).add_answer(
            page=NAME, question=form.question, version=form.version, choice="accept",
            note="", revision="r1", actor={"kind": "reader", "email": "m@example.com"},
            question_text=form.text, choice_label=form.label("accept"))

    def test_an_earlier_accept_shows_as_the_default_option_and_warns_of_nothing(self):
        self.accepted()
        done = self.publish(WITH_OPTIONS)
        self.assertEqual([line for line in done.stderr.splitlines()
                          if line.startswith("publish: ")], [])
        form = self.form()
        self.assertEqual(form.options, (("off", "Off"), ("on", "On"), decisions.OTHER))
        self.assertNotEqual(self.current()["version"], form.version)
        self.assertTrue(holds(form, self.current()))
        self.assertEqual(shown(form, self.current()), "off")

    def test_an_accept_to_a_reworded_question_shows_as_no_answer(self):
        self.accepted()
        self.publish(REWORDED)
        form = self.form()
        self.assertFalse(holds(form, self.current()))
        self.assertIsNone(shown(form, self.current()))


if __name__ == "__main__":
    unittest.main()
