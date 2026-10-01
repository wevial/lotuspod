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
            self._form = {"attrs": attrs, "radios": [], "labels": [], "notes": 0,
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
        self.assertEqual(page.scripts, [])


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


class MovedQuestionTests(DecisionsTestCase):
    """A question moved into another section's table keeps its answers."""

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
            f"  Opus (answer {second['id']}, replaces answer {first['id']})",
            f"    by maintainer@example.com at {second['createdAt']}",
            "    note: Opus for page edits",
            "  earlier:",
            f"    Sonnet (answer {first['id']})",
            f"      by maintainer@example.com at {first['createdAt']}",
            "      note: Cheaper for now",
        ])

    def test_json_prints_what_the_route_answers(self):
        first = self.add("sonnet", "")
        second = self.add("opus", "")
        self.assertEqual(json.loads(self.answers("--json")), {
            "page": "plan",
            "questions": {"decision-1": {"current": second, "earlier": [first]}},
        })

    def test_an_answer_to_an_earlier_wording_says_so(self):
        db.Database(self.db_path).add_answer(
            page="plan", question="decision-1", version="000000000000", choice="opus",
            note="", revision="abc123abc123", actor=READER,
        )
        self.assertIn(", to an earlier wording", self.answers().splitlines()[1])

    def test_no_answers(self):
        self.assertEqual(self.answers(), "no answers to plan\n")


if __name__ == "__main__":
    unittest.main()
