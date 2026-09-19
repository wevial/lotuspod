"""Test suite for `lotuspod export`: the publish directory holds only what
serve would answer with.

Covers the exact exported name set and bytes, the fresh index, and the two
refusals: a symbolic link among the pages and a destination that is not empty.

Run from the repo root:

    python -m unittest tests.test_export -v
"""

from __future__ import annotations

import tempfile
import unittest
from pathlib import Path

from tests.test_manifest_v2 import (
    VISIBLE_PAGE,
    TempDirTestCase,
    cli,
    make_mixed_fixture,
    run_cli,
)


class ExportTestCase(TempDirTestCase):
    def setUp(self) -> None:
        super().setUp()
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dest = Path(tmp.name) / "publish"
        make_mixed_fixture(self.out_dir)
        (self.out_dir / "manifest.json").write_text(
            '{"version": 2, "artifacts": []}\n', encoding="utf-8"
        )
        (self.out_dir / "FINDINGS.md").write_text("# private\n", encoding="utf-8")
        (self.out_dir / "notes.txt").write_text("stray\n", encoding="utf-8")
        (self.out_dir / "sub").mkdir()
        (self.out_dir / "sub" / "deep.html").write_text(
            VISIBLE_PAGE.format(title="Deep", episode="9", date="", summary=""),
            encoding="utf-8",
        )

    def export(self) -> tuple[int, str, str]:
        return run_cli(
            "export", "--out-dir", str(self.out_dir), "--dest", str(self.dest)
        )

    def source_snapshot(self) -> dict[str, bytes]:
        return {
            str(p.relative_to(self.out_dir)): p.read_bytes()
            for p in self.out_dir.rglob("*")
            if p.is_file() and not p.is_symlink()
        }

    def assertDestAbsentOrEmpty(self) -> None:
        self.assertTrue(not self.dest.exists() or not any(self.dest.iterdir()))


class ExportContentsTests(ExportTestCase):
    """Only the allow-listed names reach the destination, byte for byte."""

    def test_exact_name_set_and_bytes(self):
        rc, _, err = self.export()
        self.assertEqual(rc, 0, err)
        names = {str(p.relative_to(self.dest)) for p in self.dest.rglob("*")}
        self.assertEqual(
            names, {"zeta.html", "index.html", "lotuspod.css", "favicon.svg"}
        )
        for name in ("zeta.html", "lotuspod.css", "favicon.svg"):
            self.assertEqual(
                (self.dest / name).read_bytes(), (self.out_dir / name).read_bytes()
            )

    def test_assets_come_from_the_artifacts_directory_not_the_package(self):
        # serve answers with the directory's copies, so export publishes those
        # bytes even when they differ from the packaged theme.
        custom = {
            "lotuspod.css": b"body { color: rebeccapurple; }\n",
            "favicon.svg": b'<svg xmlns="http://www.w3.org/2000/svg"/>\n',
        }
        for name, data in custom.items():
            self.assertNotEqual(data, (cli.THEME_DIR / name).read_bytes())
            (self.out_dir / name).write_bytes(data)
        before = self.source_snapshot()
        rc, _, err = self.export()
        self.assertEqual(rc, 0, err)
        for name, data in custom.items():
            self.assertEqual((self.dest / name).read_bytes(), data)
        self.assertEqual(self.source_snapshot(), before)

    def test_missing_asset_is_refused(self):
        for name in ("lotuspod.css", "favicon.svg"):
            with self.subTest(name=name):
                saved = (self.out_dir / name).read_bytes()
                (self.out_dir / name).unlink()
                rc, _, err = self.export()
                self.assertNotEqual(rc, 0)
                self.assertIn(name, err)
                self.assertDestAbsentOrEmpty()
                (self.out_dir / name).write_bytes(saved)

    def test_exported_names_match_serve_allow_list(self):
        rc, _, err = self.export()
        self.assertEqual(rc, 0, err)
        self.assertEqual(
            {p.name for p in self.dest.iterdir()},
            set(cli.serve_allow_list(self.out_dir)),
        )

    def test_index_equals_lotuspod_index_and_links_no_hidden_page(self):
        rc, _, err = self.export()
        self.assertEqual(rc, 0, err)
        exported = (self.dest / "index.html").read_text(encoding="utf-8")
        rc, _, err = run_cli("index", "--out-dir", str(self.out_dir))
        self.assertEqual(rc, 0, err)
        self.assertEqual(
            exported, (self.out_dir / "index.html").read_text(encoding="utf-8")
        )
        self.assertIn("zeta.html", exported)
        for hidden in ("alpha", "mike", "tango", "deep"):
            self.assertNotIn(hidden, exported.lower())

    def test_stale_source_index_is_not_copied(self):
        (self.out_dir / "index.html").write_text(
            '<a href="alpha.html">Alpha Draft</a>', encoding="utf-8"
        )
        rc, _, err = self.export()
        self.assertEqual(rc, 0, err)
        self.assertNotIn(
            "alpha", (self.dest / "index.html").read_text(encoding="utf-8").lower()
        )

    def test_source_directory_is_untouched(self):
        before = self.source_snapshot()
        rc, _, err = self.export()
        self.assertEqual(rc, 0, err)
        self.assertEqual(self.source_snapshot(), before)

    def test_existing_empty_destination_is_accepted(self):
        self.dest.mkdir()
        rc, _, err = self.export()
        self.assertEqual(rc, 0, err)
        self.assertTrue((self.dest / "zeta.html").is_file())


