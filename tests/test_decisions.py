"""Test suite for decision tables: a "Decisions for the maintainer" table in a
page body renders as one radio form per row, tables that do not qualify are
left as written, and `lotuspod answers` prints what was answered. A page
may hold a decisions table in each of its sections; a body with one is held
byte for byte to tests/fixtures/decisions/one_table.expected.html, rendered
before a page could hold more.

The markup is witnessed by parsing it, never by matching strings, except
where a table must survive byte for byte.

Run from the repo root:

    python -m unittest tests.test_decisions -v
"""

from __future__ import annotations

import http.client
import io
import json
import os
import sys
import tempfile
import threading
import unittest
from contextlib import redirect_stderr, redirect_stdout
from html.parser import HTMLParser
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from lotuspod import access, cli, db, decisions, markdown  # noqa: E402
from tests import access_keys  # noqa: E402

FIXTURES = Path(__file__).resolve().parent / "fixtures" / "decisions"

READER = {"kind": "human", "email": "maintainer@example.com"}

TABLE = """\
| # | Question | Options | Default |
| --- | --- | --- | --- |
| 1 | Which model replies? | Sonnet / Opus | Sonnet |
| 2 | Keep the archive? | Yes / No | Yes |
"""

# A Context column whose first cell holds a link, and whose second is empty.
CONTEXT_TABLE = """\
| # | Question | Context | Options | Default |
| --- | --- | --- | --- | --- |
| 1 | Which pump? | A floating pump rides the ice. See [the pump notes](pump.html) first. | Floating / Submerged | Floating |
| 2 | Feed the fish in winter? |  | Yes / No | No |
"""

PLAN = f"""\
# Model choice

Two things to settle.

## Plan

The responder needs a model, and the archive needs a rule.

## Decisions for the maintainer

{TABLE}"""


# Two sections, each asking its own question under its own decisions heading.
SECTIONS = """\
# Pond plan

## Pump

The pump stops when the water freezes.

### Decisions for the maintainer

| # | Question | Options |
| --- | --- | --- |
| D1 | Which pump? | Floating / Submerged |

## Heater

A heater keeps a hole in the ice.

### Decisions for the maintainer

| # | Question | Options |
| --- | --- | --- |
| D2 | Which heater? | Electric / Solar |
"""


# An h2 holding a checklist under its own h3.
CHECKLIST = """\
# Mail plan

## Emails

What each new reader is sent.

### Checklist for the maintainer

| # | Item | Default |
| --- | --- | --- |
| w | Welcome | on |
| d | Digest | off |
| r | Reminder | ON |
"""

CHECKLIST_TABLE = CHECKLIST.split("### Checklist for the maintainer\n\n", 1)[1]


