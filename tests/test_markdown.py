"""Test suite for the markdown converter and `lotuspod render --markdown`.

`to_body()` is held byte for byte to the operator's converter, committed
unchanged as tests/fixtures/markdown/reference_md2body.py and run as a
subprocess on each fixture there. The markup is also witnessed by parsing it,
independently of the reference. The fixtures stay in the subset of markdown
both converters handle.

Run from the repo root:

    python -m unittest tests.test_markdown -v
"""

from __future__ import annotations

import io
import os
import subprocess
import sys
import tempfile
import unittest
from html.parser import HTMLParser
from pathlib import Path
from unittest import mock

from tests.test_manifest_v2 import SRC_DIR, TempDirTestCase, run_cli

from lotuspod.markdown import to_body

MARKDOWN_FIXTURES = Path(__file__).parent / "fixtures" / "markdown"
REFERENCE = MARKDOWN_FIXTURES / "reference_md2body.py"
FIXTURE_NAMES = ("headings", "lists", "tables", "quotes", "code", "cut")

VOID = {"br", "hr", "img", "input", "meta", "link"}


class _Node:
    def __init__(self, tag: str, attrs: dict) -> None:
        self.tag, self.attrs = tag, attrs
        self.children: list[_Node | str] = []

    @property
    def elements(self) -> list[_Node]:
        return [c for c in self.children if isinstance(c, _Node)]

    def text(self) -> str:
        return "".join(c if isinstance(c, str) else c.text() for c in self.children)

    def find_all(self, tag: str) -> list[_Node]:
        found = []
        for child in self.elements:
            if child.tag == tag:
                found.append(child)
            found.extend(child.find_all(tag))
        return found


