"""Test suite for the theme's sources: the stylesheet, the page script, the
index script and the old-version script are written as one source file per
feature
(src/lotuspod/_theme/css/ and src/lotuspod/_theme/js/, the shared ones in
src/lotuspod/core/theme/ and src/lotuspod/core/ts/, and a slice's in its
features/SLICE/theme/ and features/SLICE/ts/), and render joins each
served file's sources in the order core.THEME_SOURCES declares into the one
file serve answers. The page script and the old-version script each run as
one strict function: the join opens it before their shared sources and
closes it after the last, so every source is a complete script.

The joined bytes are never read from core here: each test joins the source
files itself.

Run from the repo root:

    python -m unittest tests.core.test_theme_sources -v
"""

from __future__ import annotations

import shutil
import tempfile
from pathlib import Path
from unittest import mock

from tests.features.publish.test_manifest_v2 import TempDirTestCase, stylesheet_hash
from tests.core.test_theme_hash import ThemeHashTestCase, script_hash

from lotuspod import core, serve_files  # after test_manifest_v2, which puts src/ on the path

STYLESHEET = "lotuspod.css"
# The files under the package that are only declared sources.
SOURCE_GLOBS = ("_theme/css/**/*", "_theme/js/**/*", "core/ts/**/*", "core/theme/*.css",
                "features/*/ts/**/*.js", "features/*/theme/*.css")
# The files those globs match that are no source of a joined file: the widget
# frame's bridge, which widgets.py writes into each widget's own document.
NOT_JOINED = {"features/widgets/ts/widget-frame.js"}


# The closure the join wraps the page script's and the old-version script's
# sources in.
CLOSURE_OPEN = b'(function () {\n  "use strict";\n'
CLOSURE_CLOSE = b"})();\n"


def joined(theme_dir: Path, sources: tuple[str, ...]) -> bytes:
    return b"".join((theme_dir / source).read_bytes() for source in sources)


def closure_joined(theme_dir: Path, outside: tuple[str, ...], inside: tuple[str, ...]) -> bytes:
    """The sources outside, then the closure's opening, the sources inside and
    its close."""
    return (joined(theme_dir, outside) + CLOSURE_OPEN + joined(theme_dir, inside)
            + CLOSURE_CLOSE)


def source_problems(theme_dir: Path, declared: dict[str, tuple[str, ...]]) -> list[str]:
    """Each source file on disk but not declared, and each declared but not on
    disk, named by its path relative to theme_dir."""
    named = {source for sources in declared.values() for source in sources}
    on_disk = {
        path.relative_to(theme_dir).as_posix()
        for pattern in SOURCE_GLOBS
        for path in theme_dir.glob(pattern)
        if path.is_file()
    } - NOT_JOINED
    return sorted(
        [f"{source}: in {theme_dir} but not in the declared order"
         for source in on_disk - named]
        + [f"{source}: in the declared order but not in {theme_dir}"
           for source in named - on_disk]
    )


class ThemeCopyTestCase(TempDirTestCase):
    def theme_copy(self) -> Path:
        copy = Path(self.enterContext(tempfile.TemporaryDirectory())) / "theme"
        shutil.copytree(core.THEME_ROOT, copy, ignore=shutil.ignore_patterns("*.py", "__pycache__"))
        return copy