class _Page(HTMLParser):
    """A page's decision forms, with their inputs, plus its tables and scripts."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.forms: list[dict] = []
        self.tables = 0
        self.scripts: list[str] = []
        self._form: dict | None = None
        self._label: dict | None = None
        self._button: dict | None = None
        self._mark: list[str] | None = None
        self._summary: list[str] | None = None
        self._details = 0
        self._context = False

    def handle_starttag(self, tag, attrs):
        attrs = {key: value or "" for key, value in attrs}
        classes = attrs.get("class", "").split()
        if tag == "table":
            self.tables += 1
        elif tag == "script":
            self.scripts.append(attrs.get("src", ""))
        elif tag == "form":
            self._form = {"attrs": attrs, "radios": [], "checkboxes": [], "labels": [],
                          "notes": 0,
                          "folded_notes": 0, "summaries": [], "buttons": [], "context": []}
            self.forms.append(self._form)
        elif self._form is None:
            return
        elif tag == "label" and "artifact-decision-option" in classes:
            self._label = {"text": [], "marks": [], "last": None}
            self._form["labels"].append(self._label)
        elif tag == "span" and self._label is not None:
            self._label["last"] = classes
            if "artifact-decision-default" in classes:
                self._mark = []
        elif tag == "details":
            self._details += 1
        elif tag == "summary":
            self._summary = []
        elif tag == "input" and attrs.get("type") == "radio":
            self._form["radios"].append(attrs)
        elif tag == "input" and attrs.get("type") == "checkbox":
            self._form["checkboxes"].append(attrs)
        elif tag == "textarea":
            self._form["notes"] += attrs.get("name") == "note"
            self._form["folded_notes"] += bool(self._details and attrs.get("name") == "note")
        elif tag == "button":
            self._button = {"type": attrs.get("type"), "text": []}
            self._form["buttons"].append(self._button)
        elif tag == "p" and "artifact-decision-context" in classes:
            self._context = True
            self._form["context"].append([])

    def handle_data(self, data):
        if self._mark is not None:
            self._mark.append(data)
        if self._summary is not None:
            self._summary.append(data)
        if self._label is not None:
            self._label["text"].append(data)
        if self._button is not None:
            self._button["text"].append(data)
        if self._context:
            self._form["context"][-1].append(data)

    def handle_endtag(self, tag):
        if tag == "span" and self._mark is not None:
            self._label["marks"].append("".join(self._mark))
            self._mark = None
        elif tag == "summary" and self._summary is not None:
            self._form["summaries"].append(" ".join("".join(self._summary).split()))
            self._summary = None
        elif tag == "details" and self._details:
            self._details -= 1
        elif tag == "label" and self._label is not None:
            self._label["text"] = " ".join("".join(self._label["text"]).split())
            self._label = None
        elif tag == "button" and self._button is not None:
            self._button["text"] = " ".join("".join(self._button["text"]).split())
            self._button = None
        elif tag == "p" and self._context:
            self._context = False
            self._form["context"][-1] = " ".join("".join(self._form["context"][-1]).split())
        elif tag == "form":
            self._form = None


def read(page_html: str) -> _Page:
    page = _Page()
    page.feed(page_html)
    page.close()
    return page


def run_cli(*argv: str) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        rc = cli.main(list(argv))
    return rc, out.getvalue(), err.getvalue()


class DecisionsTestCase(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.work = Path(tmp.name)
        self.out_dir = self.work / "artifacts"

    def render_markdown(self, name: str, text: str) -> str:
        source = self.work / f"{name}.md"
        source.write_text(text, encoding="utf-8")
        rc, _, err = run_cli("render", "--name", name, "--title", name.title(),
                             "--date", "2026-01-02", "--markdown", str(source),
                             "--out-dir", str(self.out_dir))
        self.assertEqual(rc, 0, err)
        return (self.out_dir / f"{name}.html").read_text(encoding="utf-8")

    def render_body(self, name: str, body: str) -> str:
        rc, _, err = run_cli("render", "--name", name, "--title", name.title(),
                             "--date", "2026-01-02", "--body", body,
                             "--out-dir", str(self.out_dir))
        self.assertEqual(rc, 0, err)
        return (self.out_dir / f"{name}.html").read_text(encoding="utf-8")

    def assertLeftAsWritten(self, page_html: str, table_html: str) -> None:
        self.assertIn(table_html, page_html)
        page = read(page_html)
        self.assertEqual(page.forms, [])
        self.assertEqual(page.tables, 1)
        # A page with sections still loads the page script, to fold them.
        folds = 'class="artifact-section-body"' in page_html
        self.assertEqual([src.split("?")[0] for src in page.scripts],
                         [cli.PAGE_SCRIPT] if folds else [])


class FormTests(DecisionsTestCase):
    def test_each_row_becomes_a_radio_form(self):
        page = read(self.render_markdown("plan", PLAN))
        self.assertEqual(page.tables, 0)
        self.assertEqual(len(page.forms), 2)
        self.assertEqual([form["attrs"]["data-question"] for form in page.forms],
                         ["decision-1", "decision-2"])
        self.assertEqual([form["attrs"]["data-page"] for form in page.forms], ["plan", "plan"])
        self.assertEqual([form["attrs"]["class"] for form in page.forms],
                         ["artifact-decision", "artifact-decision"])
        self.assertEqual([[radio["value"] for radio in form["radios"]] for form in page.forms],
                         [["sonnet", "opus"], ["yes", "no"]])
        for form in page.forms:
            with self.subTest(form=form["attrs"]["data-question"]):
                self.assertRegex(form["attrs"]["data-version"], r"^[0-9a-f]{12}$")
                self.assertEqual({radio["name"] for radio in form["radios"]}, {"choice"})
                self.assertFalse(any("checked" in radio for radio in form["radios"]))
                self.assertEqual(form["notes"], 1)
                self.assertEqual(form["folded_notes"], 1)
                self.assertEqual(form["summaries"], ["Add a note"])
                self.assertEqual(form["buttons"], [{"type": "submit", "text": "Save answer"}])
        self.assertEqual([label["text"] for label in page.forms[0]["labels"]],
                         ["Sonnet default", "Opus"])
        self.assertEqual([label["text"] for label in page.forms[1]["labels"]],
                         ["Yes default", "No"])
        # The default's label ends in its mark; the others carry none.
        for form in page.forms:
            labels = form["labels"]
            self.assertEqual([label["marks"] for label in labels], [["default"], []])
            self.assertIn("artifact-decision-default", labels[0]["last"])
        self.assertEqual([form["context"] for form in page.forms], [[], []])
        self.assertEqual([src.split("?")[0] for src in page.scripts], [cli.PAGE_SCRIPT])

    def test_the_forms_sit_inside_their_section(self):
        page_html = self.render_markdown("plan", PLAN)
        heading = page_html.index('<h2 id="decisions-for-the-maintainer">')
        self.assertGreater(page_html.index('<div class="artifact-decisions">'), heading)

    def test_rewording_a_question_changes_only_its_version(self):
        before = read(self.render_markdown("plan", PLAN)).forms
        reworded = PLAN.replace("Which model replies?", "Which model writes the replies?")
        after = read(self.render_markdown("plan", reworded)).forms
        self.assertNotEqual(before[0]["attrs"]["data-version"], after[0]["attrs"]["data-version"])
        self.assertEqual(before[1]["attrs"]["data-version"], after[1]["attrs"]["data-version"])
        relabelled = PLAN.replace("Yes / No", "Yes / Not yet")
        again = read(self.render_markdown("plan", relabelled)).forms
        self.assertEqual(before[0]["attrs"]["data-version"], again[0]["attrs"]["data-version"])
        self.assertNotEqual(before[1]["attrs"]["data-version"], again[1]["attrs"]["data-version"])

    def test_without_a_number_column_ids_follow_the_rows(self):
        text = PLAN.replace(TABLE, """\
| Question | Options |
| --- | --- |
| Which model replies? | Sonnet / Opus |
| Keep the archive? | Yes / No |
""")
        page = read(self.render_markdown("plan", text))
        self.assertEqual([form["attrs"]["data-question"] for form in page.forms],
                         ["decision-1", "decision-2"])

    def test_number_cells_are_slugged_and_deduplicated(self):
        text = PLAN.replace(TABLE, """\
