"""Test suite for the theme's address: pages and the index link the
stylesheet and the page script as `?v=HASH`, where HASH is 12 hex digits of
a SHA-256 over the served theme files. A theme edit changes the address with
nothing to bump, and a page rendered with an old `?v=` keeps loading the
current files, since serve drops the query string.

The expected hash is never computed here: it is read from the pages.

Run from the repo root:

    python -m unittest tests.test_theme_hash -v
"""

from __future__ import annotations

import re
import shutil
import tempfile
import threading
import urllib.request
from pathlib import Path
from unittest import mock

from tests.test_manifest_v2 import TempDirTestCase, run_cli, stylesheet_hash

from lotuspod import cli  # after test_manifest_v2, which puts src/ on the path

HASH = r"\A[0-9a-f]{12}\Z"
BODY = "<h2>Alpha</h2><p>a</p><h2>Beta</h2><p>b</p>"
OLD_VERSION = "0.4.12"


def script_hash(page: str) -> str:
    """The value a page's page script tag carries after ?v=."""
    found = re.findall(rf'<script src="{re.escape(cli.PAGE_SCRIPT)}\?v=([^"]*)" defer>', page)
    if len(found) != 1:
        raise AssertionError(f"expected one page script tag, found {len(found)}")
    return found[0]


class ThemeHashTestCase(TempDirTestCase):
    def rendered(self, name: str = "plan") -> str:
        """A page with comment boxes, so it loads the page script too."""
        rc, _, err = self.render(name, "--date", "2026-01-02", "--body", BODY, "--comments")
        self.assertEqual(rc, 0, err)
        return (self.out_dir / f"{name}.html").read_text(encoding="utf-8")

    def theme_copy(self) -> Path:
        copy = Path(self.enterContext(tempfile.TemporaryDirectory())) / "theme"
        shutil.copytree(cli.THEME_DIR, copy)
        return copy


class AddressTests(ThemeHashTestCase):
    def test_the_page_script_and_the_index_carry_the_stylesheet_hash(self):
        first = self.rendered()
        second = self.rendered()
        rc, _, err = run_cli("index", "--out-dir", str(self.out_dir))
        self.assertEqual(rc, 0, err)
        index = (self.out_dir / "index.html").read_text(encoding="utf-8")

        theme_hash = stylesheet_hash(first)
        self.assertRegex(theme_hash, HASH)
        self.assertEqual(stylesheet_hash(second), theme_hash)
        self.assertEqual(script_hash(first), theme_hash)
        self.assertEqual(script_hash(second), theme_hash)
        self.assertEqual(stylesheet_hash(index), theme_hash)

    def test_the_generator_tag_names_the_theme_alone(self):
        page = self.rendered()
        self.assertIn('<meta name="generator" content="lotuspod theme lotus">', page)


class ThemeEditTests(ThemeHashTestCase):
    def assert_edit_moves_the_address(self, filename: str) -> None:
        unchanged = self.theme_copy()
        with mock.patch.object(cli, "THEME_DIR", unchanged):
            before = self.rendered("before")
        changed = self.theme_copy()
        data = bytearray((changed / filename).read_bytes())
        data[-1] ^= 0x01
        (changed / filename).write_bytes(bytes(data))
        with mock.patch.object(cli, "THEME_DIR", changed):
            after = self.rendered("after")

        for page in (before, after):
            self.assertRegex(stylesheet_hash(page), HASH)
            self.assertEqual(script_hash(page), stylesheet_hash(page))
        self.assertNotEqual(stylesheet_hash(after), stylesheet_hash(before))
        self.assertNotEqual(script_hash(after), script_hash(before))
        # The address names what serve answers: the changed bytes went out.
        self.assertEqual((self.out_dir / filename).read_bytes(), bytes(data))

    def test_one_byte_of_the_stylesheet_moves_the_address(self):
        self.assert_edit_moves_the_address("lotuspod.css")

    def test_one_byte_of_the_page_script_moves_the_address(self):
        self.assert_edit_moves_the_address(cli.PAGE_SCRIPT)


class OldAddressTests(ThemeHashTestCase):
    def test_an_old_version_address_serves_the_current_files(self):
        page = self.rendered()
        theme_hash = stylesheet_hash(page)

        patcher = mock.patch.object(cli._AllowListHandler, "log_message", lambda *a: None)
        patcher.start()
        self.addCleanup(patcher.stop)
        server = cli._make_server(self.out_dir, "127.0.0.1", 0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join, 5)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        base = f"http://127.0.0.1:{server.server_address[1]}"

        def fetch(path: str) -> bytes:
            with urllib.request.urlopen(base + path, timeout=5) as response:
                self.assertEqual(response.status, 200)
                return response.read()

        for filename in ("lotuspod.css", cli.PAGE_SCRIPT):
            with self.subTest(filename=filename):
                current = fetch(f"/{filename}?v={theme_hash}")
                self.assertEqual(current, (cli.THEME_DIR / filename).read_bytes())
                self.assertEqual(fetch(f"/{filename}?v={OLD_VERSION}"), current)


if __name__ == "__main__":
    import unittest

    unittest.main()
