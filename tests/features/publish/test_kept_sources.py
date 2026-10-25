"""`lotuspod pages migrate` keeps the body of each page published only as
HTML as its NAME.body.html, once render_kept() from it gives the page's text
and anchors back, and changes no page, version or revision.

Real git throughout, in temporary directories, with a local bare repository
as origin; no network. The fixtures are tests/fixtures/old-template/:
old-plain.html, the September site's shell with no source, and old-shell.html
with old-shell.md, as the v0.5.0 release publishes them.

Run from the repo root:

    python -m unittest tests.features.publish.test_kept_sources -v
"""

from __future__ import annotations

import io
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr, redirect_stdout
from email.message import Message
from functools import partial
from html.parser import HTMLParser
from pathlib import Path
from unittest import mock

SRC_DIR = Path(__file__).resolve().parents[3] / "src"
sys.path.insert(0, str(SRC_DIR))

from lotuspod import cli, core  # noqa: E402
from lotuspod.features.agents import machine  # noqa: E402
from lotuspod.features.history import versions  # noqa: E402
from lotuspod.features.publish import kept, render  # noqa: E402
from lotuspod.features.serve import pages as serve_pages  # noqa: E402
from lotuspod.store import db  # noqa: E402

FIXTURES = Path(__file__).resolve().parents[2] / "fixtures" / "old-template"
SHELL_REVISION = "48dada2b3407"


def run_cli(*argv: str) -> tuple[int, str, str]:
    out, err = io.StringIO(), io.StringIO()
    with redirect_stdout(out), redirect_stderr(err):
        rc = cli.main(list(argv))
    return rc, out.getvalue(), err.getvalue()


def git(cwd: Path, *argv: str) -> str:
    return subprocess.run(["git", "-C", str(cwd), *argv], capture_output=True, text=True,
                          check=True).stdout


class _Body(HTMLParser):
    """The text, h2 ids and comment-box sections inside section.artifact-body."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.depth = 0
        self.text: list[str] = []
        self.ids: list[str] = []
        self.boxes: list[str] = []

    def handle_starttag(self, tag: str, attrs: list) -> None:
        values = dict(attrs)
        classes = (values.get("class") or "").split()
        if tag == "section" and (self.depth or "artifact-body" in classes):
            self.depth += 1
        elif self.depth and tag == "h2":
            self.ids.append(values.get("id") or "")
        elif self.depth and tag == "details" and "artifact-comment" in classes:
            self.boxes.append(values.get("data-section") or "")

    def handle_endtag(self, tag: str) -> None:
        if tag == "section" and self.depth:
            self.depth -= 1

    def handle_data(self, data: str) -> None:
        if self.depth:
            self.text.append(data)


def body_of(page_html: str) -> tuple[str, list[str], list[str]]:
    parser = _Body()
    parser.feed(page_html)
    parser.close()
    return " ".join("".join(parser.text).split()), parser.ids, parser.boxes


def inner_body(page_html: str) -> str:
    """The inner HTML of the page's section.artifact-body (no nested section)."""
    found = re.search(r'<section class="artifact-body"[^>]*>(.*?)</section>', page_html,
                      re.DOTALL)
    return found.group(1)


