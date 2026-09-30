"""Test suite for the page policy: every artifact page carries a
Content-Security-Policy that lets it run only the site's own script files,
the pinned Mermaid and the inline scripts the page template writes; serve
adds the headers a meta tag cannot carry; render and publish name the body
scripts that will not run.

The policy is witnessed by parsing the page, never by matching strings.

Run from the repo root:

    python -m unittest tests.test_page_policy -v
"""

from __future__ import annotations

import base64
import hashlib
import threading
import urllib.request
from html.parser import HTMLParser

from tests.test_manifest_v2 import TempDirTestCase, cli, run_cli

MERMAID_DIR = "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/"

PROSE = "<h2>One</h2>\n<p>Plain prose.</p>\n<h2>Two</h2>\n<p>More prose.</p>\n"
DIAGRAM = '<p>A diagram.</p>\n<pre class="mermaid">graph TD; A --> B</pre>\n'

INLINE_SCRIPT = '<script>document.title = "ran";</script>'
REMOTE_SCRIPT = '<script src="https://scripts.example.com/widget.js"></script>'
HANDLER_BUTTON = '<button type="button" onclick="document.title = \'clicked\'">Press</button>'
SCRIPTED_SOURCE = (
    "<h1>Scripted page</h1>\n"
    f"<p>Before.</p>\n{INLINE_SCRIPT}\n{REMOTE_SCRIPT}\n<p>{HANDLER_BUTTON}</p>\n"
)


class _PageReader(HTMLParser):
    """Read the head's policy meta tags and every inline script's text."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.policies: list[str] = []
        self.inline_scripts: list[dict] = []
        self._in_head = False
        self._script: dict | None = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "head":
            self._in_head = True
        elif (
            tag == "meta"
            and self._in_head
            and (attrs.get("http-equiv") or "").lower() == "content-security-policy"
        ):
            self.policies.append(attrs.get("content") or "")
        elif tag == "script" and "src" not in attrs:
            self._script = {"attrs": attrs, "text": []}

    def handle_data(self, data):
        if self._script is not None:
            self._script["text"].append(data)

    def handle_endtag(self, tag):
        if tag == "head":
            self._in_head = False
        elif tag == "script" and self._script is not None:
            self._script["text"] = "".join(self._script["text"])
            self.inline_scripts.append(self._script)
            self._script = None


def read_page(page_html: str) -> _PageReader:
    reader = _PageReader()
    reader.feed(page_html)
    reader.close()
    return reader


def directives(policy: str) -> dict[str, list[str]]:
    parsed = {}
    for directive in policy.split(";"):
        words = directive.split()
        if words:
            parsed[words[0]] = words[1:]
    return parsed


def sha256_source(text: str) -> str:
    digest = hashlib.sha256(text.encode("utf-8")).digest()
    return "'sha256-" + base64.b64encode(digest).decode("ascii") + "'"


class PolicyTestCase(TempDirTestCase):
    def render_body(self, name: str, body: str) -> tuple[str, str]:
        rc, _, err = self.render(name, "--date", "2026-01-02", "--body", body)
        self.assertEqual(rc, 0, err)
        return (self.out_dir / f"{name}.html").read_text(encoding="utf-8"), err

    def policy_of(self, page_html: str) -> dict[str, list[str]]:
        policies = read_page(page_html).policies
        self.assertEqual(len(policies), 1, "one policy meta tag in the head")
        return directives(policies[0])


class PolicyTagTests(PolicyTestCase):
    def test_a_page_without_scripts_or_diagram_runs_only_the_sites_files(self):
        page, err = self.render_body("prose", PROSE)
        policy = self.policy_of(page)
        self.assertEqual(policy["script-src"], ["'self'"])
        self.assertEqual(policy["default-src"], ["'self'"])
        self.assertEqual(policy["object-src"], ["'none'"])
        self.assertEqual(policy["base-uri"], ["'none'"])
        self.assertEqual(policy["style-src"], ["'self'", "'unsafe-inline'"])
        self.assertEqual(policy["img-src"], ["'self'", "data:"])
        self.assertEqual(policy["connect-src"], ["'self'"])
        self.assertEqual(policy["form-action"], ["'self'"])
        self.assertEqual(read_page(page).inline_scripts, [])
        self.assertNotIn("will not run", err)

    def test_a_diagram_page_allows_mermaid_and_the_hash_of_its_start_up_module(self):
        page, _ = self.render_body("diagram", DIAGRAM)
        scripts = read_page(page).inline_scripts
        self.assertEqual(len(scripts), 1)
        (module,) = scripts
        self.assertEqual(module["attrs"].get("type"), "module")
        self.assertIn(MERMAID_DIR, module["text"])

        script_src = self.policy_of(page)["script-src"]
        hashes = [source for source in script_src if source.startswith("'sha256-")]
        self.assertEqual(hashes, [sha256_source(module["text"])])
        self.assertEqual(sorted(script_src), sorted(["'self'", MERMAID_DIR, *hashes]))


class BodyScriptTests(PolicyTestCase):
    def test_published_body_scripts_are_kept_listed_nowhere_and_named(self):
        source = self.out_dir / "scripted.source.html"
        source.write_text(SCRIPTED_SOURCE, encoding="utf-8")
        site = self.out_dir / "site"
        rc, out, err = run_cli(
            "publish", "--local", str(source), "--name", "scripted",
            "--date", "2026-01-02", "--out-dir", str(site),
        )
        self.assertEqual(rc, 0, err)

        page = (site / "scripted.html").read_text(encoding="utf-8")
        for markup in (INLINE_SCRIPT, REMOTE_SCRIPT, HANDLER_BUTTON):
            with self.subTest(markup=markup):
                self.assertIn(markup, page)

        policy = self.policy_of(page)
        self.assertEqual(policy["script-src"], ["'self'"])
        allowed = " ".join(" ".join(sources) for sources in policy.values())
        self.assertNotIn("example.com", allowed)
        self.assertNotIn("sha256-", allowed)

        lines = [line for line in (out + err).splitlines() if "will not run" in line]
        self.assertEqual(len(lines), 1, out + err)
        self.assertIn("scripted", lines[0])
        self.assertIn("2 scripts will not run", lines[0])

    def test_a_body_script_is_never_hashed_even_beside_a_diagram(self):
        page, err = self.render_body("both", DIAGRAM + INLINE_SCRIPT + "\n")
        script_src = self.policy_of(page)["script-src"]
        body_script = 'document.title = "ran";'
        self.assertNotIn(sha256_source(body_script), script_src)
        self.assertEqual(
            len([source for source in script_src if source.startswith("'sha256-")]), 1
        )
        self.assertIn("1 script will not run", err)


class ServeHeaderTests(PolicyTestCase):
    def test_a_served_page_forbids_framing_and_sniffing(self):
        self.render_body("prose", PROSE)
        server = cli._make_server(self.out_dir, "127.0.0.1", 0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        url = f"http://127.0.0.1:{server.server_address[1]}/prose.html"
        with urllib.request.urlopen(url, timeout=10) as response:
            self.assertEqual(response.status, 200)
            self.assertEqual(
                response.headers.get_all("Content-Security-Policy"),
                ["frame-ancestors 'none'"],
            )
            self.assertEqual(response.headers.get_all("X-Content-Type-Options"), ["nosniff"])


if __name__ == "__main__":
    import unittest

    unittest.main()
