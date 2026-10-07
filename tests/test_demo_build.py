"""Test suite for `python -m demo.build`, the demo site's build.

The demo site is Lotuspod's README and docs pages and a "Try it" page, each
published with the real `lotuspod publish --local`, as a directory of static
files. This file builds it once into a temporary directory and witnesses
the site: every page there and made by publish, every relative link and
anchor landing, the page list moved to pages.html with / redirecting to the
README's page, the demo banner first in every body, the Try it page's forms
and comment boxes, the static host's headers, no noindex, and scripts only
from the site or the Mermaid directory. It also witnesses that a link to no
file fails the build, that a page published outside the build holds none of
the demo, and that `--serve` answers over HTTP.

Run from the repo root:

    python -m unittest tests.test_demo_build -v
"""

from __future__ import annotations

import contextlib
import io
import os
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.error
import urllib.request
from html.parser import HTMLParser
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = REPO_ROOT / "src"
sys.path.insert(0, str(SRC_DIR))

from demo import build  # noqa: E402
from lotuspod import cli  # noqa: E402

PAGES = ("readme.html", "publishing.html", "comments.html", "agents.html", "operating.html",
         "development.html", "architecture.html", "try-it.html")
BANNER_TEXT = ("Demo: what you write stays in this browser. "
               "Replies are scripted; no AI model runs.")
ABSOLUTE = re.compile(r"^(?:[a-z][a-z0-9+.-]*:|//)", re.IGNORECASE)
NOT_TEXT = frozenset({"code", "pre", "script", "style"})
VOID = frozenset({"area", "br", "col", "embed", "hr", "img", "input", "link", "meta",
                  "source", "track", "wbr"})


class Page(HTMLParser):
    """What the tests read from a page: its ids, hrefs, script srcs, its
    text outside code, the body's first element and the elements inside
    it, the topbar brand link's href, the policy, and its forms and boxes."""

    def __init__(self, text: str) -> None:
        super().__init__(convert_charrefs=True)
        self.ids: set[str] = set()
        self.hrefs: list[str] = []
        self.script_srcs: list[str] = []
        self.text: list[str] = []
        self.policy = ""
        self.brand_hrefs: list[str] = []
        self.decision_forms = 0
        self.comment_sections: list[str] = []
        self.h2_ids: list[str] = []
        self.first: tuple[str, dict] | None = None
        self.first_text = ""
        self.first_inside: list[tuple[str, dict]] = []
        self._in_body = False
        self._skip = 0
        self._stack: list[str] = []
        self._first_depth: int | None = None
        self.feed(text)
        self.close()

    def handle_starttag(self, tag: str, attrs: list) -> None:
        values = {key: value or "" for key, value in attrs}
        classes = values.get("class", "").split()
        if values.get("id"):
            self.ids.add(values["id"])
        if "href" in values:
            self.hrefs.append(values["href"])
        if tag == "script" and "src" in values:
            self.script_srcs.append(values["src"])
        if tag == "meta" and values.get("http-equiv") == "Content-Security-Policy":
            self.policy = values.get("content", "")
        if tag == "a" and "artifact-topbar-brand" in classes:
            self.brand_hrefs.append(values.get("href", ""))
        if tag == "form" and "artifact-decision" in classes:
            self.decision_forms += 1
        if tag == "details" and "artifact-comment" in classes:
            self.comment_sections.append(values.get("data-section", ""))
        if tag == "h2" and values.get("id") and self._in_body:
            self.h2_ids.append(values["id"])
        if tag == "body":
            self._in_body = True
        elif self._in_body and self.first is None:
            self.first = (tag, values)
            self._first_depth = len(self._stack)
        elif self._first_depth is not None:
            self.first_inside.append((tag, values))
        if tag in NOT_TEXT:
            self._skip += 1
        if tag not in VOID:
            self._stack.append(tag)

    def handle_endtag(self, tag: str) -> None:
        if tag in NOT_TEXT and self._skip:
            self._skip -= 1
        if tag in self._stack:
            while self._stack.pop() != tag:
                pass
        if self._first_depth is not None and len(self._stack) <= self._first_depth:
            self._first_depth = None

    def handle_data(self, data: str) -> None:
        if not self._skip:
            self.text.append(data)
        if self._first_depth is not None:
            self.first_text += data


def read_page(path: Path) -> Page:
    return Page(path.read_text(encoding="utf-8"))


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


class BuiltSiteTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls._tmp = tempfile.TemporaryDirectory()
        cls.out = Path(cls._tmp.name) / "site"
        done = subprocess.run([sys.executable, "-m", "demo.build", "--out", str(cls.out)],
                              cwd=REPO_ROOT, capture_output=True, text=True)
        if done.returncode != 0:
            raise AssertionError(f"the build failed: {done.stderr}")
        cls.pages = {path.name: read_page(path) for path in sorted(cls.out.glob("*.html"))}

    @classmethod
    def tearDownClass(cls) -> None:
        cls._tmp.cleanup()

    def test_the_site_holds_each_page_and_the_page_list_but_no_index(self):
        for name in (*PAGES, "pages.html"):
            with self.subTest(page=name):
                self.assertTrue((self.out / name).is_file())
        self.assertFalse((self.out / "index.html").exists())

    def test_each_page_was_made_by_publish(self):
        for name in PAGES:
            with self.subTest(page=name):
                text = (self.out / name).read_text(encoding="utf-8")
                self.assertRegex(text, r'<meta name="lotuspod:revision" content="[0-9a-f]+">')

    def test_every_relative_link_names_a_file_and_an_id_there(self):
        checked = 0
        for name, page in self.pages.items():
            for href in page.hrefs:
                if ABSOLUTE.match(href):
                    continue
                path, _, anchor = href.partition("#")
                path = path.split("?")[0]
                with self.subTest(page=name, href=href):
                    file = (self.out / path.lstrip("/")) if path else self.out / name
                    self.assertTrue(file.is_file(), f"{href} from {name}: no such file")
                    if anchor:
                        self.assertIn(anchor, read_page(file).ids,
                                      f"{href} from {name}: no such id")
                checked += 1
        self.assertGreater(checked, 50)

    def test_links_between_sources_name_their_pages(self):
        self.assertIn("publishing.html", self.pages["readme.html"].hrefs)
        self.assertIn("development.html#captures", self.pages["readme.html"].hrefs)
        self.assertIn("readme.html", self.pages["publishing.html"].hrefs)
        self.assertIn("https://github.com/wevial/lotuspod/blob/main/deploy/README.md",
                      self.pages["operating.html"].hrefs)

    def test_no_link_syntax_is_left_outside_code(self):
        for name, page in self.pages.items():
            with self.subTest(page=name):
                self.assertNotIn("](", "".join(page.text))

    def test_the_root_and_index_redirect_to_the_readme(self):
        lines = (self.out / "_redirects").read_text(encoding="utf-8").splitlines()
        self.assertIn("/ /readme.html 302", lines)
        self.assertIn("/index.html /readme.html 302", lines)

    def test_each_brand_link_points_at_the_page_list(self):
        for name in PAGES:
            with self.subTest(page=name):
                self.assertEqual(self.pages[name].brand_hrefs, ["pages.html"])

    def test_the_banner_is_first_in_every_body(self):
        commit = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=REPO_ROOT,
                                capture_output=True, text=True, check=True).stdout.strip()
        for name, page in self.pages.items():
            with self.subTest(page=name):
                tag, attrs = page.first
                self.assertEqual(tag, "div")
                self.assertIn("demo-banner", attrs.get("class", "").split())
                self.assertEqual(attrs.get("role"), "note")
                self.assertIn(BANNER_TEXT, page.first_text)
                self.assertIn(commit, page.first_text)
                self.assertIn(("a", {"class": "demo-banner-try", "href": "try-it.html"}),
                              page.first_inside)
                buttons = [attrs for tag, attrs in page.first_inside if tag == "button"]
                self.assertEqual(len(buttons), 1)
                self.assertIn("Reset demo", page.first_text)
                self.assertIn("lotuspod-demo.css", page.hrefs)
        self.assertTrue((self.out / "lotuspod-demo.css").is_file())

    def test_try_it_holds_two_decision_forms_and_a_box_on_each_section(self):
        page = self.pages["try-it.html"]
        self.assertEqual(page.decision_forms, 2)
        self.assertGreaterEqual(len(page.h2_ids), 2)
        self.assertEqual(page.comment_sections, page.h2_ids)

    def test_the_headers_file_sets_three_headers_for_every_path(self):
        lines = (self.out / "_headers").read_text(encoding="utf-8").splitlines()
        self.assertEqual(lines[0], "/*")
        self.assertEqual([line.strip() for line in lines[1:]], [
            "Content-Security-Policy: frame-ancestors 'none'",
            "X-Content-Type-Options: nosniff",
            "Referrer-Policy: no-referrer",
        ])

    def test_no_file_says_noindex(self):
        for path in self.out.rglob("*"):
            if path.is_file():
                with self.subTest(file=path.name):
                    self.assertNotIn(b"noindex", path.read_bytes().lower())

    def test_scripts_load_from_the_site_or_the_mermaid_directory_only(self):
        for name, page in self.pages.items():
            allowed = [source for directive in page.policy.split(";")
                       if directive.strip().startswith("script-src")
                       for source in directive.split()[1:] if source.startswith("https://")]
            for src in page.script_srcs:
                with self.subTest(page=name, src=src):
                    if ABSOLUTE.match(src):
                        self.assertTrue(any(src.startswith(source) for source in allowed),
                                        src)
                    else:
                        self.assertFalse(src.startswith("/"), src)