class MigrateTestCase(unittest.TestCase):
    def setUp(self) -> None:
        # A short directory: a Unix socket's path is limited to about 100 bytes.
        tmp = tempfile.TemporaryDirectory(dir="/tmp" if Path("/tmp").is_dir() else None)
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name).resolve()
        env = mock.patch.dict(os.environ,
                              {"LOTUSPOD_CONFIG": str(self.tmp / "no-config.ini")})
        env.start()
        self.addCleanup(env.stop)
        self.bare = self.tmp / "origin.git"
        git(self.tmp, "init", "-q", "--bare", "-b", "main", str(self.bare))
        self.out_dir = self.tmp / "artifacts"
        git(self.tmp, "clone", "-q", str(self.bare), str(self.out_dir))
        git(self.out_dir, "config", "user.name", "Lotuspod Test")
        git(self.out_dir, "config", "user.email", "test@example.com")
        git(self.out_dir, "config", "commit.gpgsign", "false")
        for name in ("old-plain.html", "old-shell.html", "old-shell.md"):
            shutil.copyfile(FIXTURES / name, self.out_dir / name)
            self.commit(f"add {name}")

    def commit(self, message: str) -> None:
        git(self.out_dir, "add", "-A")
        git(self.out_dir, "commit", "-q", "-m", message)
        git(self.out_dir, "push", "-q", "origin", "HEAD:main")

    def migrate(self, *extra: str) -> tuple[int, str, str]:
        return run_cli("pages", "migrate", "--out-dir", str(self.out_dir), *extra)

    def remote_subjects(self) -> list[str]:
        return git(self.bare, "log", "--format=%s", "main").splitlines()

    def files(self) -> dict[str, tuple[bytes, int]]:
        """Each file of the output directory, .git aside, to its bytes and mtime."""
        return {path.relative_to(self.out_dir).as_posix(): (path.read_bytes(),
                                                            path.stat().st_mtime_ns)
                for path in self.out_dir.rglob("*")
                if path.is_file() and ".git" not in path.relative_to(self.out_dir).parts}

    def names_and_times(self) -> dict[str, int]:
        return {path.relative_to(self.out_dir).as_posix(): path.stat().st_mtime_ns
                for path in self.out_dir.rglob("*")}


