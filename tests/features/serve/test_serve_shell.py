"""serve answers each page rendered when it is asked for: from the page's
kept source (or the body extracted from its published file), the stamps its
published file carries and today's template, so no page keeps an old look.
The published file stays as publish wrote it.

Each check runs a real `lotuspod serve` and `lotuspod publish`, with real git
and a local bare repository where a repository is named; no network. The
fixtures are tests/fixtures/old-template/: old-shell.html with old-shell.md,
and old-live.html with old-live.md and its frame, published before the theme
switch.

Run from the repo root:

    python -m unittest tests.features.serve.test_serve_shell -v
"""

from __future__ import annotations

import base64
import hashlib
import http.client
import json
import re
import shutil
import subprocess
import sys
import threading
import time
import unittest
from unittest import mock
from html.parser import HTMLParser
from pathlib import Path

from lotuspod.features.serve import pages
from tests import access_keys as keys
from tests.features.serve.test_serve_theme import SRC, ServedSite

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures" / "old-template"
THEME_HEAD = Path("lotuspod") / "core" / "ts" / "theme-head.js"
WIDGET_FRAME = SRC / "lotuspod" / "features" / "widgets" / "ts" / "widget-frame.js"
SHELL_REVISION = "48dada2b3407"
LIVE_FRAME = "old-live.w-d70798c06a89.html"
# The statement a changed theme head gains.
ADDED = '\ndocument.documentElement.setAttribute("data-shell-check", "1");\n'


def git(cwd: Path, *argv: str) -> str:
    return subprocess.run(["git", "-C", str(cwd), *argv], capture_output=True, text=True,
                          check=True).stdout


