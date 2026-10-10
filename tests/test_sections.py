"""Test suite for folding sections: render wraps the content of each h2
section of a page with an outline in one `div.artifact-section-body`, after
the comment boxes are placed, so the page script can fold it under its
heading. Any other page is left as it was.

The markup is witnessed by parsing it, never by matching strings.

Run from the repo root:

    python -m unittest tests.test_sections -v
"""

from __future__ import annotations

import io
import os
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from html.parser import HTMLParser
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

from lotuspod import cli, sections  # noqa: E402

WRAPPER = "artifact-section-body"
VOID = {"br", "img", "input", "hr", "wbr", "source", "col", "area", "embed", "track", "meta",
        "link"}

# An intro, then three sections: an h2 in the first section's diagram and
# one in the third's form start none.
THREE_SECTIONS = """\
<p>Before any section.</p>
<h2>Findings</h2>
<p>The pond freezes.</p>
<pre class="mermaid">graph LR
  A["<h2>Not a heading</h2>"] --> B</pre>
<h2>Decisions for the maintainer</h2>
<table>
<thead><tr><th>#</th><th>Question</th><th>Options</th><th>Default</th></tr></thead>
<tbody>
<tr><td>1</td><td>Which heater?</td><td>Electric / Solar</td><td>Electric</td></tr>
</tbody>
</table>
<h2>Next steps</h2>
<form><h2>Inside a form</h2><p>x</p></form>
<p>Fit a heater.</p>
"""


def run_cli(*argv: str) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        rc = cli.main(list(argv))
    return rc, out.getvalue(), err.getvalue()


