"""Test suite for response forms: a task list in a page body renders as a
form, and `lotuspod export` describes the visible pages' forms for the Worker.

The markup is witnessed by parsing it, never by matching strings. A page
without a task list is held byte for byte to tests/fixtures/
no_task_list.expected.html, captured from the renderer as it stood before
forms existed (it names the theme version, so a theme bump re-captures it).

Run from the repo root:

    python -m unittest tests.test_forms -v
"""

from __future__ import annotations

import json
import re
import tempfile
from html.parser import HTMLParser
from pathlib import Path

from tests.test_manifest_v2 import TempDirTestCase, run_cli

FIXTURES = Path(__file__).parent / "fixtures"

THREE_ITEMS = (
    "<p>Before the question.</p>\n"
    '<ul class="contains-task-list">\n'
    '<li class="task-list-item"><input type="checkbox" disabled> Approve the plan</li>\n'
    '<li class="task-list-item"><input type="checkbox" disabled> Ask <em>Ko</em> &amp; wait</li>\n'
    '<li class="task-list-item"><input type="checkbox" disabled checked> Ship it</li>\n'
    "</ul>\n"
    "<p>After the question.</p>\n"
)

ORDINARY_LIST = "<ul>\n<li>Plain one</li>\n<li>Plain <code>two</code></li>\n</ul>"

TWO_LISTS = (
    "<ul>\n"
    '<li><input type="checkbox" disabled> Yes</li>\n'
    '<li><input type="checkbox" disabled> Yes</li>\n'
    "</ul>\n"
    f"{ORDINARY_LIST}\n"
    "<ol>\n"
    '<li><p><input disabled="" type="checkbox"> Yes</p></li>\n'
    '<li><p><input disabled="" type="checkbox"> No</p></li>\n'
    "</ol>\n"
)


