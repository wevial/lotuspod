"""serve answers the index, at / and /index.html, rendered when it is asked
for from manifest.json with today's index template: its head carries the
theme head script inline, so the tab shell follows the reader's theme, and
its rows are the manifest's listed pages in the order `lotuspod index`
writes them. The answer's ETag follows the manifest's bytes.

Each check runs a real `lotuspod serve` and `lotuspod publish`; no network.

Run from the repo root:

    python -m unittest tests.features.index.test_index_shell -v
"""

from __future__ import annotations

import re
import unittest

from tests.features.serve.test_serve_shell import THEME_HEAD, Site, shell_of
from tests.features.serve.test_serve_theme import SRC

ROW = re.compile(r'<tr data-page="([^"]+)"')
INDEX_PATHS = ("/", "/index.html")


def head_of(page: bytes) -> bytes:
    return page.split(b"</head>", 1)[0]


def rows(page: bytes) -> list[str]:
    return ROW.findall(page.decode("utf-8"))


class IndexShellTests(unittest.TestCase):
    def publish(self, site: Site, name: str, title: str) -> None:
        source = site.tmp / f"{name}.md"
        source.write_text(f"# {title}\n\nA note on the pond.\n\n## Bank\n\nReeds.\n",
                          encoding="utf-8")
        site.ok("publish", str(source), "--local")

    def site(self) -> Site:
        site = Site(self)
        for name, title in (("reeds", "Reeds"), ("frost", "Frost")):
            self.publish(site, name, title)
        site.serve()
        return site

    def test_the_index_holds_the_theme_head_and_the_manifests_rows_in_order(self):
        site = self.site()
        theme_head = (SRC / THEME_HEAD).read_text(encoding="utf-8")
        index_file = site.out / "index.html"
        written = rows(index_file.read_bytes())
        self.assertEqual(sorted(written), ["frost", "reeds"])
        # An index written before the head script: serve answers its render.
        index_file.write_text(index_file.read_text(encoding="utf-8").replace(
            f"<script>{theme_head}</script>", ""), encoding="utf-8")
        self.assertNotIn(theme_head, index_file.read_text(encoding="utf-8"))

        for path in INDEX_PATHS:
            with self.subTest(path=path):
                status, headers, page = site.ask("GET", path)
                self.assertEqual(status, 200)
                self.assertEqual(headers.get_content_type(), "text/html")
                self.assertIn(theme_head, shell_of(head_of(page)).scripts)
                self.assertEqual(rows(page), written)
                self.assertEqual(headers["Cache-Control"], "no-cache")
                self.assertEqual(headers["Content-Security-Policy"], "frame-ancestors 'self'")

    def test_the_etag_holds_until_a_publish_lists_another_page(self):
        site = self.site()
        _, headers, _ = site.ask("GET", "/")
        tag = headers["ETag"]
        status, _, body = site.ask("GET", "/", {"If-None-Match": tag})
        self.assertEqual((status, body), (304, b""))

        self.publish(site, "heron", "Heron")

        status, _, page = site.ask("GET", "/", {"If-None-Match": tag})
        self.assertEqual(status, 200)
        self.assertIn("heron", rows(page))


if __name__ == "__main__":
    unittest.main()