class _Body(HTMLParser):
    """A page's body as a tree of elements, plus the page's scripts."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root: dict | None = None
        self.scripts: list[str] = []
        self._stack: list[dict] = []

    def handle_starttag(self, tag, attrs):
        attrs = {key: value or "" for key, value in attrs}
        if tag == "script":
            self.scripts.append(attrs.get("src", ""))
        node = {"tag": tag, "attrs": attrs, "children": [], "text": []}
        if not self._stack:
            if tag == "section" and "artifact-body" in attrs.get("class", "").split():
                self.root = node
                self._stack.append(node)
            return
        self._stack[-1]["children"].append(node)
        if tag not in VOID:
            self._stack.append(node)

    def handle_data(self, data):
        for node in self._stack:
            node["text"].append(data)

    def handle_endtag(self, tag):
        if self._stack and tag not in VOID:
            self._stack.pop()


def read(page_html: str) -> _Body:
    body = _Body()
    body.feed(page_html)
    body.close()
    return body


def walk(node: dict):
    for child in node["children"]:
        yield child
        yield from walk(child)


def is_wrapper(node: dict) -> bool:
    return node["tag"] == "div" and WRAPPER in node["attrs"].get("class", "").split()


class SectionsTestCase(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.out_dir = Path(tmp.name) / "artifacts"
        env = mock.patch.dict(os.environ, {"LOTUSPOD_CONFIG": str(Path(tmp.name) / "none.ini")})
        env.start()
        self.addCleanup(env.stop)

    def render(self, name: str, body: str, *extra: str) -> _Body:
        rc, _, err = run_cli("render", "--name", name, "--title", name.title(),
                             "--date", "2026-01-02", "--body", body,
                             "--out-dir", str(self.out_dir), *extra)
        self.assertEqual(rc, 0, err)
        return read((self.out_dir / f"{name}.html").read_text(encoding="utf-8"))


class WrappedTests(SectionsTestCase):
    def test_each_section_sits_in_one_wrapper_after_its_heading(self):
        page = self.render("plan", THREE_SECTIONS, "--comments")
        top = page.root["children"]
        self.assertEqual([node["tag"] for node in top],
                         ["p", "h2", "div", "h2", "div", "h2", "div"])
        self.assertEqual("".join(top[0]["text"]), "Before any section.")
        headings, wrappers = top[1::2], top[2::2]
        self.assertEqual([h["attrs"]["id"] for h in headings],
                         ["findings", "decisions-for-the-maintainer", "next-steps"])
        for heading, wrapper in zip(headings, wrappers):
            with self.subTest(section=heading["attrs"]["id"]):
                self.assertTrue(is_wrapper(wrapper))
                self.assertEqual(wrapper["attrs"]["data-section"], heading["attrs"]["id"])
                self.assertNotIn("hidden", wrapper["attrs"])
                self.assertNotIn("id", wrapper["attrs"])
                # Its comment box ends it.
                box = wrapper["children"][-1]
                self.assertEqual(box["tag"], "details")
                self.assertEqual(box["attrs"]["data-section"], heading["attrs"]["id"])
                # The heading holds no wrapper.
                self.assertFalse(any(is_wrapper(node) for node in walk(heading)))

        findings, decisions, steps = ([c["tag"] for c in w["children"]] for w in wrappers)
        self.assertEqual(findings, ["p", "pre", "details"])
        self.assertEqual(decisions, ["div", "details"])
        self.assertEqual(steps, ["form", "p", "details"])
        # The diagram's h2 and the form's start no wrapper: every wrapper is
        # a direct child of the body, and there are three.
        self.assertEqual(sum(is_wrapper(node) for node in walk(page.root)), 3)
        self.assertIn("Not a heading", "".join(wrappers[0]["text"]))
        self.assertIn("Inside a form", "".join(wrappers[2]["text"]))
        # The decision form sits in its section.
        forms = [node for node in walk(wrappers[1]) if node["tag"] == "form"
                 and "artifact-decision" in node["attrs"].get("class", "").split()]
        self.assertEqual([f["attrs"]["data-question"] for f in forms], ["decision-1"])
        self.assertEqual([src.split("?")[0] for src in page.scripts if src], [cli.PAGE_SCRIPT])

    def test_a_page_without_comments_is_wrapped_and_loads_the_script(self):
        page = self.render("plain", "<h2>A</h2>\n<p>a</p>\n<h2>B</h2>\n<p>b</p>\n")
        top = page.root["children"]
        self.assertEqual([node["tag"] for node in top], ["h2", "div", "h2", "div"])
        self.assertEqual([w["attrs"]["data-section"] for w in top[1::2]], ["a", "b"])
        self.assertEqual([src.split("?")[0] for src in page.scripts if src], [cli.PAGE_SCRIPT])


class UnwrappedTests(SectionsTestCase):
    def test_pages_without_top_level_sections_hold_no_wrapper(self):
        cases = {
            "none": ("<p>Only prose.</p>",),
            "one": ("<h2>Only</h2><p>x</p>", "--comments"),
            "flat": ("<h2>A</h2><p>a</p><h2>B</h2><p>b</p>", "--no-outline"),
            "nested": ("<section><h2>A</h2><p>a</p></section>"
                       "<section><h2>B</h2><p>b</p></section>",),
        }
        for name, (body, *extra) in cases.items():
            with self.subTest(case=name):
                # Not listed: a listed page loads the page script to open in
                # the index's tabs.
                page = self.render(name, body, *extra, "--hidden")
                self.assertFalse(any(is_wrapper(node) for node in walk(page.root)))
                self.assertNotIn(WRAPPER, (self.out_dir / f"{name}.html").read_text())
                # Only the comment box loads the page script.
                loaded = cli.PAGE_SCRIPT in [src.split("?")[0] for src in page.scripts]
                self.assertEqual(loaded, "--comments" in extra)


class WrapSectionsTests(unittest.TestCase):
    def test_the_authors_bytes_are_kept(self):
        body = '<p>Intro &amp; more</p>\n<H2 ID="a"  class=x>A</H2>\n<p>a<br>b</p>\n<h2 id="b">B</h2>tail'
        wrapped, done = sections.wrap_sections(body)
        self.assertTrue(done)
        self.assertEqual(
            wrapped,
            '<p>Intro &amp; more</p>\n<H2 ID="a"  class=x>A</H2>\n'
            '<div class="artifact-section-body" data-section="a">\n<p>a<br>b</p>\n</div>\n'
            '<h2 id="b">B</h2>\n<div class="artifact-section-body" data-section="b">tail\n</div>\n',
        )

    def test_any_heading_off_the_top_level_or_without_an_id_wraps_nothing(self):
        for body in (
            '<h2 id="a">A</h2><p>a</p><div><h2 id="b">B</h2></div>',
            '<h2 id="a">A</h2><p>a</p><h2>B</h2>',
            '<p>open<h2 id="a">A</h2><h2 id="b">B</h2>',
            '<h2 id="a">A<h2 id="b">B</h2>',
        ):
            with self.subTest(body=body):
                self.assertEqual(sections.wrap_sections(body), (body, False))

    def test_void_elements_and_stray_end_tags_keep_the_depth(self):
        body = ('<p>a<img src="x.png"><br/><input type="checkbox"></p></span>\n'
                '<h2 id="a">A</h2><hr><h2 id="b">B</h2>')
        _, done = sections.wrap_sections(body)
        self.assertTrue(done)


if __name__ == "__main__":
    unittest.main()