| # | Question | Options |
| --- | --- | --- |
| A.1 | First? | Yes / No |
| a 1 | Second? | Yes / No |
|  | Third? | Yes / No |
""")
        page = read(self.render_markdown("plan", text))
        self.assertEqual([form["attrs"]["data-question"] for form in page.forms],
                         ["decision-a-1", "decision-a-1-2", "decision-3"])

    def test_other_columns_are_shown_as_context(self):
        text = PLAN.replace(TABLE, """\
| # | Question | Why | Options | Default |
| --- | --- | --- | --- | --- |
| 1 | Which model replies? | Replies run on **every** comment | Sonnet / Opus | Sonnet |
""")
        page = read(self.render_markdown("plan", text))
        self.assertEqual(page.forms[0]["context"], ["Why: Replies run on every comment"])

    def test_a_context_column_shows_unlabelled_right_after_its_question(self):
        text = PLAN.replace(TABLE, CONTEXT_TABLE)
        page_html = self.render_markdown("plan", text)
        page = read(page_html)
        self.assertEqual(page.forms[0]["context"], [
            "A floating pump rides the ice. See the pump notes first."])
        self.assertEqual(page.forms[1]["context"], [])
        first = page_html.split('data-question="decision-2"')[0]
        self.assertIn(
            '<span class="artifact-decision-text">Which pump?</span></legend>\n'
            '<p class="artifact-decision-context">A floating pump rides the ice. See '
            '<a href="pump.html">the pump notes</a> first.</p>\n', first)
        self.assertNotIn("artifact-decision-context-label", first)

    def test_a_column_with_a_blank_header_keeps_its_label(self):
        text = PLAN.replace(TABLE, """\
| # | Question |  | Options | Default |
| --- | --- | --- | --- | --- |
| 1 | Which model replies? | Replies run on every comment | Sonnet / Opus | Sonnet |
""")
        page_html = self.render_markdown("plan", text)
        self.assertIn('<p class="artifact-decision-context"><span class="artifact-decision-context-'
                      'label">:</span> Replies run on every comment</p>', page_html)

    def test_the_context_comes_before_the_other_columns(self):
        text = PLAN.replace(TABLE, """\
| # | Question | Why | Context | Options | Default |
| --- | --- | --- | --- | --- | --- |
| 1 | Which model replies? | Replies run on **every** comment | It answers readers. | Sonnet / Opus | Sonnet |
""")
        page_html = self.render_markdown("plan", text)
        self.assertEqual(read(page_html).forms[0]["context"],
                         ["It answers readers.", "Why: Replies run on every comment"])
        self.assertEqual(decisions.read_forms(page_html)["decision-1"].context,
                         "It answers readers.\nWhy: Replies run on every comment")

    def test_editing_the_context_keeps_the_version(self):
        text = PLAN.replace(TABLE, CONTEXT_TABLE)
        before = self.render_markdown("plan", text)
        after = self.render_markdown("plan", text.replace("rides the ice", "floats on the ice"))
        self.assertEqual(read(before).forms[0]["attrs"]["data-version"],
                         decisions.version("Which pump?", ["Floating", "Submerged"]))
        self.assertEqual(decisions.read_forms(after), decisions.read_forms(before))
        # Form equality leaves context out: the new text is read back all the same.
        self.assertEqual(decisions.read_forms(after)["decision-1"].context,
                         "A floating pump floats on the ice. See the pump notes first.")

    def test_a_default_and_no_options_offers_accept_and_other(self):
        text = PLAN.replace(TABLE, """\