class ExportSymlinkRefusalTests(ExportTestCase):
    """A linked page name would publish whatever it points at."""

    def assertRefusesLink(self, link: Path) -> None:
        rc, _, err = self.export()
        self.assertNotEqual(rc, 0)
        self.assertIn(link.name, err)
        self.assertDestAbsentOrEmpty()

    def test_visible_name_linked_to_hidden_page(self):
        link = self.out_dir / "zeta.html"
        link.unlink()
        link.symlink_to(self.out_dir / "alpha.html")
        self.assertRefusesLink(link)

    def test_visible_name_linked_outside_the_directory(self):
        outside = tempfile.TemporaryDirectory()
        self.addCleanup(outside.cleanup)
        target = Path(outside.name) / "elsewhere.html"
        target.write_text(
            VISIBLE_PAGE.format(title="Elsewhere", episode="5", date="", summary=""),
            encoding="utf-8",
        )
        link = self.out_dir / "zeta.html"
        link.unlink()
        link.symlink_to(target)
        self.assertRefusesLink(link)

    def test_linked_stylesheet_or_icon(self):
        for name in ("lotuspod.css", "favicon.svg"):
            with self.subTest(name=name):
                link = self.out_dir / name
                saved = link.read_bytes()
                link.unlink()
                link.symlink_to(self.out_dir / "FINDINGS.md")
                self.assertRefusesLink(link)
                link.unlink()
                link.write_bytes(saved)


class ExportDestinationRefusalTests(ExportTestCase):
    """Export never deletes or overwrites: the destination must be fresh."""

    def test_non_empty_destination_is_refused_and_left_alone(self):
        self.dest.mkdir()
        survivor = self.dest / "zeta.html"
        survivor.write_bytes(b"stale output from an earlier export\n")
        rc, _, err = self.export()
        self.assertNotEqual(rc, 0)
        self.assertIn(str(self.dest), err)
        self.assertEqual(
            survivor.read_bytes(), b"stale output from an earlier export\n"
        )
        self.assertEqual([p.name for p in self.dest.iterdir()], ["zeta.html"])

    def test_destination_that_is_a_file_is_refused(self):
        self.dest.write_bytes(b"not a directory\n")
        rc, _, err = self.export()
        self.assertNotEqual(rc, 0)
        self.assertIn(str(self.dest), err)
        self.assertEqual(self.dest.read_bytes(), b"not a directory\n")


if __name__ == "__main__":
    unittest.main()
