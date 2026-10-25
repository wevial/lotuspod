"""serve answers an earlier version of a page (NAME.html?version=COMMIT)
rendered with today's template from that version's own content, read from
the artifacts repository at that commit: its kept source when the commit
holds one, else the body extracted from its published file then. It is
marked old as before, and the repository is only read. A version whose body
fails the extraction check is answered as published, as before.

Each check runs a real `lotuspod serve` and `lotuspod publish` over a clone
of a local bare repository, with real git; no network.

Run from the repo root:

    python -m unittest tests.features.serve.test_serve_versions_shell -v
"""

from __future__ import annotations

import re
import shutil
import unittest
from pathlib import Path
from unittest import mock

from lotuspod.core import OLD_VERSION_SCRIPT, theme_hash
from lotuspod.features.history import History, old_page
from lotuspod.features.publish import version_stamp
from lotuspod.features.serve import pages
from tests.features.serve.test_serve_shell import (FIXTURES, THEME_HEAD, Site, git, script_src,
                                                   shell_of)
from tests.features.serve.test_serve_theme import SRC

BANNER = b'class="artifact-version-banner"'
EDITIONS = ("first", "second", "third")


def revision_of(page: bytes) -> str:
    found = re.search(rb'<meta name="lotuspod:revision" content="([0-9a-f]+)">', page)
    return found.group(1).decode("ascii") if found else ""


class VersionSite(Site):
    """A served site whose output directory is a clone of a local bare
    repository."""

    def __init__(self, case: unittest.TestCase) -> None:
        super().__init__(case)
        self.bare = self.tmp / "origin.git"
        git(self.tmp, "init", "-q", "--bare", "-b", "main", str(self.bare))
        shutil.rmtree(self.out)
        git(self.tmp, "clone", "-q", str(self.bare), str(self.out))
        for key, value in (("user.name", "Lotuspod Test"), ("user.email", "test@example.com"),
                           ("commit.gpgsign", "false")):
            git(self.out, "config", key, value)
        self.scratch = self.tmp / "scratch"

    def commit(self, *names: str) -> str:
        """Commit names as they stand in the output directory, and push."""
        git(self.out, "add", "--", *names)
        git(self.out, "commit", "-q", "-m", "a page", "--", *names)
        git(self.out, "push", "-q", "origin", "HEAD:main")
        return git(self.out, "rev-parse", "HEAD").strip()

    def source(self, edition: str) -> Path:
        path = self.tmp / "pond.md"
        path.write_text(f"# Pond\n\nThe {edition} edition.\n\n## Depth\n\nTwo metres.\n",
                        encoding="utf-8")
        return path

    def publish_page_only(self, edition: str) -> str:
        """Commit pond.html as published from edition's source, and no source:
        the page as one published before sources were kept."""
        done = self.cli("publish", str(self.source(edition)), "--local", "--no-comments",
                        "--out-dir", str(self.scratch))
        self.case.assertEqual(done.returncode, 0, done.stderr)
        # Drawn as before the theme switch: no switch and no theme head.
        page = (self.scratch / "pond.html").read_text(encoding="utf-8")
        theme_head = (SRC / THEME_HEAD).read_text(encoding="utf-8")
        old = re.sub(r'\s*<div class="artifact-theme-switch".*?</div>', "", page, count=1,
                     flags=re.S).replace(f"  <script>{theme_head}</script>\n", "")
        self.case.assertNotIn("artifact-theme-switch", old)
        self.case.assertNotIn(theme_head, old)
        (self.out / "pond.html").write_text(old, encoding="utf-8")
        return self.commit("pond.html")

    def publish(self, edition: str) -> str:
        """Publish edition with its kept source, as publish commits it."""
        self.ok("publish", str(self.source(edition)), "--local", "--no-comments")
        return git(self.out, "rev-parse", "HEAD").strip()

    def log(self) -> str:
        return (self.tmp / "serve.log").read_text(encoding="utf-8")


