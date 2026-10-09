"""Test suite for the markdown converter and `lotuspod render --markdown`.

`to_body()` is held byte for byte to the operator's converter, committed
unchanged as tests/fixtures/markdown/reference_md2body.py and run as a
subprocess on each fixture there. The markup is also witnessed by parsing it,
independently of the reference. The six fixtures stay in the subset of markdown
both converters handle.

The image line (`![ALT](SRC)` alone on a line) is a Lotuspod-only extension
outside the reference's subset, so it is held by parsed-tree tests instead,
plus one parity check that it disturbs nothing around it: the images fixture
matches the reference once each image line in its source is emptied (in its
blockquote, when it is quoted) and each figure is taken out of the body.

Inline links (`[TEXT](TARGET)`) are Lotuspod's own too, and none of the
fixtures holds one: they are held by parsed-tree tests, on converted bodies and
on pages published with the real `lotuspod publish --local`, the repository's
README and docs among them. So are bare http(s) URLs, which no fixture holds
either.

Run from the repo root:

    python -m unittest tests.test_markdown -v
"""

from __future__ import annotations

import html
import io
import os
import re
import subprocess
import sys
import tempfile
import unittest
from html.parser import HTMLParser
from pathlib import Path
from unittest import mock

from tests.test_manifest_v2 import SRC_DIR, TempDirTestCase, run_cli

from lotuspod import cli, media
from lotuspod.markdown import images, to_body, with_sources

ROOT = Path(__file__).resolve().parents[1]
MARKDOWN_FIXTURES = Path(__file__).parent / "fixtures" / "markdown"
REFERENCE = MARKDOWN_FIXTURES / "reference_md2body.py"
FIXTURE_NAMES = ("headings", "lists", "tables", "quotes", "code", "cut")
IMAGES_FIXTURE = MARKDOWN_FIXTURES / "images.md"
MEDIA_FIXTURES = Path(__file__).parent / "fixtures" / "media"
# A figure and the one newline joining it to the blocks beside it.
_FIGURE = r'<figure class="artifact-figure">.*?</figure>'
FIGURE_BLOCK = re.compile(rf"{_FIGURE}\n|\n{_FIGURE}|{_FIGURE}")

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


def text_outside_code(node: _Node) -> str:
    """node's text, leaving out what is inside code and pre elements."""
    return "".join(
        c if isinstance(c, str) else "" if c.tag in ("code", "pre") else text_outside_code(c)
        for c in node.children
    )


def media_url(digit: str, extension: str) -> str:
    return f"/media/{digit * 64}.{extension}"


# The sizes of the images the images fixture names.
FIXTURE_SIZES = {
    media_url("1", "png"): (1600, 600),
    media_url("2", "jpg"): (320, 240),
    media_url("3", "webp"): (240, 160),
    media_url("4", "gif"): (140, 100),
}


def without_image_lines(text: str) -> str:
    """text with each image line emptied, keeping a quoted one's markers."""
    lines = text.split("\n")
    for image in images(text):
        lines[image.line] = re.match(r"(?: {0,3}>)*", lines[image.line]).group(0)
    return "\n".join(lines)


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


class ImageParityTests(unittest.TestCase):
    def test_the_images_fixture_matches_the_reference_without_its_images(self):
        source = IMAGES_FIXTURE.read_text(encoding="utf-8")
        body = to_body(source, FIXTURE_SIZES)
        self.assertEqual(body.count('<figure class="artifact-figure">'), 4)

        with tempfile.TemporaryDirectory() as tmp:
            emptied = Path(tmp) / "images.md"
            emptied.write_text(without_image_lines(source), encoding="utf-8")
            expected = reference_body(emptied)
        self.assertEqual(FIGURE_BLOCK.sub("", body).encode("utf-8"), expected)