class JoinTests(TempDirTestCase):
    def test_sync_writes_each_file_as_its_sources_joined_in_order(self):
        core.sync_theme_css(self.out_dir)
        sources = core.THEME_SOURCES[STYLESHEET]
        self.assertGreater(len(sources), 1)
        self.assertEqual(
            (self.out_dir / STYLESHEET).read_bytes(),
            joined(core.THEME_ROOT, sources),
        )
        sources = core.THEME_SOURCES[core.PAGE_SCRIPT]
        self.assertGreater(len(sources), 2)
        self.assertEqual(
            (self.out_dir / core.PAGE_SCRIPT).read_bytes(),
            closure_joined(core.THEME_ROOT, sources[:1], sources[1:]),
        )

    def test_the_page_scripts_are_joined_inside_one_closure(self):
        """The old-version script is the closure's opening, its sources in
        order and its close."""
        old = core.THEME_SOURCES[core.OLD_VERSION_SCRIPT]
        self.assertEqual(
            core.theme_file_bytes(core.OLD_VERSION_SCRIPT),
            closure_joined(core.THEME_ROOT, (), old),
        )
        # The hand-off ends in a call with no semicolon, so the opening right
        # after it is its argument.
        self.assertTrue((core.THEME_ROOT / "features/publish/ts/open-in-tabs.js").read_bytes().endswith(b"})()\n"))

    def test_no_source_opens_or_closes_the_closure(self):
        """The closure's opening and close are the join's: js/page-close.js
        and js/old-version-open.js are neither declared nor on disk."""
        declared = {source for sources in core.THEME_SOURCES.values() for source in sources}
        for fragment in ("_theme/js/page-close.js", "_theme/js/old-version-open.js"):
            with self.subTest(fragment=fragment):
                self.assertNotIn(fragment, declared)
                self.assertFalse((core.THEME_ROOT / fragment).exists())
        problems = source_problems(core.THEME_ROOT, core.THEME_SOURCES)
        self.assertEqual(problems, [], "\n".join(problems))

    def test_sync_writes_the_index_script_from_its_source(self):
        core.sync_theme_css(self.out_dir)
        self.assertEqual(
            (self.out_dir / core.INDEX_SCRIPT).read_bytes(),
            joined(core.THEME_ROOT, core.THEME_SOURCES[core.INDEX_SCRIPT]),
        )

    def test_the_four_served_files_are_written_from_sources(self):
        self.assertEqual(sorted(core.THEME_SOURCES),
                         sorted([STYLESHEET, core.PAGE_SCRIPT, core.INDEX_SCRIPT,
                                 core.OLD_VERSION_SCRIPT]))
        for filename in core.THEME_SOURCES:
            self.assertFalse((core.THEME_ROOT / "_theme" / filename).exists(), filename)


