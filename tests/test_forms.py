"""Test suite for task lists: a task list in a page body renders as the plain
list it was written as, with no form and no script. Beside the pages, serve
answers the packaged page script decision forms load.

The markup is witnessed by parsing it, never by matching strings. A page
without a task list is held byte for byte to tests/fixtures/
no_task_list.expected.html, captured from the renderer as it stood before
forms existed and re-captured with the page policy tag (it names the theme
version, so a theme bump re-captures it).

Run from the repo root:

    python -m unittest tests.test_forms -v
"""

from __future__ import annotations

import threading
import urllib.request
from html.parser import HTMLParser
from pathlib import Path
from unittest import mock

from tests.test_manifest_v2 import TempDirTestCase

from lotuspod import cli  # after test_manifest_v2, which puts src/ on the path

FIXTURES = Path(__file__).parent / "fixtures"

TWO_ITEMS = (
    "<p>Before the list.</p>\n"
    '<ul class="contains-task-list">\n'
    '<li class="task-list-item"><input type="checkbox" disabled> Approve the plan</li>\n'
    '<li class="task-list-item"><input type="checkbox" disabled checked> Ship it</li>\n'
    "</ul>\n"
    "<p>After the list.</p>\n"
)


class _PageReader(HTMLParser):
    """Read a page's forms, scripts and every list item with its inputs."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.forms = 0
        self.scripts = 0
        self.lists: list[dict] = []
        self._item: dict | None = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "form":
            self.forms += 1
        elif tag == "script":
            self.scripts += 1
        elif tag in ("ul", "ol"):
            self.lists.append({"tag": tag, "attrs": attrs, "items": []})
        elif tag == "li" and self.lists:
            self._item = {"inputs": [], "text": []}
            self.lists[-1]["items"].append(self._item)
        elif tag == "input" and self._item is not None:
            self._item["inputs"].append(attrs)

    def handle_data(self, data):
        if self._item is not None:
            self._item["text"].append(data)

    def handle_endtag(self, tag):
        if tag == "li" and self._item is not None:
            self._item["text"] = " ".join("".join(self._item["text"]).split())
            self._item = None


def read_page(page_html: str) -> _PageReader:
    reader = _PageReader()
    reader.feed(page_html)
    reader.close()
    return reader


class FormsTestCase(TempDirTestCase):
    def render_body(self, name: str, body: str, *extra: str) -> str:
        rc, _, err = self.render(name, "--date", "2026-01-02", "--body", body, *extra)
        self.assertEqual(rc, 0, err)
        return (self.out_dir / f"{name}.html").read_text(encoding="utf-8")


class TaskListTests(FormsTestCase):
    def test_a_task_list_renders_as_the_plain_list_written(self):
        page = self.render_body("plan", TWO_ITEMS)
        reader = read_page(page)
        self.assertEqual(reader.forms, 0)
        self.assertEqual(reader.scripts, 0)

        task_lists = [
            found for found in reader.lists
            if "contains-task-list" in found["attrs"].get("class", "").split()
        ]
        self.assertEqual(len(task_lists), 1)
        found = task_lists[0]
        self.assertEqual(found["tag"], "ul")
        self.assertEqual(
            [item["text"] for item in found["items"]], ["Approve the plan", "Ship it"]
        )
        boxes = [item["inputs"] for item in found["items"]]
        self.assertEqual([len(inputs) for inputs in boxes], [1, 1])
        for (box,) in boxes:
            self.assertEqual(box["type"], "checkbox")
            self.assertIn("disabled", box)
            self.assertNotIn("name", box)
        self.assertEqual(["checked" in box for (box,) in boxes], [False, True])


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


class PageScriptTests(FormsTestCase):
    def test_serve_answers_the_page_script_and_a_plain_page_is_unchanged(self):
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

        patcher = mock.patch.object(cli._AllowListHandler, "log_message", lambda *a: None)
        patcher.start()
        self.addCleanup(patcher.stop)
        server = cli._make_server(self.out_dir, "127.0.0.1", 0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        url = f"http://127.0.0.1:{server.server_address[1]}/{cli.PAGE_SCRIPT}"
        with urllib.request.urlopen(url, timeout=5) as response:
            self.assertEqual(response.status, 200)
            served = response.read()
        self.assertEqual(served, (cli.THEME_DIR / "lotuspod-page.js").read_bytes())


if __name__ == "__main__":
    import unittest

    unittest.main()