class _TreeBuilder(HTMLParser):
    """Parse a body into a tree of elements and text."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.root = _Node("root", {})
        self.stack = [self.root]

    def handle_starttag(self, tag, attrs):
        node = _Node(tag, dict(attrs))
        self.stack[-1].children.append(node)
        if tag not in VOID:
            self.stack.append(node)

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        assert self.stack[-1].tag == tag, (self.stack[-1].tag, tag)
        self.stack.pop()

    def handle_data(self, data):
        self.stack[-1].children.append(data)


def parse(body: str) -> _Node:
    builder = _TreeBuilder()
    builder.feed(body)
    builder.close()
    assert builder.stack == [builder.root], "unclosed elements"
    return builder.root


def reference_body(path: Path) -> bytes:
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "out.html"
        subprocess.run(
            [sys.executable, str(REFERENCE), str(path), str(out)],
            check=True, capture_output=True, timeout=30,
        )
        return out.read_bytes()


class ReferenceParityTests(unittest.TestCase):
    def test_each_fixture_matches_the_reference_byte_for_byte(self):
        for name in FIXTURE_NAMES:
            with self.subTest(fixture=name):
                path = MARKDOWN_FIXTURES / f"{name}.md"
                self.assertEqual(
                    to_body(path.read_text(encoding="utf-8")).encode("utf-8"),
                    reference_body(path),
                )

    def test_fixtures_hold_the_constructs_they_are_named_for(self):
        def body(name: str) -> _Node:
            return parse(to_body((MARKDOWN_FIXTURES / f"{name}.md").read_text(encoding="utf-8")))

        headings = body("headings")
        for tag in ("h2", "h3", "p", "strong", "code"):
            self.assertTrue(headings.find_all(tag), tag)

        lists = body("lists")
        third = [
            ol for ul in lists.find_all("ul") for li in ul.elements
            for inner in li.elements if inner.tag == "ul"
            for li2 in inner.elements for ol in li2.elements if ol.tag == "ol"
        ]
        self.assertTrue(third, "a list three levels deep mixing - and 1.")
        self.assertIn("continued on an indented line", third[0].text())

        tables = body("tables")
        self.assertTrue(tables.find_all("table"))
        self.assertNotIn("---", tables.text())

        quote = body("quotes").find_all("blockquote")[1]
        for tag in ("pre", "ul", "table"):
            self.assertTrue(quote.find_all(tag), tag)

        code = body("code")
        self.assertTrue([p for p in code.find_all("pre") if p.attrs.get("class") == "mermaid"])
        self.assertTrue([p for p in code.find_all("pre") if p.find_all("code")])

        source = (MARKDOWN_FIXTURES / "cut.md").read_text(encoding="utf-8")
        self.assertEqual(sum(line.startswith("# ") for line in source.split("\n")), 2)
        self.assertIn("\n## Concrete commands\n", source)
        cut = to_body(source)
        self.assertNotIn("Page title", cut)
        self.assertNotIn("Concrete commands", cut)
        self.assertNotIn("writer-host", cut)
        self.assertIn("a published item", cut)


class ParsedBodyTests(unittest.TestCase):
    MARKDOWN = (
        "## Section\n"
        "\n"
        "Some **bold** text and `a&b` here.\n"
        "\n"
        "- outer\n"
        "  - inner\n"
        "\n"
        "| H1 | H2 |\n"
        "|----|----|\n"
        "| a | b |\n"
        "| c | d |\n"
        "\n"
        "```\n"
        "a < b\n"
        "```\n"
        "\n"
        "```mermaid\n"
        "flowchart LR\n"
        "  a --> b\n"
        "```\n"
    )

    def test_parsing_the_body_finds_each_block_in_order(self):
        blocks = parse(to_body(self.MARKDOWN)).elements
        self.assertEqual(
            [b.tag for b in blocks], ["h2", "p", "ul", "table", "pre", "pre"]
        )
        h2, p, ul, table, pre, mermaid = blocks

        self.assertEqual(h2.text(), "Section")
        self.assertEqual([e.tag for e in p.elements], ["strong", "code"])
        self.assertEqual(p.elements[0].text(), "bold")
        self.assertEqual(p.elements[1].text(), "a&b")

        (li,) = ul.elements
        self.assertEqual([e.tag for e in li.elements], ["ul"])
        self.assertEqual(li.elements[0].elements[0].text(), "inner")

        thead, tbody = table.elements
        self.assertEqual((thead.tag, tbody.tag), ("thead", "tbody"))
        self.assertEqual(len(thead.find_all("tr")), 1)
        self.assertEqual(len(tbody.find_all("tr")), 2)

        self.assertNotIn("class", pre.attrs)
        (code,) = pre.elements
        self.assertEqual(code.tag, "code")
        self.assertEqual(code.text(), "a < b")

        self.assertEqual(mermaid.attrs.get("class"), "mermaid")
        self.assertEqual(mermaid.elements, [])
        self.assertEqual(mermaid.text(), "flowchart LR\n  a --> b")


class RenderMarkdownTests(TempDirTestCase):
    MARKDOWN = "# Title line\n\n## One\n\nA paragraph with `code` & **bold**.\n\n## Two\n\n- item\n"
    COMMON = ("--date", "2026-01-02")

    def page(self, name: str) -> bytes:
        return (self.out_dir / f"{name}.html").read_bytes()

    def test_markdown_file_and_stdin_render_the_same_page_as_the_converted_body(self):
        md = self.out_dir / "page.md"
        md.write_text(self.MARKDOWN, encoding="utf-8")

        rc, _, err = run_cli(
            "render", "--name", "n", "--title", "T", "--out-dir", str(self.out_dir),
            "--body", to_body(self.MARKDOWN), *self.COMMON,
        )
        self.assertEqual(rc, 0, err)
        expected = self.page("n")

        rc, _, err = run_cli(
            "render", "--markdown", str(md), "--name", "n", "--title", "T",
            "--out-dir", str(self.out_dir), *self.COMMON,
        )
        self.assertEqual(rc, 0, err)
        self.assertEqual(self.page("n"), expected)

        with mock.patch("sys.stdin", io.StringIO(self.MARKDOWN)):
            rc, _, err = run_cli(
                "render", "--markdown", "-", "--name", "n", "--title", "T",
                "--out-dir", str(self.out_dir), *self.COMMON,
            )
        self.assertEqual(rc, 0, err)
        self.assertEqual(self.page("n"), expected)

    def test_a_body_larger_than_the_command_line_renders_in_a_subprocess(self):
        paragraph = "A line of prose that repeats to make the page large & long. " * 4
        md = self.out_dir / "big.md"
        md.write_text("\n\n".join([paragraph] * 2000), encoding="utf-8")
        self.assertGreater(len(to_body(md.read_text(encoding="utf-8")).encode("utf-8")), 256 * 1024)

        proc = subprocess.run(
            [sys.executable, "-m", "lotuspod", "render", "--markdown", str(md),
             "--name", "big", "--title", "Big", "--out-dir", str(self.out_dir)],
            capture_output=True, text=True, timeout=60,
            env=dict(os.environ, PYTHONPATH=str(SRC_DIR)), cwd=str(self.out_dir),
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        page = self.page("big").decode("utf-8")
        self.assertEqual(page.count("<p>A line of prose"), 2000)

    def test_markdown_with_body_is_a_usage_error(self):
        md = self.out_dir / "page.md"
        md.write_text(self.MARKDOWN, encoding="utf-8")
        with self.assertRaises(SystemExit) as caught:
            run_cli(
                "render", "--markdown", str(md), "--body", "<p>x</p>",
                "--name", "n", "--title", "T", "--out-dir", str(self.out_dir),
            )
        self.assertEqual(caught.exception.code, 2)
        self.assertFalse((self.out_dir / "n.html").exists())

    def test_a_missing_markdown_path_exits_1_naming_it(self):
        missing = self.out_dir / "absent.md"
        rc, _, err = run_cli(
            "render", "--markdown", str(missing), "--name", "n", "--title", "T",
            "--out-dir", str(self.out_dir),
        )
        self.assertEqual(rc, 1)
        self.assertIn(str(missing), err)
        self.assertFalse((self.out_dir / "n.html").exists())


if __name__ == "__main__":
    unittest.main()