class VersionShellTests(unittest.TestCase):
    def three_versions(self) -> tuple[VersionSite, list[str]]:
        site = VersionSite(self)
        commits = [site.publish_page_only("first"), site.publish_page_only("second"),
                   site.publish("third")]
        for commit, kept in zip(commits, (False, False, True)):
            held = git(site.out, "ls-tree", "--name-only", commit).split()
            self.assertEqual("pond.md" in held, kept, held)
        return site, commits

    def test_each_version_is_answered_in_todays_shell_with_its_own_text(self):
        site, commits = self.three_versions()
        head = git(site.out, "rev-parse", "HEAD")
        self.assertEqual(git(site.bare, "rev-parse", "main"), head)
        status_before = git(site.out, "status", "--porcelain")
        site.serve()
        files = site.files()
        theme_head = (SRC / THEME_HEAD).read_text(encoding="utf-8")

        for at, (commit, edition) in enumerate(zip(commits, EDITIONS)):
            with self.subTest(edition=edition):
                status, headers, page = site.ask("GET", f"/pond.html?version={commit}")
                self.assertEqual(status, 200, page)
                self.assertIn(b'class="artifact-theme-switch"', page)
                shell = shell_of(page)
                self.assertIn(theme_head, shell.scripts)
                self.assertIn(f"The {edition} edition.".encode("utf-8"), page)
                for other in EDITIONS:
                    if other != edition:
                        self.assertNotIn(f"The {other} edition.".encode("utf-8"), page)
                published = git(site.out, "show", f"{commit}:pond.html").encode("utf-8")
                self.assertTrue(revision_of(published))
                self.assertEqual(shell.revision, revision_of(published))
                if at < 2:
                    self.assertIn(BANNER, page)
                    self.assertIn(b"artifact--old-version", page)
                # The theme head runs, by its hash; no other of the page's
                # own scripts does.
                policy = headers["Content-Security-Policy"]
                self.assertIn("form-action 'none'", policy)
                allowed = script_src(policy)
                self.assertEqual(len(allowed), 2, policy)
                self.assertTrue(allowed[0].startswith("'nonce-"), policy)
                self.assertIn(allowed[1], script_src(shell.policy))
                self.assertEqual(headers["Cache-Control"], "private, no-store")

        self.assertEqual(git(site.out, "rev-parse", "HEAD"), head)
        self.assertEqual(git(site.bare, "rev-parse", "main"), head)
        self.assertEqual(git(site.out, "status", "--porcelain"), status_before)
        self.assertEqual(site.files(), files)

    def test_a_version_is_checked_by_its_etag(self):
        site, commits = self.three_versions()
        site.serve()

        path = f"/pond.html?version={commits[0]}"
        _, first, _ = site.ask("GET", path)
        _, second, _ = site.ask("GET", path)
        tag = first["ETag"]
        self.assertTrue(tag)
        self.assertEqual(second["ETag"], tag)
        status, _, body = site.ask("GET", path, {"If-None-Match": tag})
        self.assertEqual((status, body), (304, b""))

        _, other, _ = site.ask("GET", f"/pond.html?version={commits[1]}")
        self.assertTrue(other["ETag"])
        self.assertNotEqual(other["ETag"], tag)

        # A 304 leaves the stored policy, whose nonce is the stored body's.
        status, headers, _ = site.ask("GET", path, {"If-None-Match": tag})
        self.assertEqual(status, 304)
        self.assertIsNone(headers["Content-Security-Policy"])
        # Published again, the version is one more behind: a new tag.
        site.publish("fourth")
        status, headers, page = site.ask("GET", path, {"If-None-Match": tag})
        self.assertEqual(status, 200)
        self.assertNotEqual(headers["ETag"], tag)
        self.assertIn(b"3 versions behind", page)

    def test_a_version_whose_body_fails_the_check_is_answered_as_published(self):
        site = VersionSite(self)
        # Its body holds section wrappers, comment boxes and a decision form,
        # which publish writes only from a source.
        decided = (FIXTURES.parent / "decisions" / "one_table.expected.html").read_text(
            encoding="utf-8")
        form = re.search(r'<form class="artifact-decision".*?</form>', decided, re.S).group(0)
        shell = (FIXTURES / "old-shell.html").read_text(encoding="utf-8")
        intro = "<p>Written before the theme switch.</p>\n"
        self.assertEqual(shell.count(intro), 1)
        (site.out / "old-shell.html").write_text(shell.replace(intro, intro + form + "\n"),
                                                 encoding="utf-8")
        refused = site.commit("old-shell.html")
        page = site.out / "old-shell.html"
        page.write_text(page.read_text(encoding="utf-8").replace(
            "The pond freezes in January.", "The pond freezes in February."), encoding="utf-8")
        site.commit("old-shell.html")
        site.ok("index")
        site.serve()

        status, headers, answer = site.ask("GET", f"/old-shell.html?version={refused}")
        self.assertEqual(status, 200, answer)
        nonce = re.search(r"'nonce-([^']+)'", headers["Content-Security-Policy"]).group(1)
        version, behind, published = History(site.out, version_stamp).version("old-shell",
                                                                               refused)
        expected = old_page(published, "old-shell", version, behind, nonce,
                            f"{OLD_VERSION_SCRIPT}?v={theme_hash()}").encode("utf-8")
        self.assertEqual(answer, expected)
        self.assertIn(BANNER, answer)
        # Its form is closed: the fieldset disabled, and the note after it.
        self.assertIn(b'<form class="artifact-decision"', answer)
        self.assertEqual(answer.count(b"<fieldset disabled>"), 1)
        self.assertNotIn(b"<fieldset>\n<legend", answer)
        self.assertIn(b'<p class="artifact-version-note">Answering is off on old versions.',
                      answer)
        self.assertIn(b"lotuspod-old-version.js", answer)
        self.assertNotIn(b'class="artifact-theme-switch"', answer)
        self.assertIsNone(headers["ETag"])
        self.assertEqual(headers["Content-Security-Policy"],
                         "frame-ancestors 'none'; form-action 'none'; base-uri 'none'; "
                         f"script-src 'nonce-{nonce}'")
        self.assertEqual(headers["Cache-Control"], "private, no-store")

        site.ask("GET", f"/old-shell.html?version={refused}")
        lines = [line for line in site.log().splitlines()
                 if line.startswith("serve:") and f"old-shell.html?version={refused}" in line]
        self.assertEqual(len(lines), 1, site.log())