class ImageLineTests(unittest.TestCase):
    URL = media_url("a", "png")

    def body(self, text: str, sizes: dict | None = None) -> _Node:
        return parse(to_body(text, sizes or {self.URL: (640, 480)}))

    def assertFigure(self, node: _Node, src: str, alt: str, size: tuple[int, int]) -> None:
        self.assertEqual((node.tag, node.attrs), ("figure", {"class": "artifact-figure"}))
        (link,) = node.elements
        self.assertEqual((link.tag, link.attrs), ("a", {"href": src}))
        (img,) = link.elements
        self.assertEqual(img.tag, "img")
        self.assertEqual(img.attrs, {"src": src, "alt": alt, "loading": "lazy",
                                     "width": str(size[0]), "height": str(size[1])})

    def test_the_fixture_draws_each_image_line_as_a_linked_lazy_figure(self):
        source = IMAGES_FIXTURE.read_text(encoding="utf-8")
        root = parse(to_body(source, FIXTURE_SIZES))
        figures = root.find_all("figure")
        alts = ["A wide chart", "A photo of the pond", "A lily", "A quoted frog"]
        self.assertEqual(len(figures), 4)
        for figure, (src, size), alt in zip(figures, FIXTURE_SIZES.items(), alts):
            with self.subTest(alt=alt):
                self.assertFigure(figure, src, alt, size)
        quoted = root.find_all("blockquote")[0]
        self.assertEqual([e.tag for e in quoted.elements], ["p", "figure", "p"])
        self.assertEqual([i.src for i in images(source)], list(FIXTURE_SIZES))

    def test_an_image_line_between_paragraph_lines_splits_the_paragraph(self):
        blocks = self.body(f"First line.\n![Chart]({self.URL})\nSecond line.\n").elements
        self.assertEqual([b.tag for b in blocks], ["p", "figure", "p"])
        self.assertEqual(blocks[0].text(), "First line.")
        self.assertFigure(blocks[1], self.URL, "Chart", (640, 480))
        self.assertEqual(blocks[2].text(), "Second line.")

    def test_the_alt_text_is_escaped_in_its_attribute(self):
        alt = 'Pump "A" < pump B & C'
        body = to_body(f"![{alt}]({self.URL})\n", {self.URL: (640, 480)})
        self.assertIn('alt="Pump &quot;A&quot; &lt; pump B &amp; C"', body)
        self.assertEqual(parse(body).find_all("img")[0].attrs["alt"], alt)

    def test_image_lines_in_a_fence_a_paragraph_a_list_a_table_or_after_the_cut_stay_text(self):
        source = IMAGES_FIXTURE.read_text(encoding="utf-8")
        root = parse(to_body(source, FIXTURE_SIZES))
        self.assertNotIn("chart.png", [img.attrs["src"] for img in root.find_all("img")])
        self.assertNotIn("chart.png", [i.src for i in images(source)])

        (pre,) = root.find_all("pre")
        self.assertEqual(pre.text(), "![in a code fence](chart.png)")
        paragraphs = [p.text() for p in root.find_all("p")]
        self.assertIn("See ![an inline image](chart.png) inside a paragraph line.", paragraphs)
        items = [li.text() for li in root.find_all("li")]
        self.assertIn("![in a list item](chart.png) ![in a continued list item](chart.png)",
                      items)
        cells = [td.text() for td in root.find_all("td")]
        self.assertIn("![in a cell](chart.png)", cells)
        self.assertNotIn("after the cut", root.text())
        self.assertIn("![after the cut](chart.png)", source)

    def test_an_image_line_without_a_size_is_refused(self):
        with self.assertRaises(ValueError):
            to_body(f"![Chart]({self.URL})\n", {})

    def test_with_sources_rewrites_only_the_references_named(self):
        text = "Intro.\r\n![A](a.png)\r\n> > ![B](b/b.png)  \r\n![C](c.png)\r\n"
        found = images(text.replace("\r\n", "\n"))
        self.assertEqual([(i.line, i.alt, i.src) for i in found],
                         [(1, "A", "a.png"), (2, "B", "b/b.png"), (3, "C", "c.png")])
        rewritten = with_sources(text, {found[0]: "/media/x.png", found[1]: "/media/y.png"})
        self.assertEqual(
            rewritten,
            "Intro.\r\n![A](/media/x.png)\r\n> > ![B](/media/y.png)  \r\n![C](c.png)\r\n",
        )


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