class _FormReader(HTMLParser):
    """Read every form in a page: its attributes, controls and label texts."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.forms: list[dict] = []
        self._form: dict | None = None
        self._label: list[str] | None = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "form":
            self._form = {"attrs": attrs, "boxes": [], "textareas": [], "submits": []}
        elif self._form is None:
            return
        elif tag == "label":
            self._label = []
        elif tag == "input":
            box = {"attrs": attrs, "label": self._label}
            self._form["boxes"].append(box)
        elif tag == "textarea":
            self._form["textareas"].append(attrs)
        elif tag == "button" and attrs.get("type") == "submit":
            self._form["submits"].append(attrs)

    def handle_data(self, data):
        if self._label is not None:
            self._label.append(data)

    def handle_endtag(self, tag):
        if tag == "label":
            self._label = None
        elif tag == "form" and self._form is not None:
            for box in self._form["boxes"]:
                box["label"] = " ".join("".join(box["label"] or []).split())
            self.forms.append(self._form)
            self._form = None


def read_forms(page_html: str) -> list[dict]:
    reader = _FormReader()
    reader.feed(page_html)
    reader.close()
    return reader.forms


class FormsTestCase(TempDirTestCase):
    def render_body(self, name: str, body: str, *extra: str) -> str:
        rc, _, err = self.render(name, "--date", "2026-01-02", "--body", body, *extra)
        self.assertEqual(rc, 0, err)
        return (self.out_dir / f"{name}.html").read_text(encoding="utf-8")


class FormMarkupTests(FormsTestCase):
    def test_three_items_render_as_one_form(self):
        page = self.render_body("plan", THREE_ITEMS)
        forms = read_forms(page)
        self.assertEqual(len(forms), 1)
        form = forms[0]
        self.assertEqual(form["attrs"]["class"].split(), ["artifact-form"])
        self.assertEqual(form["attrs"]["data-page"], "plan")
        self.assertEqual(form["attrs"]["data-question"], "q1")
        self.assertRegex(form["attrs"]["data-version"], r"\A[0-9a-f]{12}\Z")

        boxes = form["boxes"]
        self.assertEqual([box["attrs"]["type"] for box in boxes], ["checkbox"] * 3)
        self.assertEqual(
            [box["label"] for box in boxes],
            ["Approve the plan", "Ask Ko & wait", "Ship it"],
        )
        self.assertEqual(
            [box["attrs"]["name"] for box in boxes],
            ["approve-the-plan", "ask-ko-wait", "ship-it"],
        )
        self.assertEqual(
            ["checked" in box["attrs"] for box in boxes], [False, False, True]
        )
        for box in boxes:
            self.assertNotIn("disabled", box["attrs"])

        self.assertEqual([area.get("name") for area in form["textareas"]], ["note"])
        self.assertEqual(len(form["submits"]), 1)
        # The source list is replaced, not kept beside the form.
        self.assertNotIn("disabled", page.split("<form", 1)[1].split("</form>")[0])
        self.assertNotIn("contains-task-list", page)
        self.assertIn("<p>Before the question.</p>\n<form", page)
        self.assertIn("</form>\n<p>After the question.</p>", page)

    def test_label_text_is_escaped_as_content(self):
        body = (
            '<ul><li><input type="checkbox" disabled> '
            "Use &lt;script&gt; &amp; &quot;quotes&quot;</li></ul>"
        )
        page = self.render_body("escape", body)
        self.assertIn("Use &lt;script&gt; &amp; &quot;quotes&quot;</label>", page)
        self.assertEqual(
            read_forms(page)[0]["boxes"][0]["label"], 'Use <script> & "quotes"'
        )

    def test_two_lists_duplicate_texts_and_an_ordinary_list_between(self):
        page = self.render_body("twice", TWO_LISTS)
        forms = read_forms(page)
        self.assertEqual(
            [form["attrs"]["data-question"] for form in forms], ["q1", "q2"]
        )
        self.assertEqual(
            [box["attrs"]["name"] for box in forms[0]["boxes"]], ["yes", "yes-2"]
        )
        self.assertEqual(
            [box["label"] for box in forms[0]["boxes"]], ["Yes", "Yes"]
        )
        self.assertEqual(
            [box["attrs"]["name"] for box in forms[1]["boxes"]], ["yes", "no"]
        )
        self.assertNotEqual(
            forms[0]["attrs"]["data-version"], forms[1]["attrs"]["data-version"]
        )
        self.assertIn(f"</form>\n{ORDINARY_LIST}\n<form", page)

    def test_a_choice_never_takes_the_note_fields_name(self):
        body = '<ul><li><input type="checkbox" disabled> Note</li></ul>'
        form = read_forms(self.render_body("noted", body))[0]
        self.assertEqual([box["attrs"]["name"] for box in form["boxes"]], ["note-2"])

    def test_rewording_that_keeps_the_choice_key_still_changes_the_version(self):
        before = read_forms(self.render_body("twice", TWO_LISTS))
        after = read_forms(self.render_body("twice", TWO_LISTS.replace("> No<", "> No!<")))
        self.assertEqual(
            [box["attrs"]["name"] for box in after[1]["boxes"]], ["yes", "no"]
        )
        self.assertEqual(
            after[0]["attrs"]["data-version"], before[0]["attrs"]["data-version"]
        )
        self.assertNotEqual(
            after[1]["attrs"]["data-version"], before[1]["attrs"]["data-version"]
        )

    def test_rendering_twice_gives_the_same_form(self):
        first = self.render_body("plan", THREE_ITEMS)
        self.assertEqual(self.render_body("plan", THREE_ITEMS), first)


class NoTaskListTests(FormsTestCase):
    def test_page_without_a_task_list_is_byte_identical_to_the_old_renderer(self):
        body = (FIXTURES / "no_task_list.body.html").read_text(encoding="utf-8")
        rc, _, err = self.render(
            "plain", "--title", "Plain Page", "--episode", "3",
            "--date", "2026-01-02", "--summary", "no questions here",
            "--body", body,
        )
        self.assertEqual(rc, 0, err)
        self.assertEqual(
            (self.out_dir / "plain.html").read_bytes(),
            (FIXTURES / "no_task_list.expected.html").read_bytes(),
        )


class ExportDefinitionsTests(FormsTestCase):
    def setUp(self) -> None:
        super().setUp()
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dest_root = Path(tmp.name)

    def export_definitions(self, label: str) -> dict:
        dest = self.dest_root / label
        rc, _, err = run_cli(
            "export", "--out-dir", str(self.out_dir), "--dest", str(dest)
        )
        self.assertEqual(rc, 0, err)
        return json.loads((dest / "_lotuspod" / "forms.json").read_text("utf-8"))

    def test_definitions_name_only_the_visible_page_and_match_the_markup(self):
        page = self.render_body("asked", TWO_LISTS)
        self.render_body("secret", THREE_ITEMS, "--hidden")
        self.render_body("quiet", "<p>Nothing asked.</p>")
        rc, _, err = run_cli("index", "--out-dir", str(self.out_dir))
        self.assertEqual(rc, 0, err)

        definitions = self.export_definitions("first")
        self.assertEqual(set(definitions), {"asked"})
        rendered = {
            form["attrs"]["data-question"]: {
                "version": form["attrs"]["data-version"],
                "choices": [box["attrs"]["name"] for box in form["boxes"]],
            }
            for form in read_forms(page)
        }
        self.assertEqual(set(rendered), {"q1", "q2"})
        self.assertEqual(definitions["asked"], rendered)
        self.assertEqual(definitions["asked"]["q1"]["choices"], ["yes", "yes-2"])
        self.assertNotIn("secret", json.dumps(definitions))

    def test_rewording_one_item_changes_that_version_and_no_other(self):
        self.render_body("asked", TWO_LISTS)
        rc, _, err = run_cli("index", "--out-dir", str(self.out_dir))
        self.assertEqual(rc, 0, err)
        before = self.export_definitions("before")["asked"]

        reworded = re.sub(r"> No<", "> Not yet<", TWO_LISTS)
        self.assertNotEqual(reworded, TWO_LISTS)
        self.render_body("asked", reworded)
        after = self.export_definitions("after")["asked"]

        self.assertEqual(after["q1"], before["q1"])
        self.assertNotEqual(after["q2"]["version"], before["q2"]["version"])
        self.assertEqual(after["q2"]["choices"], ["yes", "not-yet"])


if __name__ == "__main__":
    import unittest

    unittest.main()
