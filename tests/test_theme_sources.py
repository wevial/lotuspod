"""Test suite for the theme's sources: the stylesheet, the page script, the
index script and the old-version script are written as one source file per
feature
(src/lotuspod/_theme/css/ and src/lotuspod/_theme/js/), and render joins each
served file's sources in the order cli.THEME_SOURCES declares into the one
file serve answers.

The joined bytes are never read from cli here: each test joins the source
files itself.

Run from the repo root:

    python -m unittest tests.test_theme_sources -v
"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path
from unittest import mock

from tests.test_manifest_v2 import TempDirTestCase, stylesheet_hash
from tests.test_theme_hash import ThemeHashTestCase, script_hash

from lotuspod import cli  # after test_manifest_v2, which puts src/ on the path

STYLESHEET = "lotuspod.css"
# The directories of the theme that hold only declared sources.
SOURCE_DIRS = ("css", "js")


def joined(theme_dir: Path, sources: tuple[str, ...]) -> bytes:
    return b"".join((theme_dir / source).read_bytes() for source in sources)


def source_problems(theme_dir: Path, declared: dict[str, tuple[str, ...]]) -> list[str]:
    """Each source file on disk but not declared, and each declared but not on
    disk, named by its path relative to theme_dir."""
    named = {source for sources in declared.values() for source in sources}
    on_disk = {
        path.relative_to(theme_dir).as_posix()
        for directory in SOURCE_DIRS
        for path in (theme_dir / directory).rglob("*")
        if path.is_file()
    }
    return sorted(
        [f"{source}: in {theme_dir} but not in the declared order"
         for source in on_disk - named]
        + [f"{source}: in the declared order but not in {theme_dir}"
           for source in named - on_disk]
    )


class ThemeCopyTestCase(TempDirTestCase):
    def theme_copy(self) -> Path:
        copy = Path(self.enterContext(tempfile.TemporaryDirectory())) / "theme"
        shutil.copytree(cli.THEME_DIR, copy)
        return copy


class JoinTests(TempDirTestCase):
    def test_sync_writes_each_file_as_its_sources_joined_in_order(self):
        cli.sync_theme_css(self.out_dir)
        for filename in (STYLESHEET, cli.PAGE_SCRIPT):
            with self.subTest(filename=filename):
                sources = cli.THEME_SOURCES[filename]
                self.assertGreater(len(sources), 1)
                self.assertEqual(
                    (self.out_dir / filename).read_bytes(),
                    joined(cli.THEME_DIR, sources),
                )

    def test_sync_writes_the_index_script_from_its_source(self):
        cli.sync_theme_css(self.out_dir)
        self.assertEqual(
            (self.out_dir / cli.INDEX_SCRIPT).read_bytes(),
            joined(cli.THEME_DIR, cli.THEME_SOURCES[cli.INDEX_SCRIPT]),
        )

    def test_the_four_served_files_are_written_from_sources(self):
        self.assertEqual(sorted(cli.THEME_SOURCES),
                         sorted([STYLESHEET, cli.PAGE_SCRIPT, cli.INDEX_SCRIPT,
                                 cli.OLD_VERSION_SCRIPT]))
        for filename in cli.THEME_SOURCES:
            self.assertFalse((cli.THEME_DIR / filename).exists(), filename)


class DeclaredOrderTests(ThemeCopyTestCase):
    def test_every_source_is_declared_and_on_disk(self):
        problems = source_problems(cli.THEME_DIR, cli.THEME_SOURCES)
        self.assertEqual(problems, [], "\n".join(problems))

    def test_the_popover_and_bottom_sheet_sources_are_declared_beside_the_comments(self):
        """LOTUS-37: the narrow script runs before the comments start, so it
        is joined before js/comments.js; its styles win at equal specificity,
        so they are joined after css/comments.css."""
        styles = cli.THEME_SOURCES[STYLESHEET]
        script = cli.THEME_SOURCES[cli.PAGE_SCRIPT]
        self.assertIn("css/narrow.css", styles)
        self.assertIn("js/narrow.js", script)
        self.assertGreater(styles.index("css/narrow.css"), styles.index("css/comments.css"))
        self.assertLess(script.index("js/narrow.js"), script.index("js/comments.js"))

    def test_the_live_page_sources_are_declared_before_the_comments_script(self):
        """LOTUS-41: the comments' reads hand the live page each revision
        they carry, so its script is joined before js/comments.js."""
        styles = cli.THEME_SOURCES[STYLESHEET]
        script = cli.THEME_SOURCES[cli.PAGE_SCRIPT]
        self.assertIn("css/live-page.css", styles)
        self.assertIn("js/live-page.js", script)
        self.assertLess(script.index("js/live-page.js"), script.index("js/comments.js"))
        problems = source_problems(cli.THEME_DIR, cli.THEME_SOURCES)
        self.assertEqual(problems, [], "\n".join(problems))

    def test_the_tables_script_is_declared_after_the_comments_script(self):
        """LOTUS-49: a table's room is measured against the comments panel,
        which the comments script makes, so js/tables.js is joined after
        js/comments.js and before js/page-close.js closes the script."""
        script = cli.THEME_SOURCES[cli.PAGE_SCRIPT]
        self.assertIn("js/tables.js", script)
        self.assertGreater(script.index("js/tables.js"), script.index("js/comments.js"))
        self.assertEqual(script[-1], "js/page-close.js")
        problems = source_problems(cli.THEME_DIR, cli.THEME_SOURCES)
        self.assertEqual(problems, [], "\n".join(problems))

    def test_the_panel_resize_sources_are_declared_after_the_comments(self):
        """LOTUS-51: the resize handle is added to the panel the comments
        script makes, so js/panel-resize.js is joined after js/comments.js
        and before js/page-close.js closes the script; its styles override
        the panel's, so they are joined after css/comments.css."""
        styles = cli.THEME_SOURCES[STYLESHEET]
        script = cli.THEME_SOURCES[cli.PAGE_SCRIPT]
        self.assertIn("css/panel-resize.css", styles)
        self.assertIn("js/panel-resize.js", script)
        self.assertGreater(styles.index("css/panel-resize.css"), styles.index("css/comments.css"))
        self.assertGreater(script.index("js/panel-resize.js"), script.index("js/comments.js"))
        self.assertLess(script.index("js/panel-resize.js"), script.index("js/page-close.js"))
        problems = source_problems(cli.THEME_DIR, cli.THEME_SOURCES)
        self.assertEqual(problems, [], "\n".join(problems))

    def test_the_table_expand_sources_are_declared(self):
        """LOTUS-50: the Expand button reads the room js/tables.js publishes,
        so js/table-expand.js is joined after it and before js/page-close.js;
        its styles are declared in the stylesheet's order."""
        script = cli.THEME_SOURCES[cli.PAGE_SCRIPT]
        self.assertIn("js/table-expand.js", script)
        self.assertGreater(script.index("js/table-expand.js"), script.index("js/tables.js"))
        self.assertEqual(script[-1], "js/page-close.js")
        self.assertIn("css/table-expand.css", cli.THEME_SOURCES["lotuspod.css"])
        problems = source_problems(cli.THEME_DIR, cli.THEME_SOURCES)
        self.assertEqual(problems, [], "\n".join(problems))

    def test_the_image_viewer_sources_are_declared(self):
        """LOTUS-56: the image viewer's script is joined before
        js/page-close.js closes the script, and its styles are declared in
        the stylesheet's order."""
        script = cli.THEME_SOURCES[cli.PAGE_SCRIPT]
        self.assertIn("js/image-viewer.js", script)
        self.assertEqual(script[-1], "js/page-close.js")
        self.assertIn("css/image-viewer.css", cli.THEME_SOURCES[STYLESHEET])
        problems = source_problems(cli.THEME_DIR, cli.THEME_SOURCES)
        self.assertEqual(problems, [], "\n".join(problems))

    def test_the_comment_markdown_script_is_declared_before_the_comments_script(self):
        """LOTUS-92: a bubble's text is drawn by js/comment-markdown.js, so it
        is joined before js/comments.js, which calls it."""
        script = cli.THEME_SOURCES[cli.PAGE_SCRIPT]
        self.assertIn("js/comment-markdown.js", script)
        self.assertLess(script.index("js/comment-markdown.js"), script.index("js/comments.js"))
        self.assertGreater(script.index("js/comment-markdown.js"), script.index("js/page-open.js"))

    def test_the_ref_cards_sources_are_declared(self):
        """LOTUS-100: the cards' script uses when() and linkTab(), so it is
        joined after js/page-open.js and js/link-tab.js, just before
        js/page-close.js but for js/archive.js; its styles just after
        css/prose.css."""
        styles = cli.THEME_SOURCES[STYLESHEET]
        script = cli.THEME_SOURCES[cli.PAGE_SCRIPT]
        self.assertEqual(script[-3:], ("js/ref-cards.js", "js/archive.js", "js/page-close.js"))
        self.assertGreater(script.index("js/ref-cards.js"), script.index("js/link-tab.js"))
        self.assertEqual(styles.index("css/ref-cards.css"), styles.index("css/prose.css") + 1)
        problems = source_problems(cli.THEME_DIR, cli.THEME_SOURCES)
        self.assertEqual(problems, [], "\n".join(problems))

    def test_the_pod_tabs_sources_are_declared_and_the_index_script_is_served(self):
        """LOTUS-101: the index script, lotuspod-index.js, is joined from
        js/pod-tabs.js, written and served beside the page script; the tabs'
        styles follow css/index.css, which they draw over."""
        styles = cli.THEME_SOURCES[STYLESHEET]
        self.assertEqual(cli.INDEX_SCRIPT, "lotuspod-index.js")
        self.assertEqual(cli.THEME_SOURCES[cli.INDEX_SCRIPT][0], "js/pod-tabs.js")
        self.assertEqual(styles.index("css/pod-tabs.css"), styles.index("css/index.css") + 1)
        self.assertIn(cli.INDEX_SCRIPT, cli.THEME_FILES)
        self.assertIn(cli.INDEX_SCRIPT, cli.serve_allow_list(self.out_dir))
        problems = source_problems(cli.THEME_DIR, cli.THEME_SOURCES)
        self.assertEqual(problems, [], "\n".join(problems))

    def test_the_archive_sources_are_declared(self):
        """LOTUS-118: the header's Archive button uses element(), json() and
        SIGNED_OUT, so js/archive.js is joined after js/page-open.js, just
        before js/page-close.js; its styles, the archived banner's among
        them, follow css/versions.css, whose old-version banner they match."""
        styles = cli.THEME_SOURCES[STYLESHEET]
        script = cli.THEME_SOURCES[cli.PAGE_SCRIPT]
        self.assertEqual(script[-2:], ("js/archive.js", "js/page-close.js"))
        self.assertEqual(styles.index("css/archive.css"), styles.index("css/versions.css") + 1)
        problems = source_problems(cli.THEME_DIR, cli.THEME_SOURCES)
        self.assertEqual(problems, [], "\n".join(problems))

    def test_the_pod_finder_sources_follow_the_pod_tabs_sources(self):
        """LOTUS-102: the finder hands its choice to the tabs and opens from
        their strip, so js/pod-finder.js is joined just after js/pod-tabs.js
        in the index script, and its styles just after css/pod-tabs.css."""
        styles = cli.THEME_SOURCES[STYLESHEET]
        self.assertEqual(cli.THEME_SOURCES[cli.INDEX_SCRIPT],
                         ("js/pod-tabs.js", "js/pod-finder.js"))
        self.assertEqual(styles.index("css/pod-finder.css"), styles.index("css/pod-tabs.css") + 1)
        problems = source_problems(cli.THEME_DIR, cli.THEME_SOURCES)
        self.assertEqual(problems, [], "\n".join(problems))

    def test_the_old_version_script_joins_the_menu_and_no_page_feature(self):
        """The old-version script, served beside the page script,
        is its opening, the helpers it shares with the page script, the
        version menu, its own source and the closing line; no page feature
        that reads, shows or posts comments or answers is in it."""
        script = cli.THEME_SOURCES[cli.OLD_VERSION_SCRIPT]
        self.assertEqual(cli.OLD_VERSION_SCRIPT, "lotuspod-old-version.js")
        self.assertEqual(script, ("js/old-version-open.js", "js/shared.js",
                                  "js/version-menu.js", "js/old-version.js",
                                  "js/page-close.js"))
        page = cli.THEME_SOURCES[cli.PAGE_SCRIPT]
        self.assertEqual(page[:3], ("js/open-in-tabs.js", "js/page-open.js", "js/shared.js"))
        self.assertIn(cli.OLD_VERSION_SCRIPT, cli.THEME_FILES)
        self.assertIn(cli.OLD_VERSION_SCRIPT, cli.serve_allow_list(self.out_dir))
        problems = source_problems(cli.THEME_DIR, cli.THEME_SOURCES)
        self.assertEqual(problems, [], "\n".join(problems))

    def test_a_source_not_in_the_declared_order_is_named(self):
        theme = self.theme_copy()
        (theme / "css" / "stray.css").write_text(".stray {}\n", encoding="utf-8")
        (theme / "js" / "stray.js").write_text("// stray\n", encoding="utf-8")
        problems = source_problems(theme, cli.THEME_SOURCES)
        self.assertEqual(len(problems), 2, problems)
        self.assertTrue(problems[0].startswith("css/stray.css: "), problems)
        self.assertTrue(problems[1].startswith("js/stray.js: "), problems)

    def test_a_declared_source_not_on_disk_is_named(self):
        theme = self.theme_copy()
        comments_css = "css/comments.css"
        decisions_js = "js/decisions.js"
        (theme / comments_css).unlink()
        (theme / decisions_js).unlink()
        problems = source_problems(theme, cli.THEME_SOURCES)
        self.assertEqual(len(problems), 2, problems)
        self.assertTrue(problems[0].startswith(f"{comments_css}: "), problems)
        self.assertTrue(problems[1].startswith(f"{decisions_js}: "), problems)

    def test_a_new_source_takes_one_line_in_the_declared_order(self):
        theme = self.theme_copy()
        new = "css/pond.css"
        rule = b"\n.pond {\n  color: var(--color-sky);\n}\n"
        (theme / new).write_bytes(rule)
        declared = dict(cli.THEME_SOURCES)
        declared[STYLESHEET] = (*declared[STYLESHEET], new)

        with mock.patch.object(cli, "THEME_DIR", theme), \
                mock.patch.object(cli, "THEME_SOURCES", declared):
            cli.sync_theme_css(self.out_dir)
        served = (self.out_dir / STYLESHEET).read_bytes()
        self.assertTrue(served.endswith(rule))
        self.assertEqual(served, joined(cli.THEME_DIR, cli.THEME_SOURCES[STYLESHEET]) + rule)
        problems = source_problems(theme, declared)
        self.assertEqual(problems, [], "\n".join(problems))


class SourceEditTests(ThemeHashTestCase):
    def assert_edit_moves_the_address(self, source: str) -> None:
        unchanged = self.theme_copy()
        with mock.patch.object(cli, "THEME_DIR", unchanged):
            before = self.rendered("before")
        changed = self.theme_copy()
        data = bytearray((changed / source).read_bytes())
        data[len(data) // 2] ^= 0x01
        (changed / source).write_bytes(bytes(data))
        with mock.patch.object(cli, "THEME_DIR", changed):
            after = self.rendered("after")

        self.assertNotEqual(stylesheet_hash(after), stylesheet_hash(before))
        self.assertNotEqual(script_hash(after), script_hash(before))

    def test_one_byte_of_the_comments_stylesheet_moves_the_address(self):
        self.assert_edit_moves_the_address("css/comments.css")

    def test_one_byte_of_the_decisions_page_script_moves_the_address(self):
        self.assert_edit_moves_the_address("js/decisions.js")


if __name__ == "__main__":
    import unittest

    unittest.main()