class LinkTests(unittest.TestCase):
    def body(self, text: str) -> _Node:
        return parse(to_body(text))

    def assertLink(self, node: _Node, href: str, text: str) -> None:
        self.assertEqual((node.tag, node.attrs, node.text()), ("a", {"href": href}, text))

    def test_anchor_and_http_targets_are_links_with_the_query_escaped_once(self):
        source = (
            "To [the part](#anchor), [the query](https://example.com/a?b=1&c=2) "
            "and [the site](http://example.com).\n"
        )
        body = to_body(source)
        self.assertIn('href="https://example.com/a?b=1&amp;c=2"', body)
        (p,) = parse(body).elements
        anchor, query, site = p.elements
        self.assertLink(anchor, "#anchor", "the part")
        self.assertLink(query, "https://example.com/a?b=1&c=2", "the query")
        self.assertLink(site, "http://example.com", "the site")
        self.assertEqual(p.text(), "To the part, the query and the site.")

    def test_a_target_with_any_other_scheme_stays_the_escaped_text(self):
        for target in ("javascript:alert(1)", "JaVaScRiPt:x", "data:text/html,x",
                       "mailto:a@example.com", "//example.com/x", "vbscript:x"):
            with self.subTest(target=target):
                source = f"A <b> & [link]({target}) here."
                body = to_body(source + "\n")
                self.assertEqual(body, f"<p>{html.escape(source, quote=False)}</p>\n")
                (paragraph,) = parse(body).elements
                self.assertEqual(paragraph.find_all("a"), [])
                self.assertEqual(paragraph.text(), source)

    def test_links_in_a_code_span_a_fence_an_image_reference_or_after_the_cut_stay_text(self):
        source = (
            "A span `[in code](a.md)` here.\n"
            "\n"
            "```\n"
            "[in a fence](a.md)\n"
            "```\n"
            "\n"
            "See ![an inline image](chart.png) inside a paragraph line.\n"
            "\n"
            "## Concrete commands\n"
            "\n"
            "[after the cut](a.md)\n"
        )
        root = self.body(source)
        self.assertEqual(root.find_all("a"), [])
        self.assertEqual(root.find_all("img"), [])
        self.assertEqual([c.text() for c in root.find_all("code")],
                         ["[in code](a.md)", "[in a fence](a.md)"])
        paragraphs = [p.text() for p in root.find_all("p")]
        self.assertIn("See ![an inline image](chart.png) inside a paragraph line.", paragraphs)
        self.assertNotIn("after the cut", root.text())

    def test_bold_around_a_link_and_inside_one(self):
        (outer, inner) = self.body("**[bold link](a.md)**\n\n[**bold** text](a.md)\n").elements

        (strong,) = outer.elements
        self.assertEqual(strong.tag, "strong")
        (link,) = strong.elements
        self.assertLink(link, "a.md", "bold link")

        (link,) = inner.elements
        self.assertLink(link, "a.md", "bold text")
        self.assertEqual([(e.tag, e.text()) for e in link.elements], [("strong", "bold")])

    def test_link_text_may_hold_a_code_span(self):
        (p,) = self.body("See [`deploy/README.md`](../deploy/README.md).\n").elements
        (link,) = p.elements
        self.assertLink(link, "../deploy/README.md", "deploy/README.md")
        self.assertEqual([e.tag for e in link.elements], ["code"])


    def test_link_text_may_hold_an_opening_bracket(self):
        (p,) = self.body("[Press the [ key](other.md#part) now.\n").elements
        (link,) = p.elements
        self.assertLink(link, "other.md#part", "Press the [ key")
        self.assertEqual(p.text(), "Press the [ key now.")

    def test_an_image_reference_with_a_bracket_in_its_alt_stays_text(self):
        source = "See ![Press the [ key](chart.png) in prose."
        body = to_body(source + "\n")
        self.assertEqual(body, f"<p>{source}</p>\n")
        (p,) = parse(body).elements
        self.assertEqual((p.elements, p.text()), ([], source))