class MigrateTests(MigrateTestCase):
    def test_migrate_keeps_the_plain_body_and_commits_once(self):
        before = self.files()
        subjects = self.remote_subjects()

        rc, checked, err = self.migrate("--check")
        self.assertEqual((rc, err), (0, ""))
        self.assertEqual(checked, "kept 1, extracted 1, refused 0\n")
        self.assertEqual(self.files(), before)
        self.assertEqual(self.remote_subjects(), subjects)

        rc, out, err = self.migrate()
        self.assertEqual((rc, err), (0, ""))
        self.assertEqual(out, checked)
        plain = (self.out_dir / "old-plain.html").read_text(encoding="utf-8")
        self.assertEqual((self.out_dir / "old-plain.body.html").read_text(encoding="utf-8"),
                         inner_body(plain))
        self.assertIn("<p>Planted in the spring.</p>", inner_body(plain))
        after = self.files()
        self.assertEqual(set(after) - set(before), {"old-plain.body.html"})
        for name, (data, _) in before.items():
            with self.subTest(file=name):
                self.assertEqual(after[name][0], data)
        self.assertEqual(self.remote_subjects(), ["migrate pages", *subjects])
        self.assertIn("old-plain.body.html",
                      git(self.bare, "ls-tree", "--name-only", "main").split())
        self.assertEqual(git(self.out_dir, "status", "--porcelain"), "")

        migrated = self.files()
        rc, again, err = self.migrate()
        self.assertEqual((rc, err), (0, ""))
        self.assertEqual(again, "kept 2, extracted 0, refused 0\n")
        self.assertEqual(self.files(), migrated)
        self.assertEqual(self.remote_subjects(), ["migrate pages", *subjects])

    def test_versions_and_revisions_stay(self):
        def seen() -> dict[str, tuple]:
            history = versions.History(self.out_dir, render.version_stamp)
            found = {}
            for name in ("old-plain", "old-shell"):
                page = serve_pages.api_page(self.out_dir, name)
                found[name] = ([version.commit for version in history.listed(name)],
                               history.listed(name), core.page_revision(self.out_dir, name),
                               page.revision)
            return found

        before = seen()
        rc, _, err = self.migrate()
        self.assertEqual((rc, err), (0, ""))
        after = seen()
        self.assertEqual(after, before)
        self.assertEqual(after["old-plain"][2:], ("", ""))
        self.assertEqual(after["old-shell"][2:], (SHELL_REVISION, SHELL_REVISION))
        for name in ("old-plain", "old-shell"):
            self.assertEqual(len(after[name][0]), 1, name)

    def test_render_kept_gives_each_page_back_and_writes_nothing(self):
        rc, _, err = self.migrate()
        self.assertEqual((rc, err), (0, ""))
        for name in ("old-plain", "old-shell"):
            with self.subTest(page=name):
                published = body_of((self.out_dir / f"{name}.html").read_text(encoding="utf-8"))
                before = self.names_and_times()
                page_html, frames = kept.render_kept(self.out_dir, name)
                self.assertEqual(self.names_and_times(), before)
                self.assertEqual(frames, {})
                rendered = body_of(page_html)
                self.assertEqual(rendered[0], published[0])
                self.assertEqual(rendered[1], published[1])
                self.assertEqual(rendered[2], published[2])
        shell = body_of((self.out_dir / "old-shell.html").read_text(encoding="utf-8"))
        self.assertEqual(shell[1], ["findings", "next-steps"])
        self.assertEqual(shell[2], ["findings", "next-steps"])

    def test_a_decorated_body_and_an_added_h2_id_are_refused(self):
        plain = (FIXTURES / "old-plain.html").read_text(encoding="utf-8")
        box = ('<details class="artifact-comment" data-page="boxed" data-section="page">'
               '<summary class="artifact-comment-summary">Comment</summary></details>\n')
        boxed = plain.replace("      </section>", box + "      </section>")
        bare = plain.replace(' id="the-beds"', "")
        self.assertNotEqual(boxed, plain)
        self.assertNotEqual(bare, plain)
        (self.out_dir / "boxed.html").write_text(boxed, encoding="utf-8")
        (self.out_dir / "bare.html").write_text(bare, encoding="utf-8")
        self.commit("add boxed and bare")
        subjects = self.remote_subjects()

        rc, out, err = self.migrate()
        self.assertEqual((rc, err), (1, ""))
        self.assertEqual(out.splitlines(), [
            "kept 1, extracted 1, refused 2",
            "refused bare: the h2 id 'the-beds' the render added",
            "refused boxed: its body holds a comment box, which publish writes only "
            "from a source",
        ])
        self.assertFalse((self.out_dir / "boxed.body.html").exists())
        self.assertFalse((self.out_dir / "bare.body.html").exists())
        self.assertTrue((self.out_dir / "old-plain.body.html").is_file())
        self.assertEqual(self.remote_subjects(), ["migrate pages", *subjects])

    def test_an_agents_pull_carries_the_extracted_source(self):
        rc, _, err = self.migrate()
        self.assertEqual((rc, err), (0, ""))
        database = db.Database(self.tmp / db.DEFAULT_NAME)
        token = self.tmp / "desk.token"
        machine.create_credential(database, "desk", ["hermes"], ["pull"], token)
        database.add_comment(page="old-plain", section="the-beds", section_title="The beds",
                             revision="", text="@hermes Are three beds enough?", quote=None,
                             actor={"kind": "human", "email": "reader@example.com"},
                             owner="hermes")
        routes = machine.Routes(database, pages=partial(serve_pages.api_page, self.out_dir),
                                describe=partial(serve_pages.agent_page, self.out_dir))
        headers = Message()
        headers["Authorization"] = f"Bearer {machine.read_token(token)}"
        status, payload, _ = routes.answer("GET", "/v1/pull?owner=hermes", headers)
        self.assertEqual(status, 200, payload)
        (item,) = [item for item in payload["items"] if item["kind"] == "comment"]
        self.assertEqual(item["page"]["sourceFile"], "old-plain.body.html")
        self.assertEqual(item["page"]["source"],
                         (self.out_dir / "old-plain.body.html").read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