| Question | Default |
| --- | --- |
| Which model replies? | Sonnet for now |
| Keep the archive? | Yes |
""")
        page = read(self.render_markdown("plan", text))
        self.assertEqual([[radio["value"] for radio in form["radios"]] for form in page.forms],
                         [["accept", "other"], ["accept", "other"]])
        self.assertEqual([label["text"] for label in page.forms[0]["labels"]],
                         ["Accept the default", "Something else"])
        self.assertEqual([form["context"] for form in page.forms],
                         [["Default: Sonnet for now"], ["Default: Yes"]])

    def test_a_default_matching_no_option_writes_no_default_line(self):
        text = PLAN.replace("| Sonnet / Opus | Sonnet |", "| Sonnet / Opus | Haiku |")
        page = read(self.render_markdown("plan", text))
        self.assertEqual([[label["marks"] for label in form["labels"]] for form in page.forms],
                         [[[], []], [["default"], []]])
        self.assertEqual([form["context"] for form in page.forms], [[], []])

    def test_an_html_body_and_an_h3_heading_in_any_case(self):
        body = (
            "<h2>Plan</h2>\n<p>Words.</p>\n<h3>DECISIONS for the  Maintainer</h3>\n"
            "<table>\n<tr><th>Question<th>Options\n"
            "<tr><td>Ship it?<td>Yes / No / Later\n</table>\n"
        )
        page = read(self.render_body("plan", body))
        self.assertEqual(page.tables, 0)
        self.assertEqual([[radio["value"] for radio in form["radios"]] for form in page.forms],
                         [["yes", "no", "later"]])

    def test_the_first_qualifying_table_is_taken(self):
        body = (
            "<h2>Decisions for the maintainer</h2>\n"
            "<table><tr><th>Name</th><th>Options</th></tr><tr><td>x</td><td>A / B</td></tr></table>\n"
            "<table><tr><th>Question</th><th>Options</th></tr><tr><td>Go?</td><td>Yes / No</td></tr></table>\n"
            "<table><tr><th>Question</th><th>Options</th></tr><tr><td>Stop?</td><td>Yes / No</td></tr></table>\n"
        )
        page = read(self.render_body("plan", body))
        self.assertEqual(page.tables, 2)
        self.assertEqual(len(page.forms), 1)
        forms = decisions.read_forms((self.out_dir / "plan.html").read_text(encoding="utf-8"))
        self.assertEqual([form.text for form in forms.values()], ["Go?"])

    def test_each_section_s_table_becomes_forms_in_that_section(self):
        page_html = self.render_markdown("pond", SECTIONS)
        page = read(page_html)
        self.assertEqual(page.tables, 0)
        self.assertEqual([form["attrs"]["data-question"] for form in page.forms],
                         ["decision-d1", "decision-d2"])
        heater = page_html.index('<h2 id="heater">')
        pump = page_html.index('<h2 id="pump">')
        first = page_html.index('data-question="decision-d1"')
        second = page_html.index('data-question="decision-d2"')
        self.assertLess(pump, first)
        self.assertLess(first, heater)
        self.assertLess(heater, second)
        self.assertEqual(page_html.count('<div class="artifact-decisions">'), 2)
        self.assertEqual([src.split("?")[0] for src in page.scripts], [cli.PAGE_SCRIPT])

    def test_read_forms_reads_every_section_s_questions(self):
        forms = decisions.read_forms(self.render_markdown("pond", SECTIONS))
        self.assertEqual(list(forms), ["decision-d1", "decision-d2"])
        self.assertEqual([form.text for form in forms.values()], ["Which pump?", "Which heater?"])
        self.assertEqual(forms["decision-d2"].options, (("electric", "Electric"), ("solar", "Solar")))

    def test_a_number_repeated_across_tables_is_deduplicated(self):
        text = SECTIONS.replace("| D2 |", "| D1 |") + (
            "\n## Archive\n\n### Decisions for the maintainer\n\n"
            "| Question | Options |\n| --- | --- |\n| Keep it? | Yes / No |\n"
        )
        page = read(self.render_markdown("pond", text))
        self.assertEqual([form["attrs"]["data-question"] for form in page.forms],
                         ["decision-d1", "decision-d1-2", "decision-1"])

    def test_a_row_number_is_counted_within_its_own_table(self):
        text = SECTIONS.replace("| D1 |", "|  |").replace("| D2 |", "|  |")
        page = read(self.render_markdown("pond", text))
        self.assertEqual([form["attrs"]["data-question"] for form in page.forms],
                         ["decision-1", "decision-1-2"])

    def test_a_table_left_as_written_takes_no_ids(self):
        text = SECTIONS.replace("| D1 | Which pump? | Floating / Submerged |",
                                "| D1 | Which pump? | Floating |")
        page_html = self.render_markdown("pond", text)
        page = read(page_html)
        self.assertEqual(page.tables, 1)
        self.assertEqual([form["attrs"]["data-question"] for form in page.forms], ["decision-d2"])
        self.assertLess(page_html.index("<table"), page_html.index('<h2 id="heater">'))

    def test_one_decisions_table_renders_as_before_a_page_could_hold_more(self):
        body = (FIXTURES / "one_table.body.html").read_text(encoding="utf-8")
        rendered, made = decisions.render_decisions(body, "plan")
        self.assertTrue(made)
        self.assertEqual(rendered.encode("utf-8"),
                         (FIXTURES / "one_table.expected.html").read_bytes())

    def test_read_forms_reads_the_rendered_questions_back(self):
        forms = decisions.read_forms(self.render_markdown("plan", PLAN))
        self.assertEqual(list(forms), ["decision-1", "decision-2"])
        first = forms["decision-1"]
        self.assertEqual(first.text, "Which model replies?")
        self.assertEqual(first.options, (("sonnet", "Sonnet"), ("opus", "Opus")))
        self.assertEqual(first.version, decisions.version("Which model replies?", ["Sonnet", "Opus"]))
        self.assertEqual(first.label("opus"), "Opus")
        self.assertEqual(first.label("maybe"), "maybe")


# Row 1 has a default among its options, row 2 none, and row 3, in a table
# with no Options column, a default its "Accept the default" accepts.
DEFAULTS = """\
# Defaults

## Model

### Decisions for the maintainer

| # | Question | Options | Default |
| --- | --- | --- | --- |
| 1 | Which model replies? | Sonnet / Opus | Sonnet |
| 2 | Keep the archive? | Yes / No | |

## Layout

### Decisions for the maintainer