class BareUrlTests(unittest.TestCase):
    def body(self, text: str) -> _Node:
        return parse(to_body(text))

    def assertLink(self, node: _Node, href: str, text: str) -> None:
        self.assertEqual((node.tag, node.attrs, node.text()), ("a", {"href": href}, text))

    def test_trailing_punctuation_and_unpaired_brackets_stay_text_after_the_link(self):
        cases = [
            ("See https://example.com/a.", "https://example.com/a", "See ", "."),
            ("(see https://example.com/b)", "https://example.com/b", "(see ", ")"),
            ("https://example.com/c, then", "https://example.com/c", "", ", then"),
            ("https://example.com/d;", "https://example.com/d", "", ";"),
            ("https://example.com/e:", "https://example.com/e", "", ":"),
            ("https://en.wikipedia.org/wiki/Pond_(water)",
             "https://en.wikipedia.org/wiki/Pond_(water)", "", ""),
            ("<https://example.com/f>", "https://example.com/f", "<", ">"),
        ]
        for source, href, before, after in cases:
            with self.subTest(source=source):
                (p,) = self.body(source + "\n").elements
                (link,) = p.elements
                self.assertLink(link, href, href)
                self.assertEqual(p.children, [c for c in (before, link, after) if c])

    def test_urls_in_code_a_fence_a_link_or_an_image_reference_are_not_linked_again(self):
        source = (
            "A span `https://example.com/code` here.\n"
            "\n"
            "```\n"
            "https://example.com/fence\n"
            "```\n"
            "\n"
            "See [https://example.com/g](https://example.com/g) now.\n"
            "\n"
            "See ![chart](https://example.com/chart.png) inside a paragraph line.\n"
        )
        span, fence, linked, image = self.body(source).elements
        self.assertEqual(span.find_all("a"), [])
        self.assertEqual([c.text() for c in span.elements], ["https://example.com/code"])
        self.assertEqual(fence.find_all("a"), [])
        self.assertEqual(fence.text(), "https://example.com/fence")
        (link,) = linked.find_all("a")
        self.assertLink(link, "https://example.com/g", "https://example.com/g")
        self.assertEqual(link.elements, [])
        self.assertEqual(image.find_all("a"), [])
        self.assertEqual(image.text(),
                         "See ![chart](https://example.com/chart.png) inside a paragraph line.")

    def test_a_query_upper_case_and_bold_link_and_other_schemes_stay_text(self):
        source = "https://example.com/q?a=1&b=2 HTTPS://EXAMPLE.COM/U **https://example.com/bold**"
        body = to_body(source + "\n")
        self.assertIn('href="https://example.com/q?a=1&amp;b=2"', body)
        (p,) = parse(body).elements
        query, upper, strong = p.elements
        self.assertLink(query, "https://example.com/q?a=1&b=2", "https://example.com/q?a=1&b=2")
        self.assertLink(upper, "HTTPS://EXAMPLE.COM/U", "HTTPS://EXAMPLE.COM/U")
        self.assertEqual(strong.tag, "strong")
        (link,) = strong.elements
        self.assertLink(link, "https://example.com/bold", "https://example.com/bold")
        for text in ("javascript:alert(1)", "ftp://example.com/x", "https://",
                     "xhttps://example.com/x", "/https://example.com/x", "https://."):
            with self.subTest(text=text):
                body = to_body(f"See {text} here.\n")
                self.assertEqual(body, f"<p>See {text} here.</p>\n")

    def test_a_star_at_the_end_stays_in_the_url(self):
        (p,) = self.body("Search https://example.com/find* now.\n").elements
        (link,) = p.elements
        self.assertLink(link, "https://example.com/find*", "https://example.com/find*")
        self.assertEqual(p.text(), "Search https://example.com/find* now.")

    def test_a_refused_link_and_an_image_reference_with_parentheses_stay_text_whole(self):
        for source in ("[https://example.com/refused](mailto:a@x)",
                       "[https://example.com/refused](javascript:alert(1))",
                       "See ![chart](https://example.com/chart_(pond).png) now."):
            with self.subTest(source=source):
                body = to_body(source + "\n")
                self.assertEqual(body, f"<p>{source}</p>\n")
                (p,) = parse(body).elements
                self.assertEqual((p.elements, p.text()), ([], source))