class DeclaredOrderTests(ThemeCopyTestCase):
    def test_every_source_is_declared_and_on_disk(self):
        problems = source_problems(core.THEME_ROOT, core.THEME_SOURCES)
        self.assertEqual(problems, [], "\n".join(problems))

    def test_the_popover_and_bottom_sheet_sources_are_declared_beside_the_comments(self):
        """LOTUS-37: the narrow script runs before the comments start, so it
        is joined before js/islands.js, which starts them (LOTUS-206); its
        styles win at equal specificity, so they are joined after css/comments.css."""
        styles = core.THEME_SOURCES[STYLESHEET]
        script = core.THEME_SOURCES[core.PAGE_SCRIPT]
        self.assertIn("features/comments/theme/narrow.css", styles)
        self.assertIn("features/comments/ts/narrow.js", script)
        self.assertGreater(styles.index("features/comments/theme/narrow.css"), styles.index("features/comments/theme/comments.css"))
        self.assertLess(script.index("features/comments/ts/narrow.js"), script.index("features/comments/ts/islands.js"))

    def test_the_live_page_sources_are_declared_before_the_comments_script(self):
        """LOTUS-41: the comments' reads hand the live page each revision
        they carry, so its script is joined before js/islands.js, which
        reads them (LOTUS-206)."""
        styles = core.THEME_SOURCES[STYLESHEET]
        script = core.THEME_SOURCES[core.PAGE_SCRIPT]
        self.assertIn("_theme/css/live-page.css", styles)
        self.assertIn("_theme/js/live-page.js", script)
        self.assertLess(script.index("_theme/js/live-page.js"), script.index("features/comments/ts/islands.js"))
        problems = source_problems(core.THEME_ROOT, core.THEME_SOURCES)
        self.assertEqual(problems, [], "\n".join(problems))

    def test_the_tables_script_is_declared_after_the_comments_script(self):
        """LOTUS-49: a table's room is measured against the comments panel,
        which the comments island makes, so js/tables.js is joined after
        js/islands.js (LOTUS-206), inside the closure the join closes after
        the last source."""
        script = core.THEME_SOURCES[core.PAGE_SCRIPT]
        self.assertIn("features/blocks/ts/tables.js", script)
        self.assertGreater(script.index("features/blocks/ts/tables.js"), script.index("features/comments/ts/islands.js"))
        problems = source_problems(core.THEME_ROOT, core.THEME_SOURCES)
        self.assertEqual(problems, [], "\n".join(problems))

    def test_the_panel_resize_sources_are_declared_after_the_comments(self):
        """LOTUS-51: the resize handle is added to the panel the comments
        island makes, so js/panel-resize.js is joined after js/islands.js,
        inside the closure; its styles override the panel's, so they are
        joined after css/comments.css."""
        styles = core.THEME_SOURCES[STYLESHEET]
        script = core.THEME_SOURCES[core.PAGE_SCRIPT]
        self.assertIn("features/comments/theme/panel-resize.css", styles)
        self.assertIn("features/comments/ts/panel-resize.js", script)
        self.assertGreater(styles.index("features/comments/theme/panel-resize.css"), styles.index("features/comments/theme/comments.css"))
        self.assertGreater(script.index("features/comments/ts/panel-resize.js"), script.index("features/comments/ts/islands.js"))
        problems = source_problems(core.THEME_ROOT, core.THEME_SOURCES)
        self.assertEqual(problems, [], "\n".join(problems))

    def test_the_table_expand_sources_are_declared(self):
        """LOTUS-50: the Expand button reads the room js/tables.js publishes,
        so js/table-expand.js is joined after it, inside the closure; its
        styles are declared in the stylesheet's order."""
        script = core.THEME_SOURCES[core.PAGE_SCRIPT]
        self.assertIn("features/blocks/ts/table-expand.js", script)
        self.assertGreater(script.index("features/blocks/ts/table-expand.js"), script.index("features/blocks/ts/tables.js"))
        self.assertIn("features/blocks/theme/table-expand.css", core.THEME_SOURCES["lotuspod.css"])
        problems = source_problems(core.THEME_ROOT, core.THEME_SOURCES)
        self.assertEqual(problems, [], "\n".join(problems))

    def test_widget_sources_follow_tables_and_calltree(self):
        styles = core.THEME_SOURCES[STYLESHEET]
        script = core.THEME_SOURCES[core.PAGE_SCRIPT]
        self.assertEqual(styles.index("features/widgets/theme/widgets.css"), styles.index("features/blocks/theme/table-expand.css") + 1)
        self.assertEqual(script.index("features/widgets/ts/widgets.js"), script.index("features/blocks/ts/calltree.js") + 1)

    def test_the_image_viewer_sources_are_declared(self):
        """LOTUS-56: the image viewer's script is joined after
        js/page-open.js, inside the closure, and its styles are declared in
        the stylesheet's order."""
        script = core.THEME_SOURCES[core.PAGE_SCRIPT]
        self.assertIn("features/blocks/ts/image-viewer.js", script)
        self.assertGreater(script.index("features/blocks/ts/image-viewer.js"), script.index("features/publish/ts/page-open.js"))
        self.assertIn("features/blocks/theme/image-viewer.css", core.THEME_SOURCES[STYLESHEET])
        problems = source_problems(core.THEME_ROOT, core.THEME_SOURCES)
        self.assertEqual(problems, [], "\n".join(problems))

    def test_the_comment_markdown_script_is_declared_before_the_comments_script(self):
        """LOTUS-92: a bubble's text is drawn by js/comment-markdown.js, so it
        is joined before js/islands.js, whose comments call it; the islands
        follow it directly, in js/comments.js's old place (LOTUS-206)."""
        script = core.THEME_SOURCES[core.PAGE_SCRIPT]
        self.assertIn("features/comments/ts/comment-markdown.js", script)
        self.assertEqual(script.index("features/comments/ts/islands.js"), script.index("features/comments/ts/comment-markdown.js") + 1)
        self.assertGreater(script.index("features/comments/ts/comment-markdown.js"), script.index("features/publish/ts/page-open.js"))

    def test_the_ref_cards_sources_are_declared(self):
        """LOTUS-100: the cards' script uses when() and linkTab(), so it is
        joined after js/page-open.js and js/link-tab.js, before
        js/calltree.js (LOTUS-167), js/widgets.js and js/archive.js; its
        styles just after css/prose.css."""
        styles = core.THEME_SOURCES[STYLESHEET]
        script = core.THEME_SOURCES[core.PAGE_SCRIPT]
        self.assertEqual(script[-4:], ("features/blocks/ts/ref-cards.js", "features/blocks/ts/calltree.js", "features/widgets/ts/widgets.js", "features/history/ts/archive.js"))
        self.assertGreater(script.index("features/blocks/ts/ref-cards.js"), script.index("core/ts/link-tab.js"))
        self.assertEqual(styles.index("features/blocks/theme/ref-cards.css"), styles.index("features/publish/theme/prose.css") + 1)
        problems = source_problems(core.THEME_ROOT, core.THEME_SOURCES)
        self.assertEqual(problems, [], "\n".join(problems))

    def test_the_pod_tabs_sources_are_declared_and_the_index_script_is_served(self):
        """LOTUS-101: the index script, lotuspod-index.js, is joined from
        js/pod-tabs.js, written and served beside the page script; the tabs'
        styles follow css/index.css, which they draw over."""
        styles = core.THEME_SOURCES[STYLESHEET]
        self.assertEqual(core.INDEX_SCRIPT, "lotuspod-index.js")
        self.assertEqual(core.THEME_SOURCES[core.INDEX_SCRIPT][0], "features/index/ts/pod-tabs.js")
        self.assertEqual(styles.index("features/index/theme/pod-tabs.css"), styles.index("features/index/theme/index.css") + 1)
        self.assertIn(core.INDEX_SCRIPT, core.THEME_FILES)
        self.assertIn(core.INDEX_SCRIPT, serve_files.serve_allow_list(self.out_dir))
        problems = source_problems(core.THEME_ROOT, core.THEME_SOURCES)
        self.assertEqual(problems, [], "\n".join(problems))

    def test_the_archive_sources_are_declared(self):
        """LOTUS-118: the header's Archive button uses element(), json() and
        SIGNED_OUT, so js/archive.js is joined after js/page-open.js, last;
        its styles, the archived banner's among them,
        follow css/versions.css, whose old-version banner they match."""
        styles = core.THEME_SOURCES[STYLESHEET]
        script = core.THEME_SOURCES[core.PAGE_SCRIPT]
        self.assertEqual(script[-1], "features/history/ts/archive.js")
        self.assertEqual(styles.index("features/history/theme/archive.css"), styles.index("features/history/theme/versions.css") + 1)
        problems = source_problems(core.THEME_ROOT, core.THEME_SOURCES)
        self.assertEqual(problems, [], "\n".join(problems))

    def test_the_review_sheet_is_an_island(self):
        """LOTUS-157: the review sheet is drawn by the islands bundle, after
        js/comment-markdown.js and js/decisions.js, whose forms it reads (no
        js/comments.js since LOTUS-206): no script of
        its own is declared, and its styles stay css/review-sheet.css."""
        styles = core.THEME_SOURCES[STYLESHEET]
        script = core.THEME_SOURCES[core.PAGE_SCRIPT]
        self.assertNotIn("features/comments/ts/review-sheet.js", script)
        self.assertFalse((core.THEME_ROOT / "_theme" / "js" / "review-sheet.js").exists())
        self.assertNotIn("features/comments/ts/comments.js", script)
        self.assertFalse((core.THEME_ROOT / "_theme" / "js" / "comments.js").exists())
        self.assertEqual(script.index("features/comments/ts/islands.js"), script.index("features/comments/ts/comment-markdown.js") + 1)
        self.assertNotIn("features/comments/ts/islands.js", core.THEME_SOURCES[core.INDEX_SCRIPT])
        self.assertNotIn("features/comments/ts/islands.js", core.THEME_SOURCES[core.OLD_VERSION_SCRIPT])
        self.assertGreater(script.index("features/comments/ts/islands.js"), script.index("features/decisions/ts/decisions.js"))
        self.assertIn("features/comments/theme/review-sheet.css", styles)
        problems = source_problems(core.THEME_ROOT, core.THEME_SOURCES)
        self.assertEqual(problems, [], "\n".join(problems))

    def test_the_pod_finder_sources_follow_the_pod_tabs_sources(self):
        """LOTUS-102: the finder hands its choice to the tabs and opens from
        their strip, so js/pod-finder.js is joined just after js/pod-tabs.js
        in the index script, and its styles just after css/pod-tabs.css."""
        styles = core.THEME_SOURCES[STYLESHEET]
        self.assertEqual(core.THEME_SOURCES[core.INDEX_SCRIPT][:2],
                         ("features/index/ts/pod-tabs.js", "features/index/ts/pod-finder.js"))
        self.assertEqual(styles.index("features/index/theme/pod-finder.css"), styles.index("features/index/theme/pod-tabs.css") + 1)
        problems = source_problems(core.THEME_ROOT, core.THEME_SOURCES)
        self.assertEqual(problems, [], "\n".join(problems))

    def test_the_live_events_source_joins_the_page_and_index_scripts(self):
        """LOTUS-177: serve's change stream, built from
        web/src/live-events.ts, is joined just before js/live-page.js, whose
        check its ticks run, and last in the index script, after
        js/pod-finder.js and js/index-refresh.js; the old-version script
        opens no stream."""
        page = core.THEME_SOURCES[core.PAGE_SCRIPT]
        self.assertEqual(page.index("_theme/js/live-events.js") + 1, page.index("_theme/js/live-page.js"))
        self.assertEqual(core.THEME_SOURCES[core.INDEX_SCRIPT],
                         ("features/index/ts/pod-tabs.js", "features/index/ts/pod-finder.js", "_theme/js/index-refresh.js",
                          "_theme/js/live-events.js"))
        self.assertNotIn("_theme/js/live-events.js", core.THEME_SOURCES[core.OLD_VERSION_SCRIPT])
        problems = source_problems(core.THEME_ROOT, core.THEME_SOURCES)
        self.assertEqual(problems, [], "\n".join(problems))

    def test_the_old_version_script_joins_the_menu_and_no_page_feature(self):
        """The old-version script, served beside the page script, joins
        the helpers it shares with the page script, the version menu and its
        own source, inside the closure the join adds; no page feature that
        reads, shows or posts comments or answers is in it."""
        script = core.THEME_SOURCES[core.OLD_VERSION_SCRIPT]
        self.assertEqual(core.OLD_VERSION_SCRIPT, "lotuspod-old-version.js")
        self.assertEqual(script, ("core/ts/shared.js", "features/history/ts/version-menu.js",
                                  "features/history/ts/old-version.js"))
        page = core.THEME_SOURCES[core.PAGE_SCRIPT]
        self.assertEqual(page[:3], ("features/publish/ts/open-in-tabs.js", "features/publish/ts/page-open.js", "core/ts/shared.js"))
        problems = source_problems(core.THEME_ROOT, core.THEME_SOURCES)
        self.assertEqual(problems, [], "\n".join(problems))

    def test_a_source_not_in_the_declared_order_is_named(self):
        theme = self.theme_copy()
        (theme / "_theme" / "css" / "stray.css").write_text(".stray {}\n", encoding="utf-8")
        (theme / "_theme" / "js" / "stray.js").write_text("// stray\n", encoding="utf-8")
        problems = source_problems(theme, core.THEME_SOURCES)
        self.assertEqual(len(problems), 2, problems)
        self.assertTrue(problems[0].startswith("_theme/css/stray.css: "), problems)
        self.assertTrue(problems[1].startswith("_theme/js/stray.js: "), problems)

    def test_a_declared_source_not_on_disk_is_named(self):
        theme = self.theme_copy()
        comments_css = "features/comments/theme/comments.css"
        decisions_js = "features/decisions/ts/decisions.js"
        (theme / comments_css).unlink()
        (theme / decisions_js).unlink()
        problems = source_problems(theme, core.THEME_SOURCES)
        self.assertEqual(len(problems), 2, problems)
        self.assertTrue(problems[0].startswith(f"{comments_css}: "), problems)
        self.assertTrue(problems[1].startswith(f"{decisions_js}: "), problems)

    def test_a_new_source_takes_one_line_in_the_declared_order(self):
        theme = self.theme_copy()
        new = "_theme/css/pond.css"
        rule = b"\n.pond {\n  color: var(--color-sky);\n}\n"
        (theme / new).write_bytes(rule)
        declared = dict(core.THEME_SOURCES)
        declared[STYLESHEET] = (*declared[STYLESHEET], new)

        with mock.patch.object(core, "THEME_ROOT", theme), \
                mock.patch.object(core, "THEME_SOURCES", declared):
            core.sync_theme_css(self.out_dir)
        served = (self.out_dir / STYLESHEET).read_bytes()
        self.assertTrue(served.endswith(rule))
        self.assertEqual(served, joined(core.THEME_ROOT, core.THEME_SOURCES[STYLESHEET]) + rule)
        problems = source_problems(theme, declared)
        self.assertEqual(problems, [], "\n".join(problems))


class SourceEditTests(ThemeHashTestCase):
    def assert_edit_moves_the_address(self, source: str) -> None:
        unchanged = self.theme_copy()
        with mock.patch.object(core, "THEME_ROOT", unchanged):
            before = self.rendered("before")
        changed = self.theme_copy()
        data = bytearray((changed / source).read_bytes())
        data[len(data) // 2] ^= 0x01
        (changed / source).write_bytes(bytes(data))
        with mock.patch.object(core, "THEME_ROOT", changed):
            after = self.rendered("after")

        self.assertNotEqual(stylesheet_hash(after), stylesheet_hash(before))
        self.assertNotEqual(script_hash(after), script_hash(before))

    def test_one_byte_of_the_comments_stylesheet_moves_the_address(self):
        self.assert_edit_moves_the_address("features/comments/theme/comments.css")

    def test_one_byte_of_the_decisions_page_script_moves_the_address(self):
        self.assert_edit_moves_the_address("features/decisions/ts/decisions.js")


if __name__ == "__main__":
    import unittest

    unittest.main()