class _Shell(HTMLParser):
    """A page's inline scripts, policy, revision, h2 ids and widget frames."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=False)
        self.scripts: list[str] = []
        self.policy = ""
        self.revision = ""
        self.ids: list[str] = []
        self.frames: list[str] = []
        self._script: list[str] | None = None

    def handle_starttag(self, tag: str, attrs: list) -> None:
        values = dict(attrs)
        if tag == "script" and "src" not in values:
            self._script = []
        elif tag == "meta" and values.get("http-equiv") == "Content-Security-Policy":
            self.policy = values.get("content") or ""
        elif tag == "meta" and values.get("name") == "lotuspod:revision":
            self.revision = values.get("content") or ""
        elif tag == "h2":
            self.ids.append(values.get("id") or "")
        elif tag == "iframe" and "artifact-widget" in (values.get("class") or "").split():
            self.frames.append(values.get("src") or "")

    def handle_data(self, data: str) -> None:
        if self._script is not None:
            self._script.append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "script" and self._script is not None:
            self.scripts.append("".join(self._script))
            self._script = None


def shell_of(page: bytes) -> _Shell:
    parser = _Shell()
    parser.feed(page.decode("utf-8"))
    parser.close()
    return parser


def script_src(policy: str) -> list[str]:
    for directive in policy.split(";"):
        words = directive.split()
        if words and words[0] == "script-src":
            return words[1:]
    return []


class Site(ServedSite):
    """A served site whose /api trusts the test key, served from src."""

    def __init__(self, case: unittest.TestCase, *fixtures: str) -> None:
        super().__init__(case)
        (self.tmp / "config.ini").write_text(keys.config_text(), encoding="utf-8")
        self.server: subprocess.Popen | None = None
        for name in fixtures:
            shutil.copyfile(FIXTURES / name, self.out / name)

    def serve(self, src: Path = SRC) -> None:
        self.stop()
        self.env["PYTHONPATH"] = str(src)
        self.server = self.start()

    def stop(self) -> None:
        if self.server is not None:
            self.server.terminate()
            self.server.wait(10)
            self.server = None

    def ask(self, method: str, path: str, headers: dict | None = None,
            body: object = None) -> tuple[int, http.client.HTTPMessage, bytes]:
        sent = {"Cf-Access-Jwt-Assertion": keys.assertion(), **(headers or {})}
        raw = None
        if body is not None:
            raw = json.dumps(body).encode("utf-8")
            sent["Content-Type"] = "application/json"
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        try:
            conn.request(method, path, body=raw, headers=sent)
            response = conn.getresponse()
            return response.status, response.headers, response.read()
        finally:
            conn.close()

    def files(self) -> dict[str, bytes]:
        """Each file of the output directory, .git aside, to its bytes."""
        return {path.relative_to(self.out).as_posix(): path.read_bytes()
                for path in self.out.rglob("*")
                if path.is_file() and ".git" not in path.relative_to(self.out).parts}

    def ok(self, *argv: str) -> None:
        done = self.cli(*argv, "--out-dir", str(self.out))
        self.case.assertEqual(done.returncode, 0, done.stderr)


def changed_src(case: unittest.TestCase, into: Path) -> Path:
    """A copy of src/ whose theme head gains one statement."""
    copy = into / "changed-src"
    shutil.copytree(SRC, copy, ignore=shutil.ignore_patterns("__pycache__"))
    with (copy / THEME_HEAD).open("a", encoding="utf-8") as head:
        head.write(ADDED)
    case.addCleanup(shutil.rmtree, copy, True)
    return copy


class RenderedShellTests(unittest.TestCase):
    def test_an_old_page_is_answered_in_todays_shell_and_its_file_stays(self):
        site = Site(self, "old-shell.html", "old-shell.md")
        published = (site.out / "old-shell.html").read_bytes()
        site.serve()

        status, headers, page = site.ask("GET", "/old-shell.html")
        self.assertEqual(status, 200)
        self.assertIn(b'class="artifact-theme-switch"', page)
        shell = shell_of(page)
        theme_head = (SRC / THEME_HEAD).read_text(encoding="utf-8")
        self.assertIn(theme_head, shell.scripts)
        digest = hashlib.sha256(theme_head.encode("utf-8")).digest()
        self.assertIn(f"'sha256-{base64.b64encode(digest).decode('ascii')}'",
                      script_src(shell.policy))
        self.assertEqual(shell.revision, SHELL_REVISION)
        self.assertEqual(shell.ids, ["findings", "next-steps"])
        self.assertEqual(headers["Cache-Control"], "no-cache")
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(headers["Content-Security-Policy"], "frame-ancestors 'self'")
        self.assertEqual((site.out / "old-shell.html").read_bytes(), published)

    def test_the_etag_holds_until_the_page_is_published_again(self):
        site = Site(self, "old-shell.html", "old-shell.md")
        site.serve()

        _, first, _ = site.ask("GET", "/old-shell.html")
        _, second, _ = site.ask("GET", "/old-shell.html")
        tag = first["ETag"]
        self.assertTrue(tag)
        self.assertEqual(second["ETag"], tag)
        status, _, body = site.ask("GET", "/old-shell.html", {"If-None-Match": tag})
        self.assertEqual((status, body), (304, b""))
        status, headers, body = site.ask("HEAD", "/old-shell.html")
        self.assertEqual((status, headers["ETag"], body), (200, tag, b""))

        source = site.out / "old-shell.md"
        source.write_text(source.read_text(encoding="utf-8").replace(
            "The pond freezes in January.", "The pond freezes in December."), encoding="utf-8")
        site.ok("publish", str(source), "--local")

        status, headers, page = site.ask("GET", "/old-shell.html", {"If-None-Match": tag})
        self.assertEqual(status, 200)
        self.assertNotEqual(headers["ETag"], tag)
        self.assertIn(b"The pond freezes in December.", page)

    def test_a_changed_theme_head_reaches_the_page_at_restart_and_writes_nothing(self):
        site = Site(self, "old-shell.html", "old-shell.md")
        site.serve()
        _, before, page = site.ask("GET", "/old-shell.html")
        files = site.files()
        self.assertNotIn(ADDED.strip(), page.decode("utf-8"))

        changed = changed_src(self, site.tmp)
        site.serve(changed)
        status, after, page = site.ask("GET", "/old-shell.html")
        self.assertEqual(status, 200)
        theme_head = (changed / THEME_HEAD).read_text(encoding="utf-8")
        self.assertIn(theme_head, shell_of(page).scripts)
        self.assertNotEqual(after["ETag"], before["ETag"])
        self.assertEqual(site.files(), files)

    def test_a_restart_adds_no_version_and_no_commit(self):
        site = Site(self)
        bare = site.tmp / "origin.git"
        git(site.tmp, "init", "-q", "--bare", "-b", "main", str(bare))
        shutil.rmtree(site.out)
        git(site.tmp, "clone", "-q", str(bare), str(site.out))
        for key, value in (("user.name", "Lotuspod Test"), ("user.email", "test@example.com"),
                           ("commit.gpgsign", "false")):
            git(site.out, "config", key, value)
        source = site.tmp / "pond.md"
        for edition in ("first", "second", "third"):
            source.write_text(f"# Pond\n\nThe {edition} edition.\n", encoding="utf-8")
            site.ok("publish", str(source), "--local")
        head = git(site.out, "rev-parse", "HEAD")
        self.assertEqual(git(bare, "rev-parse", "main"), head)

        def versions() -> list[str]:
            status, _, page = site.ask("GET", "/pond.html")
            self.assertEqual(status, 200)
            self.assertIn(b"The third edition.", page)
            status, _, body = site.ask("GET", "/api/versions?page=pond")
            self.assertEqual(status, 200, body)
            return [version["commit"] for version in json.loads(body)["versions"]]

        site.serve()
        listed = versions()
        self.assertEqual(len(listed), 3)
        site.serve(changed_src(self, site.tmp))
        self.assertEqual(versions(), listed)
        self.assertEqual(git(site.out, "rev-parse", "HEAD"), head)
        self.assertEqual(git(bare, "rev-parse", "main"), head)
        self.assertEqual(git(site.out, "status", "--porcelain"), "")

    def test_a_live_block_keeps_its_frame_name_and_threads(self):
        site = Site(self, "old-live.html", "old-live.md", LIVE_FRAME)
        site.serve()

        status, _, page = site.ask("GET", "/old-live.html")
        self.assertEqual(status, 200)
        self.assertIn(b'class="artifact-theme-switch"', page)
        self.assertEqual(shell_of(page).frames, [LIVE_FRAME])

        status, headers, frame = site.ask("GET", f"/{LIVE_FRAME}", {"Sec-Fetch-Dest": "iframe"})
        self.assertEqual(status, 200)
        self.assertIn(WIDGET_FRAME.read_text(encoding="utf-8"), frame.decode("utf-8"))
        self.assertNotEqual(frame, (FIXTURES / LIVE_FRAME).read_bytes())
        self.assertEqual(headers["Content-Security-Policy"],
                         "sandbox allow-scripts; frame-ancestors 'self'")
        self.assertEqual(headers["X-Content-Type-Options"], "nosniff")
        self.assertEqual(headers["Vary"], "Sec-Fetch-Dest")
        self.assertTrue(headers["Permissions-Policy"])

        block_hash = re.fullmatch(r"old-live\.w-([0-9a-f]{12})\.html", LIVE_FRAME).group(1)
        status, _, body = site.ask("POST", "/api/comments", body={
            "page": "old-live", "section": "the-pond", "text": "How deep is it now?",
            "widget": {"id": "depth", "hash": block_hash, "state": ""}})
        self.assertEqual(status, 201, body)
        self.assertEqual(json.loads(body)["widget"]["id"], "depth")

    def test_an_archived_page_is_rendered_and_what_was_refused_stays_refused(self):
        site = Site(self, "old-shell.html", "old-shell.md")
        site.ok("render", "--name", "secret", "--title", "Secret", "--hidden",
                "--body", "<p>Not listed.</p>")
        site.ok("archive", "old-shell", "--local")
        site.serve()

        status, _, page = site.ask("GET", "/old-shell.html")
        self.assertEqual(status, 200)
        self.assertIn(b'class="artifact-archived-banner"', page)
        self.assertIn(b'class="artifact-theme-switch"', page)
        for path in ("/secret.html", "/old-shell.md", "/manifest.json"):
            with self.subTest(path=path):
                self.assertEqual(site.ask("GET", path)[0], 404)


    def test_a_linked_source_is_never_rendered(self):
        site = Site(self, "old-shell.html")
        private = site.tmp / "private.md"
        private.write_text("# Old shell\n\nOutside the served directory.\n", encoding="utf-8")
        (site.out / "old-shell.md").symlink_to(private)
        site.serve()

        status, _, page = site.ask("GET", "/old-shell.html")
        self.assertEqual(status, 200)
        self.assertNotIn(b"Outside the served directory.", page)
        self.assertEqual(page, (FIXTURES / "old-shell.html").read_bytes())
        self.assertEqual(site.ask("GET", "/old-shell.md")[0], 404)


class RenderCacheTests(unittest.TestCase):
    def setUp(self):
        self.out = Site(self, "old-shell.html", "old-shell.md").out
        self.addCleanup(pages._RENDERS.clear)
        self.addCleanup(pages._FAILED.clear)

    def test_requests_that_miss_together_render_once(self):
        calls = []
        real = pages.render_kept_or_extracted

        def slow(out_dir, name):
            calls.append(name)
            time.sleep(0.2)
            return real(out_dir, name)

        with mock.patch.object(pages, "render_kept_or_extracted", slow):
            threads = [threading.Thread(target=pages.rendered_page, args=(self.out, "old-shell"))
                       for _ in range(6)]
            for thread in threads:
                thread.start()
            for thread in threads:
                thread.join()
        self.assertEqual(calls, ["old-shell"])

    def test_a_failed_render_is_logged_once_and_tried_again(self):
        def failing(out_dir, name):
            raise RuntimeError("an image is missing")

        with mock.patch.object(pages, "render_kept_or_extracted", failing), \
                mock.patch("sys.stderr") as stderr:
            for _ in range(3):
                self.assertFalse(pages.rendered_page(self.out, "old-shell").rendered)
        logged = "".join(call.args[0] for call in stderr.write.call_args_list)
        self.assertEqual(logged.count("old-shell.html is answered from its published file"), 1)
        self.assertTrue(pages.rendered_page(self.out, "old-shell").rendered)


if __name__ == "__main__":
    unittest.main()