| # | Question | Default |
| --- | --- | --- |
| 3 | Keep the layout? | Keep it |
"""


class DefaultTests(DecisionsTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.page_html = self.render_markdown("defaults", DEFAULTS)
        self.forms = decisions.read_forms(self.page_html)
        self.db_path = self.work / "lotuspod.sqlite3"

    def test_each_decision_form_names_its_default(self):
        attrs = {form["attrs"]["data-question"]: form["attrs"]
                 for form in read(self.page_html).forms}
        self.assertEqual(list(attrs), ["decision-1", "decision-2", "decision-3"])
        self.assertEqual(attrs["decision-1"]["data-default"], "sonnet")
        self.assertNotIn("data-default", attrs["decision-2"])
        self.assertEqual(attrs["decision-3"]["data-default"], "accept")
        self.assertEqual([form.default for form in self.forms.values()],
                         ["sonnet", "", "accept"])

    def test_a_checklist_names_no_default(self):
        page_html = self.render_markdown("mail", CHECKLIST)
        [attrs] = [form["attrs"] for form in read(page_html).forms]
        self.assertNotIn("data-default", attrs)
        self.assertEqual(decisions.read_forms(page_html)["checklist-1"].default, "")

    def test_the_default_leaves_the_version_as_it_was(self):
        from tests import capture_site

        rendered, _ = decisions.render_decisions(capture_site.DECISIONS_BODY,
                                                 "capture-decisions")
        first = next(form for form in read(rendered).forms
                     if form["attrs"]["data-question"] == "decision-1")
        # As e2e/checks/decisions.spec.ts recorded it before forms had defaults.
        self.assertEqual(first["attrs"]["data-version"], "87f71d1b09cb")
        self.assertEqual(first["attrs"]["data-default"], "sonnet")

    def text(self, question: str, choice: str, version: str | None = None) -> str:
        """The first answer line answers_text prints for one answer."""
        self.db_path.unlink(missing_ok=True)
        database = db.Database(self.db_path)
        row = database.add_answer(
            page="defaults", question=question,
            version=version or self.forms[question].version, choice=choice, note="",
            revision="abc123abc123", actor=READER,
        )
        lines = cli.answers_text("defaults", database.answers("defaults", asked=True),
                                 self.forms).splitlines()
        return lines[1].replace(f"(answer {row['id']}", "(answer N")

    def test_an_answer_off_its_default_says_what_it_was(self):
        self.assertEqual(self.text("decision-1", "opus"), "  Opus, was: Sonnet (answer N)")
        self.assertEqual(self.text("decision-1", "sonnet"), "  Sonnet (answer N)")
        self.assertEqual(self.text("decision-3", "other"),
                         "  Something else, was: Accept the default (answer N)")

    def test_no_default_or_an_earlier_wording_says_nothing_of_one(self):
        self.assertEqual(self.text("decision-2", "no"), "  No (answer N)")
        self.assertEqual(self.text("decision-1", "opus", version="000000000000"),
                         "  Opus (answer N), to an earlier wording")


class LeftAsWrittenTests(DecisionsTestCase):
    def test_a_table_under_another_heading(self):
        text = PLAN.replace("## Decisions for the maintainer", "## Open questions")
        page_html = self.render_markdown("plan", text)
        self.assertLeftAsWritten(page_html, markdown.to_body(TABLE).strip())

    def test_a_table_after_the_next_h2(self):
        text = PLAN.replace("## Decisions for the maintainer\n",
                            "## Decisions for the maintainer\n\nNone yet.\n\n## Appendix\n")
        page_html = self.render_markdown("plan", text)
        self.assertLeftAsWritten(page_html, markdown.to_body(TABLE).strip())

    def test_a_row_of_one_option_and_no_default(self):
        table = """\
