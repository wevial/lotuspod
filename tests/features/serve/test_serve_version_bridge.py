"""An earlier version of a page with a live block keeps the template's widget
bridge, allowed by its hash, beside the theme head; no other of the page's own
scripts runs.

Each check runs a real `lotuspod publish` and `lotuspod serve` over a git
repository, with real git; no network.

Run from the repo root:

    python -m unittest tests.features.serve.test_serve_version_bridge -v
"""

from __future__ import annotations

from lotuspod.core import OLD_VERSION_SCRIPT, PAGE_SCRIPT, script_hash
from lotuspod.features.widgets import widgets
from tests.features.history.test_versions_witness import DATES, PAGE, VersionsWitness
from tests.features.publish.test_publish_witness import parse
from tests.features.serve.test_serve_shell import script_src
from tests.test_widget_versions import live

DIAGRAM = "```mermaid\ngraph TD\n  A --> B\n```"


def inline_scripts(page_html):
    """The text of each inline script of page_html, in order."""
    return [node.text() for node in parse(page_html).find("script") if "src" not in node.attrs]


class VersionBridgeTests(VersionsWitness):
    def test_an_old_version_keeps_the_bridge_and_allows_it_by_its_hash(self):
        self.repository(self.out)
        self.publish(PAGE, live("First forecast") + "\n\n" + DIAGRAM, DATES[0])
        self.publish(PAGE, live("Changed forecast"), DATES[1])
        first = self.commits(self.out, PAGE)[-1]
        inline = inline_scripts((self.out / f"{PAGE}.html").read_text(encoding="utf-8"))
        (bridge,) = [text for text in inline if "installWidgetBridge()" in text]
        (theme_head,) = [text for text in inline if text != bridge
                         and '"lotuspod:theme"' in text]
        self.start_server()

        status, headers, data = self.get(f"/{PAGE}.html?version={first}")
        self.assertEqual(status, 200, data)
        nonce = script_src(headers["Content-Security-Policy"])[0]
        self.assertTrue(nonce.startswith("'nonce-"), nonce)
        scripts = parse(data.decode("utf-8")).find("script")
        self.assertEqual([node.text() or node.attrs.get("src", "").split("?")[0]
                          for node in scripts], [bridge, theme_head, OLD_VERSION_SCRIPT])
        self.assertEqual(f"'nonce-{scripts[-1].attrs.get('nonce')}'", nonce)
        self.assertFalse([node for node in scripts if node.attrs.get("type") == "module"
                          or PAGE_SCRIPT in node.attrs.get("src", "")])
        self.assertEqual(script_src(headers["Content-Security-Policy"]),
                         [nonce, script_hash(theme_head), script_hash(bridge)])

    def test_an_old_version_without_a_live_block_holds_no_bridge(self):
        self.repository(self.out)
        self.publish(PAGE, "A plain first revision.", DATES[0])
        self.publish(PAGE, live("Added forecast"), DATES[1])
        first = self.commits(self.out, PAGE)[-1]
        inline = inline_scripts((self.out / f"{PAGE}.html").read_text(encoding="utf-8"))
        (theme_head,) = [text for text in inline if "installWidgetBridge()" not in text
                         and '"lotuspod:theme"' in text]
        self.start_server()

        status, headers, data = self.get(f"/{PAGE}.html?version={first}")
        self.assertEqual(status, 200, data)
        nonce = script_src(headers["Content-Security-Policy"])[0]
        scripts = parse(data.decode("utf-8")).find("script")
        self.assertEqual([node.text() or node.attrs.get("src", "").split("?")[0]
                          for node in scripts], [theme_head, OLD_VERSION_SCRIPT])
        self.assertFalse([node for node in scripts if "installWidgetBridge" in node.text()])
        self.assertEqual(f"'nonce-{scripts[-1].attrs.get('nonce')}'", nonce)
        self.assertEqual(script_src(headers["Content-Security-Policy"]),
                         [nonce, script_hash(theme_head)])

    def test_bridge_text_in_a_comment_allows_no_hash(self):
        self.repository(self.out)
        source = self.tmp / f"{PAGE}.html"
        source.write_text("<h1>Pond plan</h1><p>A plain first revision.</p>\n"
                          f"<!-- <script>{widgets.bridge_script()}</script> -->\n",
                          encoding="utf-8")
        done = self.cli("publish", str(source), "--local", "--out-dir", str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.publish(PAGE, live("Added forecast"), DATES[1])
        first = self.commits(self.out, PAGE)[-1]
        inline = inline_scripts((self.out / f"{PAGE}.html").read_text(encoding="utf-8"))
        (theme_head,) = [text for text in inline if "installWidgetBridge()" not in text
                         and '"lotuspod:theme"' in text]
        self.start_server()

        status, headers, data = self.get(f"/{PAGE}.html?version={first}")
        self.assertEqual(status, 200, data)
        self.assertIn("installWidgetBridge()", data.decode("utf-8"))
        scripts = parse(data.decode("utf-8")).find("script")
        self.assertEqual([node.text() or node.attrs.get("src", "").split("?")[0]
                          for node in scripts], [theme_head, OLD_VERSION_SCRIPT])
        self.assertEqual(script_src(headers["Content-Security-Policy"]),
                         [f"'nonce-{scripts[-1].attrs.get('nonce')}'", script_hash(theme_head)])

    def test_bridge_text_in_a_badge_allows_no_hash(self):
        self.repository(self.out)
        source = self.tmp / f"{PAGE}.html"
        source.write_text("<h1>Pond plan</h1><p>A plain first revision.</p>\n"
                          '<span class="artifact-live-badge">'
                          f"<script>{widgets.bridge_script()}</script></span>\n",
                          encoding="utf-8")
        done = self.cli("publish", str(source), "--local", "--out-dir", str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.publish(PAGE, live("Added forecast"), DATES[1])
        first = self.commits(self.out, PAGE)[-1]
        inline = inline_scripts((self.out / f"{PAGE}.html").read_text(encoding="utf-8"))
        (theme_head,) = [text for text in inline if "installWidgetBridge()" not in text
                         and '"lotuspod:theme"' in text]
        self.start_server()

        status, headers, data = self.get(f"/{PAGE}.html?version={first}")
        self.assertEqual(status, 200, data)
        scripts = parse(data.decode("utf-8")).find("script")
        self.assertEqual([node.text() or node.attrs.get("src", "").split("?")[0]
                          for node in scripts], [theme_head, OLD_VERSION_SCRIPT])
        self.assertEqual(script_src(headers["Content-Security-Policy"]),
                         [f"'nonce-{scripts[-1].attrs.get('nonce')}'", script_hash(theme_head)])
