"""Test suite for the theme's sources: the stylesheet and the page script are
written as one source file per feature (src/lotuspod/_theme/css/ and
src/lotuspod/_theme/js/), and render joins each served file's sources in the
order cli.THEME_SOURCES declares into the one file serve answers.

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

    def test_both_served_files_are_written_from_sources(self):
        self.assertEqual(sorted(cli.THEME_SOURCES), sorted([STYLESHEET, cli.PAGE_SCRIPT]))
        for filename in cli.THEME_SOURCES:
            self.assertFalse((cli.THEME_DIR / filename).exists(), filename)


class DeclaredOrderTests(ThemeCopyTestCase):
    def test_every_source_is_declared_and_on_disk(self):
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
