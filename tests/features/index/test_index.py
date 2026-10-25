"""Test suite for the index page: it lists only visible pages, wears its own
name plainly, and is a sortable, filterable table of their records.

Run from the repo root:

    python -m unittest tests.features.index.test_index -v
"""

from __future__ import annotations

import json
import re
import unittest
from pathlib import Path

from tests import history
from tests.features.publish.test_manifest_v2 import (MANIFEST_KEYS, TempDirTestCase, _IndexTable,
                                    make_mixed_fixture, render_updated, run_cli, served_css,
                                    stylesheet_hash)


class IndexVisibilityTests(TempDirTestCase):
    """index.html follows the same fail-closed rule as the manifest."""

    def build_index(self) -> str:
        rc, _, _ = run_cli("index", "--out-dir", str(self.out_dir))
        self.assertEqual(rc, 0)
        return (self.out_dir / "index.html").read_text(encoding="utf-8")

    def test_lists_only_visible_pages(self):
        make_mixed_fixture(self.out_dir)
        index_html = self.build_index()
        self.assertIn('href="zeta.html"', index_html)
        self.assertNotIn('href="alpha.html"', index_html)
        self.assertNotIn('href="mike.html"', index_html)
        self.assertNotIn('href="tango.html"', index_html)

    def test_never_lists_itself(self):
        self.write_page(
            "index",
            '<meta name="lotuspod:visible" content="true">'
            '<h1 class="artifact-title">Index</h1>',
        )
        index_html = self.build_index()
        self.assertNotIn('href="index.html"', index_html)

    def test_matches_manifest_listing(self):
        make_mixed_fixture(self.out_dir)
        run_cli("manifest", "--out-dir", str(self.out_dir))
        index_html = self.build_index()
        manifest = json.loads(
            (self.out_dir / "manifest.json").read_text(encoding="utf-8")
        )
        for entry in manifest["artifacts"]:
            self.assertIn(f'href="{entry["file"]}"', index_html)


class IndexHeaderTests(TempDirTestCase):
    """The index wears its own name plainly: no eyebrow, no card."""

    def build_index(self) -> str:
        rc, _, err = run_cli("index", "--out-dir", str(self.out_dir))
        self.assertEqual(rc, 0, err)
        return (self.out_dir / "index.html").read_text(encoding="utf-8")

    def test_title_is_plain_lotuspod(self):
        index_html = self.build_index()
        self.assertIn('<h1 class="index-title">Lotuspod <span class="index-updated">', index_html)
        self.assertIn("<title>Lotuspod</title>", index_html)
        self.assertNotIn("Episodes", index_html)

    def test_no_eyebrow_above_the_title(self):
        self.assertNotIn("artifact-kicker", self.build_index())

    def test_theme_gives_the_header_no_card(self):
        css = served_css()
        self.assertNotIn(".index-header", css)


