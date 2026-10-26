"""An earlier version of a page with a live block keeps the template's widget
bridge, allowed by its hash, beside the theme head; no other of the page's own
scripts runs.

Each check runs a real `lotuspod publish` and `lotuspod serve` over a git
repository, with real git; no network.

Run from the repo root:

    python -m unittest tests.features.serve.test_serve_version_bridge -v
"""

from __future__ import annotations

from lotuspod.core import OLD_VERSION_SCRIPT, THEME_ROOT, script_hash
from lotuspod.features.widgets import widgets
from tests.features.history.test_versions_witness import DATES, PAGE, VersionsWitness
from tests.features.publish.test_publish_witness import parse
from tests.features.serve.test_serve_shell import script_src
from tests.test_widget_versions import live

THEME_HEAD = (THEME_ROOT / "core/ts/theme-head.js").read_text(encoding="utf-8")


class VersionBridgeTests(VersionsWitness):
    def test_an_old_version_keeps_the_bridge_and_allows_it_by_its_hash(self):
        self.repository(self.out)
        self.publish(PAGE, live("First forecast"), DATES[0])
        self.publish(PAGE, live("Changed forecast"), DATES[1])
        first = self.commits(self.out, PAGE)[-1]
        bridge = widgets.bridge_script()
        self.start_server()

        status, headers, data = self.get(f"/{PAGE}.html?version={first}")
        self.assertEqual(status, 200, data)
        scripts = parse(data.decode("utf-8")).find("script")
        self.assertEqual([node.text() or node.attrs.get("src", "").split("?")[0]
                          for node in scripts], [bridge, THEME_HEAD, OLD_VERSION_SCRIPT])
        self.assertEqual(script_src(headers["Content-Security-Policy"]),
                         [f"'nonce-{scripts[-1].attrs.get('nonce')}'", script_hash(THEME_HEAD),
                          script_hash(bridge)])

    def test_bridge_in_a_noscript_allows_no_hash(self):
        # With scripting on, a browser reads a noscript's content as text, so
        # the bridge there never runs; this parser still reads it as a script.
        self.repository(self.out)
        source = self.tmp / f"{PAGE}.html"
        source.write_text("<h1>Pond plan</h1><p>A plain first revision.</p>\n"
                          f"<noscript><script>{widgets.bridge_script()}</script></noscript>\n",
                          encoding="utf-8")
        done = self.cli("publish", str(source), "--local", "--out-dir", str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.publish(PAGE, live("Added forecast"), DATES[1])
        first = self.commits(self.out, PAGE)[-1]
        self.start_server()

        status, headers, data = self.get(f"/{PAGE}.html?version={first}")
        self.assertEqual(status, 200, data)
        scripts = parse(data.decode("utf-8")).find("script")
        self.assertEqual(script_src(headers["Content-Security-Policy"]),
                         [f"'nonce-{scripts[-1].attrs.get('nonce')}'", script_hash(THEME_HEAD)])
