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
import unittest

from lotuspod.core import OLD_VERSION_SCRIPT, PAGE_SCRIPT, script_hash
from tests.features.serve.test_serve_shell import ADDED, THEME_HEAD, script_src, shell_of
from tests.features.serve.test_serve_version_bridge import DIAGRAM
from tests.features.serve.test_serve_theme import SRC
from tests.features.serve.test_serve_versions_shell import VersionSite
from tests.test_widget_versions import live

# A script the author wrote in the body, which never runs.
BODY_SCRIPT = '<script>document.title = "from the body";</script>'


class PublishedVersionTests(unittest.TestCase):
    def test_a_version_answered_as_published_runs_todays_theme_head(self):
        """A stored head (an older package's text) is replaced by today's,
        and its hash leaves both policies; nor does Mermaid's start-up
        module, the page script, the widget bridge or a script written in
        the body run."""
        site = VersionSite(self)
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
        nonce = re.search(r"'nonce-([^']+)'", policy).group(1)
        self.assertEqual(page.count(b"<script"), 2, page)
        self.assertIn(f"<script>{theme_head}</script>\n</head>".encode("utf-8"), page)
        self.assertIn(f'<script nonce="{nonce}" src="{OLD_VERSION_SCRIPT}'.encode("utf-8"), page)
        self.assertEqual(script_src(policy), [f"'nonce-{nonce}'", script_hash(theme_head)])
        self.assertEqual(script_src(shell_of(page).policy), ["'self'", script_hash(theme_head)])


if __name__ == "__main__":
    unittest.main()