class IndexTableTests(TempDirTestCase):
    """The listing is a sortable, filterable table of artifact records."""

    def build_index(self) -> str:
        rc, _, err = run_cli("index", "--out-dir", str(self.out_dir))
        self.assertEqual(rc, 0, err)
        return (self.out_dir / "index.html").read_text(encoding="utf-8")

    def theme_css(self) -> str:
        return served_css()

    def test_artifacts_are_listed_as_table_rows(self):
        make_mixed_fixture(self.out_dir)
        index_html = self.build_index()
        self.assertIn('<table class="index-table">', index_html)
        self.assertIn(
            '<td class="episode-title"><a href="zeta.html">Zeta Pond</a></td>',
            index_html,
        )
        self.assertEqual(
            index_html.count(
                '<td class="episode-date">'
                '<time datetime="2026-03-04">2026-03-04</time></td>'
            ),
            2,
        )
        self.assertIn(
            '<td class="episode-summary">latest from the pond</td>', index_html
        )
        self.assertNotIn("episode-card", index_html)

    def test_columns_are_title_updated_created_summary_with_no_page_column(self):
        make_mixed_fixture(self.out_dir)
        self.render("note")
        table = _IndexTable(self.build_index())
        self.assertEqual(table.headers, ["Title", "Updated", "Created", "Summary"])
        rows = table.body_rows()
        self.assertEqual(len(rows), 2)
        for row in rows:
            self.assertEqual(len(row), 4)
            self.assertNotIn("episode-number", [cell["class"] for cell in row])

    def test_an_episode_page_keeps_its_kicker_and_manifest_episode(self):
        make_mixed_fixture(self.out_dir)
        page = (self.out_dir / "zeta.html").read_text(encoding="utf-8")
        self.assertIn('<p class="artifact-kicker">Lotuspod · Episode 7</p>', page)
        rc, _, err = run_cli("manifest", "--out-dir", str(self.out_dir))
        self.assertEqual(rc, 0, err)
        data = json.loads((self.out_dir / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual([entry["episode"] for entry in data["artifacts"]], ["7"])
        self.assertNotIn("episode-number", self.build_index())

    def test_the_updated_header_starts_sorted_descending(self):
        self.render("note")
        index_html = self.build_index()
        self.assertIn('<th scope="col" aria-sort="descending">Updated</th>', index_html)
        for label in ("Title", "Created", "Summary"):
            with self.subTest(label=label):
                self.assertIn(f'<th scope="col">{label}</th>', index_html)

    def test_rows_come_newest_update_first(self):
        for name, updated in (("a-page", "2026-09-02T08:00:00Z"),
                              ("b-page", "2026-10-01T08:00:00Z"),
                              ("c-page", "2026-09-15T08:00:00Z")):
            render_updated(self.out_dir, name, "2026-09-01", updated)
        rows = _IndexTable(self.build_index()).body_rows()
        self.assertEqual(
            [(row[0]["text"], row[1]["datetime"], row[1]["text"]) for row in rows],
            [("B-Page", "2026-10-01T08:00:00Z", "2026-10-01 08:00"),
             ("C-Page", "2026-09-15T08:00:00Z", "2026-09-15 08:00"),
             ("A-Page", "2026-09-02T08:00:00Z", "2026-09-02 08:00")],
        )
        self.assertEqual({(row[2]["datetime"], row[2]["text"]) for row in rows},
                         {("2026-09-01", "2026-09-01")})
        rc, _, err = run_cli("manifest", "--out-dir", str(self.out_dir))
        self.assertEqual(rc, 0, err)
        data = json.loads((self.out_dir / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual([entry["file"] for entry in data["artifacts"]],
                         ["b-page.html", "c-page.html", "a-page.html"])
        for entry in data["artifacts"]:
            with self.subTest(file=entry["file"]):
                self.assertEqual(set(entry), MANIFEST_KEYS)
                self.assertEqual(entry["created"], entry["date"])

    def test_equal_updated_times_fall_back_to_file_name(self):
        for name in ("b-page", "a-page"):
            render_updated(self.out_dir, name, "2026-09-01", "2026-09-03T08:00:00Z")
        rows = _IndexTable(self.build_index()).body_rows()
        self.assertEqual([row[0]["text"] for row in rows], ["A-Page", "B-Page"])

    def test_missing_fields_leave_empty_cells(self):
        self.render("note")  # no --summary
        index_html = self.build_index()
        self.assertIn('<td class="episode-summary"></td>', index_html)

    def test_row_values_are_escaped(self):
        self.render("amp", "--title", "Pond & Lotus", "--summary", "<b>bold</b>")
        index_html = self.build_index()
        self.assertIn("Pond &amp; Lotus", index_html)
        self.assertIn("&lt;b&gt;bold&lt;/b&gt;", index_html)

    def test_search_filter_ships_hidden_for_the_script_to_reveal(self):
        for name in ("pond", "garden"):
            rc, _, err = self.render(name)
            self.assertEqual(rc, 0, err)
        index_html = self.build_index()
        self.assertIn('<div class="index-controls" hidden>', index_html)
        self.assertIn('class="index-search" type="search"', index_html)
        self.assertIn('for="index-search"', index_html)
        self.assertIn('id="index-search"', index_html)
        self.assertIn('<p class="index-count"', index_html)
        self.assertIn('class="index-empty index-no-match" hidden', index_html)
        # The search and the row count name pages, not episodes.
        self.assertIn('placeholder="Search pages by title, date or summary"', index_html)
        self.assertNotIn("episodes", index_html.lower())
        # The index's own script, in its body; the head holds the theme script.
        start = index_html.index("<script>", index_html.index("</head>"))
        script = index_html[start: index_html.index("</script>", start)]
        # Archived rows are counted apart, behind their toggle.
        noun = re.search(r'total === 1 \? "(\w+)" : "(\w+)"', script)
        self.assertIsNotNone(noun)
        self.assertIn("`${total} ${noun}`", script)
        body = index_html[index_html.index("<tbody>"): index_html.index("</tbody>")]
        # Each row names its page, for the index script's updated marks.
        pages = re.findall(r'<tr data-page="([^"]*)"', body)
        self.assertEqual(sorted(pages), ["garden", "pond"])
        rows = len(re.findall(r"<tr[ >]", body))
        self.assertEqual(f"{rows} {noun.group(1 if rows == 1 else 2)}", "2 pages")

    def test_script_wires_sorting_and_filtering(self):
        make_mixed_fixture(self.out_dir)
        index_html = self.build_index()
        # The index's own script, in its body; the head holds the theme script.
        start = index_html.index("<script>", index_html.index("</head>"))
        script = index_html[start: index_html.index("</script>", start)]
        self.assertIn(".index-table", script)
        self.assertIn("sort-button", script)
        self.assertIn("aria-sort", script)
        self.assertIn('addEventListener("input"', script)
        self.assertIn(".index-search", script)

    def test_empty_pond_has_no_table(self):
        index_html = self.build_index()
        self.assertIn("Nothing in the pond yet", index_html)
        self.assertNotIn("<table", index_html)

    def test_theme_styles_the_table_and_its_controls(self):
        css = self.theme_css()
        for rule in (".index-table", ".sort-button", ".index-search", ".index-count"):
            with self.subTest(rule=rule):
                self.assertIn(rule, css)

    def test_theme_hides_filtered_rows_and_the_hidden_controls(self):
        """[hidden] loses to table/flex display roles unless restated."""
        css = self.theme_css()
        self.assertIn(".index-table tbody tr[hidden]", css)
        self.assertIn(".index-controls[hidden]", css)

    def test_theme_no_longer_styles_the_dropped_cards(self):
        css = self.theme_css()
        self.assertNotIn(".episode-card", css)
        self.assertNotIn(".episode-list", css)

    def test_two_index_builds_are_byte_identical_and_name_the_theme_hash(self):
        make_mixed_fixture(self.out_dir)
        first = self.build_index()
        self.assertEqual(first, self.build_index())
        self.assertRegex(stylesheet_hash(first), r"\A[0-9a-f]{12}\Z")
        self.assertIn('<meta name="generator" content="lotuspod theme lotus">', first)


class IndexTableWidthTests(unittest.TestCase):
    """The listing sits in the centred .index column, not against the viewport.

    KO-233: the full-bleed rule (100vw, negative side margins) left five rows
    pinned to the left of an empty wide page. The table is now as wide as its
    container and still scrolls sideways when the columns outgrow it.
    """

    BLOCK = re.compile(r"^\.index-table \{.*?^\}\n", re.MULTILINE | re.DOTALL)
    KO_233_COMMIT = "175406f"

    def theme_css(self) -> str:
        return served_css()

    def index_table_block(self, css: str) -> str:
        blocks = self.BLOCK.findall(css)
        self.assertEqual(len(blocks), 1, blocks)
        return blocks[0]

    def test_table_fills_its_container_and_keeps_its_sideways_scroll(self):
        block = self.index_table_block(self.theme_css())
        self.assertIn("width: 100%;", block)
        self.assertIn("max-width: 100%;", block)
        self.assertIn("overflow-x: auto;", block)
        self.assertNotIn("vw", block)

    def test_the_block_has_not_drifted_since_ko_233(self):
        """Later theme work (KO-234's rail) leaves the listing rule alone."""
        repo = Path(__file__).resolve().parents[3]
        previous = history.show(self.KO_233_COMMIT, "src/lotuspod/_theme/lotuspod.css",
                                repo=repo)
        self.assertEqual(
            self.index_table_block(previous),
            self.index_table_block(self.theme_css()),
        )


if __name__ == "__main__":
    unittest.main()