| # | Question | Options |
| --- | --- | --- |
| 1 | Which model replies? | Sonnet / Opus |
| 2 | Keep the archive? | Yes |
"""
        page_html = self.render_markdown("plan", PLAN.replace(TABLE, table))
        self.assertLeftAsWritten(page_html, markdown.to_body(table).strip())

    def test_a_table_without_a_question_column(self):
        table = "| Item | Options |\n| --- | --- |\n| Model | Sonnet / Opus |\n"
        page_html = self.render_markdown("plan", PLAN.replace(TABLE, table))
        self.assertLeftAsWritten(page_html, markdown.to_body(table).strip())

    def test_a_table_inside_a_diagram_block(self):
        body = (
            "<h2>Decisions for the maintainer</h2>\n<pre class=\"mermaid\">graph LR\n"
            "  A[\"<table><tr><th>Question</th><th>Options</th></tr>"
            "<tr><td>Go?</td><td>Yes / No</td></tr></table>\"]</pre>\n"
        )
        page_html = self.render_body("plan", body)
        self.assertIn(body.split("\n", 1)[1].strip(), page_html)
        self.assertNotIn("artifact-decision", page_html)
        self.assertNotIn(cli.PAGE_SCRIPT, page_html)


class ChecklistTests(DecisionsTestCase):
    """A "Checklist for the maintainer" table renders as one form of
    checkboxes preset to their defaults."""

    def test_the_table_becomes_one_form_of_checkboxes(self):
        page_html = self.render_markdown("mail", CHECKLIST)
        page = read(page_html)
        self.assertEqual(page.tables, 0)
        [form] = page.forms
        self.assertEqual(form["attrs"]["class"].split(),
                         ["artifact-decision", "artifact-decision--checklist"])
        self.assertEqual(form["attrs"]["data-question"], "checklist-1")
        self.assertEqual(form["attrs"]["data-page"], "mail")
        self.assertRegex(form["attrs"]["data-version"], r"^[0-9a-f]{12}$")
        self.assertEqual(form["radios"], [])
        self.assertEqual([(box["name"], box["value"], "checked" in box)
                          for box in form["checkboxes"]],
                         [("item", "w", True), ("item", "d", False), ("item", "r", True)])
        self.assertEqual([label["text"] for label in form["labels"]],
                         ["Welcome", "Digest", "Reminder"])
        self.assertEqual(form["buttons"], [{"type": "submit", "text": "Save answer"}])
        self.assertEqual(form["summaries"], ["Add a note"])
        self.assertEqual(form["folded_notes"], 1)
        # Inside the decisions block, as a decision's forms are.
        self.assertLess(page_html.index('<div class="artifact-decisions">'),
                        page_html.index('data-question="checklist-1"'))
        self.assertEqual([src.split("?")[0] for src in page.scripts], [cli.PAGE_SCRIPT])

        [read_back] = decisions.read_forms(page_html).values()
        self.assertEqual(read_back.question, "checklist-1")
        self.assertEqual(read_back.text, "Emails")
        self.assertTrue(read_back.checklist)
        self.assertEqual(read_back.options,
                         (("w", "Welcome"), ("d", "Digest"), ("r", "Reminder")))
        self.assertEqual(read_back.defaults, ("w", "r"))
        self.assertEqual(read_back.version, form["attrs"]["data-version"])
        self.assertEqual(read_back.version, decisions.checklist_version(
            "Emails", [("w", "Welcome", True), ("d", "Digest", False),
                       ("r", "Reminder", True)]))

    def test_a_checklist_under_an_h2_takes_its_own_text_and_rows_their_numbers(self):
        body = (
            "<h2>Checklist for the maintainer</h2>\n"
            "<table><tr><th>Item</th><th>Default</th></tr>"
            "<tr><td>One <em>more</em></td><td>off</td></tr>"
            "<tr><td>Two</td><td>Off</td></tr></table>\n"
        )
        [form] = decisions.read_forms(self.render_body("mail", body)).values()
        self.assertEqual(form.text, "Checklist for the maintainer")
        self.assertEqual(form.options, (("1", "One more"), ("2", "Two")))
        self.assertEqual(form.defaults, ())

    def test_checklists_and_decisions_end_each_others_sections(self):
        text = CHECKLIST + "\n### Decisions for the maintainer\n\n" + TABLE + (
            "\n## Digests\n\n### Checklist for the maintainer\n\n"
            "| Item | Default |\n| --- | --- |\n| Weekly | on |\n| Weekly | off |\n")
        forms = decisions.read_forms(self.render_markdown("mail", text))
        self.assertEqual(list(forms), ["checklist-1", "decision-1", "decision-2", "checklist-2"])
        self.assertFalse(forms["decision-1"].checklist)
        self.assertEqual((forms["checklist-2"].text, forms["checklist-2"].options),
                         ("Digests", (("1", "Weekly"), ("2", "Weekly"))))

    def test_its_version_follows_each_label_default_and_the_h2(self):
        def version(text: str) -> str:
            [form] = decisions.read_forms(self.render_markdown("mail", text)).values()
            return form.version

        first = version(CHECKLIST)
        self.assertEqual(version(CHECKLIST), first)
        changed = {
            "label": CHECKLIST.replace("| Digest |", "| Weekly digest |"),
            "default": CHECKLIST.replace("| d | Digest | off |", "| d | Digest | on |"),
            "h2": CHECKLIST.replace("## Emails", "## Mail"),
        }
        versions = {name: version(text) for name, text in changed.items()}
        for name, got in versions.items():
            with self.subTest(name):
                self.assertNotEqual(got, first)
        self.assertEqual(len(set(versions.values())), 3)

    def test_a_table_that_makes_no_checklist_is_left_as_written(self):
        tables = {
            "a default of maybe": CHECKLIST_TABLE.replace("| off |", "| maybe |"),
            "a Why column": (
                "| # | Item | Default | Why |\n| --- | --- | --- | --- |\n"
                "| w | Welcome | on | First mail |\n| d | Digest | off | Weekly |\n"),
            "an empty Item cell": CHECKLIST_TABLE.replace("| Digest |", "|  |"),
            "no body rows": "| # | Item | Default |\n| --- | --- | --- |\n",
        }
        for name, table in tables.items():
            with self.subTest(name):
                page_html = self.render_markdown("mail", CHECKLIST.replace(CHECKLIST_TABLE, table))
                self.assertLeftAsWritten(page_html, markdown.to_body(table).strip())

    def test_a_table_with_a_cell_no_field_keeps_is_left_as_written(self):
        tables = {
            "a cell past the header": (
                "<table><tr><th>Item</th><th>Default</th></tr>"
                "<tr><td>Welcome</td><td>on</td><td>Only for new readers</td></tr></table>"),
            "a repeated Item column": (
                "<table><tr><th>Item</th><th>Item</th><th>Default</th></tr>"
                "<tr><td>Welcome</td><td>Hello</td><td>on</td></tr></table>"),
        }
        for name, table in tables.items():
            with self.subTest(name):
                body = "<h2>Emails</h2>\n<h3>Checklist for the maintainer</h3>\n" + table + "\n"
                self.assertLeftAsWritten(self.render_body("mail", body), table)


class ServedTestCase(DecisionsTestCase):
    """A test case with serve running over self.out_dir and its database."""

    def setUp(self) -> None:
        super().setUp()
        config = self.work / "config.ini"
        config.write_text(access_keys.config_text(), encoding="utf-8")
        env = mock.patch.dict(os.environ, {"LOTUSPOD_CONFIG": str(config)})
        env.start()
        self.addCleanup(env.stop)
        patcher = mock.patch.object(cli._AllowListHandler, "log_message", lambda *a: None)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.source = self.work / "pond.md"
        verifier = access.Verifier(access.parse_config(access_keys.config_section()))
        server = cli._make_server(self.out_dir, "127.0.0.1", 0, verifier=verifier,
                                  db_path=self.work / "lotuspod.sqlite3")
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.port = server.server_address[1]

        def stop() -> None:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

        self.addCleanup(stop)

    def publish(self, text: str) -> dict[str, decisions.Form]:
        self.source.write_text(text, encoding="utf-8")
        rc, _, err = run_cli("publish", str(self.source), "--name", "pond",
                             "--out-dir", str(self.out_dir), "--local")
        self.assertEqual(rc, 0, err)
        return decisions.read_forms((self.out_dir / "pond.html").read_text(encoding="utf-8"))

    def ask(self, method: str, path: str, body: dict | None = None) -> tuple[int, dict]:
        headers = {"Cf-Access-Jwt-Assertion": access_keys.assertion()}
        raw = None
        if body is not None:
            raw = json.dumps(body).encode("utf-8")
            headers["Content-Type"] = "application/json"
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=15)
        try:
            conn.request(method, path, body=raw, headers=headers)
            response = conn.getresponse()
            return response.status, json.loads(response.read().decode("utf-8"))
        finally:
            conn.close()


class MovedQuestionTests(ServedTestCase):
    """A question moved into another section's table keeps its answers."""

    def test_an_answer_follows_its_question_into_another_section(self):
        one_table = """\
# Pond plan

## Pump

The pump stops when the water freezes.

## Heater

A heater keeps a hole in the ice.

## Decisions for the maintainer

| # | Question | Options |
| --- | --- | --- |
| D1 | Which pump? | Floating / Submerged |
| D2 | Which heater? | Electric / Solar |
"""
        before = self.publish(one_table)
        self.assertEqual(list(before), ["decision-d1", "decision-d2"])
        status, saved = self.ask("POST", "/api/answers", {
            "page": "pond", "question": "decision-d2", "version": before["decision-d2"].version,
            "choice": "solar", "note": "Sun on the pond",
        })
        self.assertEqual(status, 201, saved)

        after = self.publish(SECTIONS)
        page_html = (self.out_dir / "pond.html").read_text(encoding="utf-8")
        # D2 now sits in the heater section's own table.
        self.assertLess(page_html.index('<h2 id="heater">'),
                        page_html.index('data-question="decision-d2"'))
        self.assertEqual(after["decision-d2"], before["decision-d2"])

        status, got = self.ask("GET", "/api/answers?page=pond")
        self.assertEqual(status, 200)
        self.assertEqual(list(got["questions"]), ["decision-d2"])
        current = got["questions"]["decision-d2"]["current"]
        self.assertEqual((current["choice"], current["note"]), ("solar", "Sun on the pond"))
        # The page script fills a form from an answer to its own version.
        self.assertEqual(current["version"], after["decision-d2"].version)
        self.assertEqual(after["decision-d2"].label(current["choice"]), "Solar")


