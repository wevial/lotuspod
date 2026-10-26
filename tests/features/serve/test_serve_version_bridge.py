"""An earlier version of a page with a live block keeps the template's widget
bridge, allowed by its hash, beside the theme head; no other of the page's own
scripts runs.

Each check runs a real `lotuspod publish` and `lotuspod serve` over a git
repository, with real git; no network.

Run from the repo root:

    python -m unittest tests.features.serve.test_serve_version_bridge -v
"""

from __future__ import annotations

from lotuspod.core import OLD_VERSION_SCRIPT, script_hash
from tests.features.history.test_versions_witness import DATES, PAGE, VersionsWitness
from tests.features.publish.test_publish_witness import parse
from tests.features.serve.test_serve_shell import script_src
from tests.test_widget_versions import live

DIAGRAM = "```mermaid\ngraph TD\n  A --> B\n```"


class VersionBridgeTests(VersionsWitness):
    def test_an_old_version_keeps_the_bridge_and_allows_it_by_its_hash(self):
        self.repository(self.out)
        self.publish(PAGE, live("First forecast") + "\n\n" + DIAGRAM, DATES[0])
        self.publish(PAGE, live("Changed forecast"), DATES[1])
        first = self.commits(self.out, PAGE)[-1]
        inline = [node.text() for node in parse((self.out / f"{PAGE}.html").read_text(
            encoding="utf-8")).find("script") if "src" not in node.attrs]
        (bridge,) = [text for text in inline if "installWidgetBridge()" in text]
        (theme_head,) = [text for text in inline if text != bridge
                         and '"lotuspod:theme"' in text]
        self.start_server()

        status, headers, data = self.get(f"/{PAGE}.html?version={first}")
        self.assertEqual(status, 200, data)
        scripts = parse(data.decode("utf-8")).find("script")
        self.assertEqual([node.text() or node.attrs.get("src", "").split("?")[0]
                          for node in scripts], [bridge, theme_head, OLD_VERSION_SCRIPT])
        self.assertEqual(script_src(headers["Content-Security-Policy"]),
                         [f"'nonce-{scripts[-1].attrs.get('nonce')}'",
                          script_hash(theme_head), script_hash(bridge)])