class PublishedLinkTests(TempDirTestCase):
    def publish(self, source: Path) -> str:
        """The body of the page the real `lotuspod publish --local` makes of
        source, with no operator config in reach."""
        out = self.out_dir / "site"
        proc = subprocess.run(
            [sys.executable, "-m", "lotuspod", "publish", str(source), "--local",
             "--out-dir", str(out), "--date", "2026-01-02"],
            capture_output=True, text=True, timeout=60, cwd=str(self.out_dir),
            env=dict(os.environ, PYTHONPATH=str(SRC_DIR),
                     LOTUSPOD_CONFIG=str(self.out_dir / "missing.ini"),
                     XDG_CONFIG_HOME=str(self.out_dir), HOME=str(self.out_dir)),
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        name = source.name.split(".")[0]
        page = (out / f"{name}.html").read_text(encoding="utf-8")
        found = re.search(r'<section class="artifact-body">(.*?)</section>', page, re.DOTALL)
        return found.group(1)

    def test_a_relative_link_in_a_paragraph_a_list_item_a_table_cell_and_a_blockquote(self):
        md = self.out_dir / "page.md"
        md.write_text(
            "# Links\n"
            "\n"
            "In a [paragraph](other.md#part).\n"
            "\n"
            "- In a [list item](other.md#part)\n"
            "\n"
            "| Where | Link |\n"
            "|-------|------|\n"
            "| cell | [table cell](other.md#part) |\n"
            "\n"
            "> In a [blockquote](other.md#part).\n",
            encoding="utf-8",
        )
        root = parse(self.publish(md))
        links = root.find_all("a")
        self.assertEqual([(a.attrs, a.text()) for a in links], [
            ({"href": "other.md#part"}, text)
            for text in ("paragraph", "list item", "table cell", "blockquote")
        ])
        self.assertEqual(root.find_all("p")[0].elements, [links[0]])
        self.assertEqual(root.find_all("li")[0].elements, [links[1]])
        self.assertEqual(root.find_all("td")[1].elements, [links[2]])
        self.assertEqual(root.find_all("blockquote")[0].find_all("a"), [links[3]])
        self.assertNotIn("](", root.text())

    def test_a_bare_url_in_a_paragraph_a_list_item_a_table_cell_and_a_blockquote(self):
        url = "https://example.com/plans/product.html"
        md = self.out_dir / "page.md"
        md.write_text(
            "# Bare URLs\n"
            "\n"
            f"In a paragraph {url}\n"
            "\n"
            f"- {url}\n"
            "\n"
            "| Where | Link |\n"
            "|-------|------|\n"
            f"| cell | {url} |\n"
            "\n"
            f"> {url}\n",
            encoding="utf-8",
        )
        root = parse(self.publish(md))
        links = root.find_all("a")
        self.assertEqual([(a.attrs, a.text()) for a in links], [({"href": url}, url)] * 4)
        self.assertEqual(root.find_all("p")[0].elements, [links[0]])
        self.assertEqual(root.find_all("li")[0].elements, [links[1]])
        self.assertEqual(root.find_all("td")[1].elements, [links[2]])
        self.assertEqual(root.find_all("blockquote")[0].find_all("a"), [links[3]])

    def test_the_readme_and_docs_leave_no_link_syntax_outside_code(self):
        sources = [ROOT / "README.md", *sorted((ROOT / "docs").glob("*.md"))]
        names = {path.name for path in sources}
        self.assertLessEqual({"README.md", "agents.md", "comments.md", "development.md",
                              "operating.md", "publishing.md"}, names)
        for source in sources:
            with self.subTest(source=source.name):
                root = parse(self.publish(source))
                self.assertTrue(root.find_all("a"))
                self.assertNotIn("](", text_outside_code(root))


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

    def test_a_page_with_a_link_loads_the_page_script_and_one_without_does_not(self):
        """A page with no headings, comments, decisions or revision still
        loads the page script when its body holds a link, however written,
        so the script can open one off the site in a new tab."""
        markdown = (
            ("bare", "See https://example.com/x for more.\n", True),
            ("linked", "See [the site](http://example.com/) for more.\n", True),
            ("relative", "See [the part](other.md#part) or [the top](#top).\n", True),
            ("none", "No links at all, only https: as a word.\n", False),
        )
        html_bodies = (
            ("protocol", '<p><a href="//example.com/body">elsewhere</a></p>\n', True),
            ("entity", '<p><a href="https&#58;//example.com/body">elsewhere</a></p>\n', True),
            ("upper", "<p><A HREF='/\\example.com/body'>elsewhere</A></p>\n", True),
            ("anchorless", '<p><a name="x">no href</a></p>\n', False),
        )
        cases = [(name, ("--markdown", "-"), source, loads) for name, source, loads in markdown]
        cases += [(name, ("--body", body), "", loads) for name, body, loads in html_bodies]
        for name, given, stdin, loads in cases:
            with self.subTest(name=name):
                with mock.patch("sys.stdin", io.StringIO(stdin)):
                    rc, _, err = run_cli(
                        "render", *given, "--name", name, "--title", "T",
                        "--out-dir", str(self.out_dir), *self.COMMON,
                    )
                self.assertEqual(rc, 0, err)
                page = self.page(name).decode("utf-8")
                self.assertEqual(f'<script src="{cli.PAGE_SCRIPT}?v=' in page, loads)

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

    def test_media_url_references_render_from_the_store_and_local_ones_are_refused(self):
        site = self.out_dir / "site"
        chart = (MEDIA_FIXTURES / "chart-1600x600.png").read_bytes()
        image = media.check(chart, "chart.png")
        media.store(media.media_dir(site), image)
        md = self.out_dir / "page.md"
        md.write_text(f"## Chart\n\n![Chart]({image.url})\n", encoding="utf-8")

        rc, _, err = run_cli(
            "render", "--markdown", str(md), "--name", "n", "--title", "T",
            "--out-dir", str(site), *self.COMMON,
        )
        self.assertEqual(rc, 0, err)
        img = parse((site / "n.html").read_text(encoding="utf-8")).find_all("img")[0]
        self.assertEqual((img.attrs["src"], img.attrs["width"], img.attrs["height"]),
                         (image.url, "1600", "600"))

        for src, why in (("chart.png", "publish stores a local image"),
                         (media_url("b", "png"), "names no image stored")):
            with self.subTest(src=src):
                md.write_text(f"![Chart]({src})\n", encoding="utf-8")
                rc, _, err = run_cli(
                    "render", "--markdown", str(md), "--name", "m", "--title", "T",
                    "--out-dir", str(site), *self.COMMON,
                )
                self.assertEqual(rc, 1)
                (line,) = err.splitlines()
                self.assertIn(src, line)
                self.assertIn(why, line)
                self.assertFalse((site / "m.html").exists())

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