# Two 200-character labels that share their first 150 characters.
SHARED = ("Evidence levels: reproduced or traced can block; a concern is answered but "
          "never blocks, at most three per round, and the high-tier ones also go to the "
          "operator")[:150]
LONG_LABEL = SHARED + "y" * 50
OTHER_LONG_LABEL = SHARED + "x" * 50


def long_options(options: str, default: str = "") -> str:
    return f"""\
# Pond plan

## Decisions for the maintainer

| # | Question | Options | Default |
| --- | --- | --- | --- |
| D1 | How do reviews weigh evidence? | {options} | {default} |
"""


class LongOptionValueTests(DecisionsTestCase):
    """An option's value is bounded to what the answers route accepts; its
    label is shown in full."""

    def test_a_long_label_gets_a_bounded_hashed_value_and_shows_in_full(self):
        form = read(self.render_markdown("pond", long_options(f"{LONG_LABEL} / No"))).forms[0]
        values = [radio["value"] for radio in form["radios"]]
        self.assertLessEqual(len(values[0]), 100)
        self.assertRegex(values[0], r"-[0-9a-f]{8}$")
        self.assertTrue(cli.slugify(LONG_LABEL).startswith(values[0][:-9]))
        self.assertEqual(values[1], "no")
        self.assertEqual([label["text"] for label in form["labels"]], [LONG_LABEL, "No"])

    def test_long_labels_sharing_a_prefix_get_distinct_values(self):
        form = read(self.render_markdown(
            "pond", long_options(f"{LONG_LABEL} / {OTHER_LONG_LABEL}"))).forms[0]
        values = [radio["value"] for radio in form["radios"]]
        self.assertNotEqual(values[0], values[1])
        for value in values:
            self.assertLessEqual(len(value), 100)
            self.assertRegex(value, r"-[0-9a-f]{8}$")

    def test_short_labels_keep_their_slug(self):
        labels = ["Sonnet", "A" * 40 + " " + "b" * 39]
        form = read(self.render_markdown("pond", long_options(" / ".join(labels)))).forms[0]
        self.assertEqual([radio["value"] for radio in form["radios"]],
                         [cli.slugify(label) for label in labels])

    def test_a_default_naming_a_long_option_marks_it(self):
        form = read(self.render_markdown(
            "pond", long_options(f"No / {LONG_LABEL}", default=LONG_LABEL))).forms[0]
        self.assertEqual([label["marks"] for label in form["labels"]], [[], ["default"]])


class LongOptionTests(ServedTestCase):
    """An option offered on the page, however long its label, can be saved."""

    def test_a_long_option_the_page_offers_saves(self):
        label = ("Evidence levels: reproduced or traced can block; a concern is answered "
                 "but never blocks, at most 3 per round, high-tier ones also go to the operator")
        forms = self.publish(long_options(f"{label} / No"))
        asked = forms["decision-d1"]
        value = next(value for value, shown in asked.options if shown == label)
        status, saved = self.ask("POST", "/api/answers", {
            "page": "pond", "question": "decision-d1", "version": asked.version,
            "choice": value, "note": "",
        })
        self.assertEqual(status, 201, saved)


