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

import json
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
        site = Site(self, "old-shell.html", "old-shell.md")
        for name, title in (("reeds", "Reeds"), ("frost", "Frost")):
            self.publish(site, name, title)
        site.ok("manifest")
        site.ok("index")
        site.serve()
        return site

    def test_the_index_holds_the_theme_head_and_the_manifests_rows_in_order(self):
        site = self.site()
        theme_head = (SRC / THEME_HEAD).read_text(encoding="utf-8")
        listed = [entry["file"].removesuffix(".html") for entry in
                  json.loads((site.out / "manifest.json").read_text(encoding="utf-8"))["artifacts"]]
        written = rows((site.out / "index.html").read_bytes())
        self.assertEqual(sorted(listed), ["frost", "old-shell", "reeds"])
        self.assertEqual(written, listed)
        # An index written before the head script: serve answers its render.
        index_file = site.out / "index.html"
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
        tags = {}
        for path in INDEX_PATHS:
            with self.subTest(path=path):
                _, first, _ = site.ask("GET", path)
                _, second, _ = site.ask("GET", path)
                tags[path] = first["ETag"]
                self.assertTrue(tags[path])
                self.assertEqual(second["ETag"], tags[path])
                status, _, body = site.ask("GET", path, {"If-None-Match": tags[path]})
                self.assertEqual((status, body), (304, b""))
        self.assertEqual(tags["/"], tags["/index.html"])

        self.publish(site, "heron", "Heron")

        for path in INDEX_PATHS:
            with self.subTest(path=path):
                status, headers, page = site.ask("GET", path, {"If-None-Match": tags[path]})
                self.assertEqual(status, 200)
                self.assertNotEqual(headers["ETag"], tags[path])
                self.assertIn("heron", rows(page))
                self.assertEqual(rows(page), rows((site.out / "index.html").read_bytes()))


if __name__ == "__main__":
    unittest.main()