class BrokenLinkTests(unittest.TestCase):
    def test_a_link_to_no_file_fails_naming_the_source_and_the_target(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "checkout"
            (root / "docs").mkdir(parents=True)
            (root / "README.md").write_text("# Readme\n\nSee [the guide](docs/guide.md).\n",
                                            encoding="utf-8")
            (root / "docs" / "guide.md").write_text(
                "# Guide\n\nSee [nothing](no-such-page.md).\n", encoding="utf-8")
            out = Path(tmp) / "site"
            sources = (("README.md", "readme"), ("docs/guide.md", "guide"))
            stderr = io.StringIO()
            with mock.patch.object(build, "REPO_ROOT", root), \
                    mock.patch.object(build, "SOURCES", sources), \
                    contextlib.redirect_stderr(stderr):
                code = build.main(["--out", str(out)])
            self.assertNotEqual(code, 0)
            self.assertIn("docs/guide.md", stderr.getvalue())
            self.assertIn("no-such-page.md", stderr.getvalue())
            self.assertFalse(out.exists())

    def test_a_missing_source_fails_naming_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            stderr = io.StringIO()
            sources = (*build.SOURCES, ("docs/no-such-source.md", "nothing"))
            with mock.patch.object(build, "SOURCES", sources), \
                    contextlib.redirect_stderr(stderr):
                code = build.main(["--out", str(Path(tmp) / "site")])
            self.assertNotEqual(code, 0)
            self.assertIn("docs/no-such-source.md", stderr.getvalue())


class OutsideTheBuildTests(unittest.TestCase):
    def test_a_page_published_outside_the_build_holds_none_of_the_demo(self):
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "artifacts"
            env = {**os.environ, "PYTHONPATH": str(SRC_DIR),
                   "LOTUSPOD_CONFIG": str(Path(tmp) / "no-such-config.ini")}
            subprocess.run(
                [sys.executable, "-m", "lotuspod", "publish",
                 str(REPO_ROOT / "demo" / "pages" / "try-it.md"), "--local",
                 "--out-dir", str(out), "--name", "try-it"],
                cwd=tmp, env=env, capture_output=True, check=True,
            )
            text = (out / "try-it.html").read_text(encoding="utf-8")
            self.assertNotIn("demo-banner", text)
            self.assertNotIn("lotuspod-demo.css", text)
            (out / "lotuspod-demo.css").write_bytes(build.STYLESHEET.read_bytes())
            allowed = cli.serve_allow_list(out)
            self.assertIn("try-it.html", allowed)
            self.assertNotIn("lotuspod-demo.css", allowed)


class ServeTests(unittest.TestCase):
    def fetch(self, url: str, deadline: float) -> bytes:
        while True:
            try:
                with urllib.request.urlopen(url, timeout=5) as answer:
                    self.assertEqual(answer.status, 200)
                    return answer.read()
            except (urllib.error.URLError, ConnectionError):
                if time.monotonic() > deadline:
                    raise
                time.sleep(0.2)

    def test_serve_answers_the_root_with_the_readme_and_try_it(self):
        port = free_port()
        server = subprocess.Popen(
            [sys.executable, "-m", "demo.build", "--serve", "--port", str(port)],
            cwd=REPO_ROOT, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        try:
            deadline = time.monotonic() + 60
            root = self.fetch(f"http://127.0.0.1:{port}/", deadline).decode("utf-8")
            try_it = self.fetch(f"http://127.0.0.1:{port}/try-it.html", deadline)
        finally:
            server.send_signal(signal.SIGTERM)
            code = server.wait(timeout=30)
        readme = Page(root)
        self.assertIn("<title>Lotuspod · Lotuspod</title>", root)
        self.assertIn('data-page="readme"', root)
        self.assertEqual(readme.first[1].get("class"), "demo-banner")
        self.assertIn(b"Planting the new pond", try_it)
        self.assertEqual(code, 0)


if __name__ == "__main__":
    unittest.main()