class AnswersJsonTests(ServedTestCase):
    """lotuspod answers --json prints what GET /api/answers answers, asked
    included, but for each reader's address."""

    def test_json_prints_what_the_route_answers(self):
        forms = self.publish(SECTIONS)
        version = forms["decision-d2"].version
        db.Database(self.work / "lotuspod.sqlite3").add_answer(
            page="pond", question="decision-d2", version=version, choice="electric",
            note="", revision="abc123abc123", actor=READER,
        )
        for choice in ("solar", "electric"):
            status, saved = self.ask("POST", "/api/answers", {
                "page": "pond", "question": "decision-d2", "version": version,
                "choice": choice, "note": "",
            })
            self.assertEqual(status, 201, saved)
        status, got = self.ask("GET", "/api/answers?page=pond")
        self.assertEqual(status, 200, got)
        answered = got["questions"]["decision-d2"]
        self.assertEqual(answered["current"]["asked"], {"text": "Which heater?", "label": "Electric"})
        self.assertEqual([row["asked"] for row in answered["earlier"]], [
            {"text": "Which heater?", "label": "Solar"}, {"text": None, "label": None}])

        rc, out, err = run_cli("answers", "pond", "--json",
                               "--db", str(self.work / "lotuspod.sqlite3"))
        self.assertEqual(rc, 0, err)
        printed = json.loads(out)
        # The host's command shows each reader's whole address; the route,
        # only the part before the @.
        for printed_row, row in zip(
                [printed["questions"]["decision-d2"]["current"],
                 *printed["questions"]["decision-d2"]["earlier"]],
                [answered["current"], *answered["earlier"]]):
            self.assertEqual(printed_row["actor"], READER)
            self.assertEqual(row["actor"], {"kind": "human", "name": "maintainer"})
            printed_row["actor"] = row["actor"]
        self.assertEqual(printed, got)


class AnswersCommandTests(DecisionsTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.render_markdown("plan", PLAN)
        self.db_path = self.work / "lotuspod.sqlite3"
        self.form = decisions.read_forms(
            (self.out_dir / "plan.html").read_text(encoding="utf-8"))["decision-1"]

    def add(self, choice: str, note: str) -> dict:
        return db.Database(self.db_path).add_answer(
            page="plan", question="decision-1", version=self.form.version, choice=choice,
            note=note, revision="abc123abc123", actor=READER,
        )

    def answers(self, *extra: str) -> str:
        rc, out, err = run_cli("answers", "plan", "--db", str(self.db_path),
                               "--out-dir", str(self.out_dir), *extra)
        self.assertEqual(rc, 0, err)
        return out

    def test_prints_the_current_answer_and_the_earlier_one_under_it(self):
        first = self.add("sonnet", "Cheaper for now")
        second = self.add("opus", "Opus for page edits")
        lines = self.answers().splitlines()
        self.assertEqual(lines, [
            "decision-1: Which model replies?",
            f"  Opus, was: Sonnet (answer {second['id']}, replaces answer {first['id']})",
            f"    by maintainer@example.com at {second['createdAt']}",
            "    note: Opus for page edits",
            "  earlier:",
            f"    Sonnet (answer {first['id']})",
            f"      by maintainer@example.com at {first['createdAt']}",
            "      note: Cheaper for now",
        ])

    def test_an_answer_to_an_earlier_wording_says_so(self):
        db.Database(self.db_path).add_answer(
            page="plan", question="decision-1", version="000000000000", choice="opus",
            note="", revision="abc123abc123", actor=READER,
        )
        self.assertIn(", to an earlier wording", self.answers().splitlines()[1])

    def test_no_answers(self):
        self.assertEqual(self.answers(), "no answers to plan\n")


class ChecklistAnswersCommandTests(DecisionsTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.render_markdown("mail", CHECKLIST)
        self.db_path = self.work / "lotuspod.sqlite3"
        self.form = decisions.read_forms(
            (self.out_dir / "mail.html").read_text(encoding="utf-8"))["checklist-1"]

    def add(self, checked: list[str], label: str, version: str | None = None) -> dict:
        return db.Database(self.db_path).add_answer(
            page="mail", question="checklist-1", version=version or self.form.version,
            choice="", note="", revision="abc123abc123", actor=READER,
            question_text="Emails", choice_label=label, checked=checked,
        )

    def answers(self) -> list[str]:
        rc, out, err = run_cli("answers", "mail", "--db", str(self.db_path),
                               "--out-dir", str(self.out_dir))
        self.assertEqual(rc, 0, err)
        return out.splitlines()

    def test_prints_each_answer_by_its_change_summary(self):
        first = self.add(["w", "r"], "No change from the defaults")
        second = self.add(["d", "r"], "On: Digest · Off: Welcome")
        self.assertEqual(self.answers(), [
            "checklist-1: Emails",
            f"  On: Digest · Off: Welcome (answer {second['id']}, replaces answer {first['id']})",
            f"    by maintainer@example.com at {second['createdAt']}",
            "  earlier:",
            f"    No change from the defaults (answer {first['id']})",
            f"      by maintainer@example.com at {first['createdAt']}",
        ])

    def test_an_answer_to_another_version_prints_its_kept_summary(self):
        self.add(["d"], "Kept words", version="000000000000")
        self.assertEqual(self.answers()[1].split(" (")[0], "  Kept words")
        self.assertIn(", to an earlier wording", self.answers()[1])


if __name__ == "__main__":
    unittest.main()
