"""serve answers an earlier version it cannot draw in today's shell from that
commit's published file: here a revision committed without its kept source,
whose body holds comment boxes. The answer runs today's theme head, allowed
by its hash in both the header's and the page's own policy, beside the
old-version script; nothing else of the stored page runs.

Each check runs a real `lotuspod serve` and `lotuspod publish` over a clone
of a local bare repository, with real git; no network.

Run from the repo root:

    python -m unittest tests.features.serve.test_serve_version_published -v
"""

from __future__ import annotations

import re
import shutil
import unittest
from html.parser import HTMLParser

from lotuspod.core import OLD_VERSION_SCRIPT, PAGE_SCRIPT, script_hash
from tests.features.serve.test_serve_shell import (ADDED, THEME_HEAD, git, script_src,
                                                   shell_of)
from tests.features.serve.test_serve_version_bridge import DIAGRAM
from tests.features.serve.test_serve_theme import SRC
from tests.features.serve.test_serve_versions_shell import BANNER, VersionSite
from tests.test_widget_versions import live

# A script the author wrote in the body, which never runs.
BODY_SCRIPT = '<script>document.title = "from the body";</script>'


class _Scripts(HTMLParser):
    """Each script element in order: whether in the head, its src, its nonce
    and its text."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.scripts: list[dict] = []
        self._in_head = False
        self._script: dict | None = None

    def handle_starttag(self, tag: str, attrs: list) -> None:
        values = dict(attrs)
        if tag == "head":
            self._in_head = True
        elif tag == "script":
            self._script = {"head": self._in_head, "src": values.get("src"),
                            "nonce": values.get("nonce"), "text": ""}

    def handle_data(self, data: str) -> None:
        if self._script is not None:
            self._script["text"] += data

    def handle_endtag(self, tag: str) -> None:
        if tag == "head":
            self._in_head = False
        elif tag == "script" and self._script is not None:
            self.scripts.append(self._script)
            self._script = None


def scripts_of(page: bytes) -> list[dict]:
    parser = _Scripts()
    parser.feed(page.decode("utf-8"))
    parser.close()
    return parser.scripts


class PublishedVersionSite(VersionSite):
    def publish_with_comments_page_only(self, edition: str) -> str:
        """Commit pond.html as published with comment boxes from edition's
        source, and no source: a page published before sources were kept."""
        done = self.cli("publish", str(self.source(edition)), "--local", "--comments",
                        "--out-dir", str(self.scratch))
        self.case.assertEqual(done.returncode, 0, done.stderr)
        shutil.copyfile(self.scratch / "pond.html", self.out / "pond.html")
        return self.commit("pond.html")


class PublishedVersionTests(unittest.TestCase):
    def test_a_version_answered_as_published_runs_todays_theme_head(self):
        site = PublishedVersionSite(self)
        first = site.publish_with_comments_page_only("first")
        site.publish("second")
        self.assertNotIn("pond.md", git(site.out, "ls-tree", "--name-only", first).split())
        site.serve()

        status, headers, page = site.ask("GET", f"/pond.html?version={first}")
        self.assertEqual(status, 200, page)
        lines = [line for line in site.log().splitlines()
                 if f"pond.html?version={first}" in line
                 and "is answered from its published file" in line]
        self.assertEqual(len(lines), 1, site.log())
        self.assertIsNone(headers["ETag"])
        self.assertIn(BANNER, page)
        self.assertIn(b'class="artifact-theme-switch"', page)
        self.assertIn(b"artifact-copy-link", page)

        theme_head = (SRC / THEME_HEAD).read_text(encoding="utf-8")
        policy = headers["Content-Security-Policy"]
        nonce = re.search(r"'nonce-([^']+)'", policy).group(1)
        scripts = scripts_of(page)
        self.assertEqual(len(scripts), 2, scripts)
        self.assertEqual(scripts[0], {"head": True, "src": None, "nonce": None,
                                      "text": theme_head})
        self.assertTrue(scripts[1]["src"].startswith(OLD_VERSION_SCRIPT), scripts)
        self.assertEqual(scripts[1]["nonce"], nonce)

        self.assertIn("frame-ancestors 'none'; form-action 'none'; base-uri 'none'", policy)
        self.assertEqual(script_src(policy), [f"'nonce-{nonce}'", script_hash(theme_head)])
        self.assertEqual(script_src(shell_of(page).policy), ["'self'", script_hash(theme_head)])

    def test_no_script_of_the_stored_page_runs_and_its_head_is_never_allowed(self):
        """A stored head (an older package's text) is replaced by today's,
        and neither its text nor its hash reaches the answer; nor does
        Mermaid's start-up module, the page script, the widget bridge or a
        script written in the body."""
        site = PublishedVersionSite(self)
        source = site.source("first")
        source.write_text(source.read_text(encoding="utf-8") + "\n" + DIAGRAM + "\n\n"
                          + live("First forecast") + "\n", encoding="utf-8")
        done = site.cli("publish", str(source), "--local", "--comments",
                        "--out-dir", str(site.scratch))
        self.assertEqual(done.returncode, 0, done.stderr)
        theme_head = (SRC / THEME_HEAD).read_text(encoding="utf-8")
        other = theme_head + ADDED
        published = (site.scratch / "pond.html").read_text(encoding="utf-8")
        for held in (f"<script>{theme_head}</script>", script_hash(theme_head),
                     'type="module"', PAGE_SCRIPT, "installWidgetBridge"):
            self.assertIn(held, published)
        # Markdown escapes a script, so the body's is written in the file.
        intro = "<p>The first edition.</p>\n"
        self.assertEqual(published.count(intro), 1)
        stored = published.replace(intro, intro + BODY_SCRIPT + "\n").replace(f"<script>{theme_head}</script>", f"<script>{other}</script>")
        stored = stored.replace(script_hash(theme_head), script_hash(other))
        self.assertNotIn(theme_head + "</script>", stored)
        (site.out / "pond.html").write_text(stored, encoding="utf-8")
        first = site.commit("pond.html")
        site.publish("second")
        site.serve()

        status, headers, page = site.ask("GET", f"/pond.html?version={first}")
        self.assertEqual(status, 200, page)
        self.assertIn("is answered from its published file", site.log())
        policy = headers["Content-Security-Policy"]
        for absent in (other, script_hash(other)):
            self.assertNotIn(absent.encode("utf-8"), page)
            self.assertNotIn(absent, policy)
        scripts = scripts_of(page)
        self.assertNotIn(b'type="module"', page)
        self.assertFalse([script for script in scripts if PAGE_SCRIPT in (script["src"] or "")
                          or "installWidgetBridge" in script["text"]])
        self.assertNotIn(BODY_SCRIPT.encode("utf-8"), page)
        self.assertEqual([script["text"] for script in scripts if script["src"] is None],
                         [theme_head])
        self.assertEqual(len(scripts), 2, scripts)
        self.assertTrue(scripts[0]["head"], scripts)
        nonce = re.search(r"'nonce-([^']+)'", policy).group(1)
        self.assertTrue(scripts[1]["src"].startswith(OLD_VERSION_SCRIPT), scripts)
        self.assertEqual(scripts[1]["nonce"], nonce)
        self.assertEqual(script_src(policy), [f"'nonce-{nonce}'", script_hash(theme_head)])
        self.assertEqual(script_src(shell_of(page).policy), ["'self'", script_hash(theme_head)])


if __name__ == "__main__":
    unittest.main()