class VersionRenderCacheTests(unittest.TestCase):
    def setUp(self):
        self.out = Site(self).out
        self.addCleanup(pages._VERSIONS.clear)

    def test_renders_and_failures_are_kept_for_the_life_of_serve(self):
        """Past any number of other versions, a version is neither rendered
        nor said to fail again."""
        calls = []

        def render(out_dir, name, page_html, kept, refs):
            calls.append(page_html)
            if page_html == "refused":
                raise RuntimeError("its body holds a section wrapper")
            return page_html, {}

        def files_at(commit, filenames):
            return [None] * len(filenames)

        commits = [f"{at:040x}" for at in range(600)]
        with mock.patch.object(pages, "render_from", render), \
                mock.patch("sys.stderr") as stderr:
            for _ in range(2):
                self.assertIsNone(pages.rendered_version(self.out, "pond", commits[0], "refused",
                                                         files_at))
                for commit in commits[1:]:
                    self.assertEqual(pages.rendered_version(self.out, "pond", commit, commit,
                                                            files_at), commit)
        self.assertEqual(calls, ["refused", *commits[1:]])
        logged = "".join(call.args[0] for call in stderr.write.call_args_list)
        self.assertEqual(logged.count(f"pond.html?version={commits[0]}"), 1)


if __name__ == "__main__":
    unittest.main()
