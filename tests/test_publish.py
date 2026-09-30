"""`lotuspod publish`: the kept treatment on a republish, sources and private
files left out of listings and refused by serve, the publish lock under two
racing publishes, a directory that is no repository, the refusals that write
nothing, and a page published from standard input.

Real git in temporary directories, with a local bare repository as origin;
the CLI runs as a subprocess of this checkout's src/. No network.
"""

from __future__ import annotations

import http.client
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parents[1] / "src"
sys.path.insert(0, str(SRC_DIR))

from lotuspod import cli  # noqa: E402

TIMEOUT = 120

POND = "# Pond\n\nStill water.\n\n## Fish\n\nThree.\n\n## Plants\n\nLilies.\n"
GARDEN = "<h1>Garden notes</h1>\n<h2>Beds</h2>\n<p>North.</p>\n<h2>Path</h2>\n<p>Gravel.</p>\n"


def git(cwd: Path, *argv: str) -> str:
    done = subprocess.run(
        ["git", "-C", str(cwd), *argv], capture_output=True, text=True, check=True
    )
    return done.stdout


def lotuspod(*argv: str, cwd: Path, stdin: str | None = None) -> subprocess.CompletedProcess:
    env = dict(os.environ, PYTHONPATH=str(SRC_DIR))
    return subprocess.run(
        [sys.executable, "-m", "lotuspod", *argv],
        cwd=str(cwd), env=env, input=stdin, capture_output=True, text=True,
        timeout=TIMEOUT,
    )


class PublishTestCase(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name).resolve()
        self.bare = self.tmp / "origin.git"
        self.out_dir = self.tmp / "artifacts"
        git(self.tmp, "init", "-q", "--bare", "-b", "main", str(self.bare))
        git(self.tmp, "clone", "-q", str(self.bare), str(self.out_dir))
        git(self.out_dir, "config", "user.name", "Lotuspod Test")
        git(self.out_dir, "config", "user.email", "test@lotuspod.invalid")
        git(self.out_dir, "config", "commit.gpgsign", "false")

    def source(self, name: str, text: str) -> Path:
        path = self.tmp / name
        path.write_text(text, encoding="utf-8")
        return path

    def publish(self, source: Path | str, *extra: str, out_dir: Path | None = None,
                stdin: str | None = None) -> subprocess.CompletedProcess:
        return lotuspod(
            "publish", str(source), "--out-dir", str(out_dir or self.out_dir), *extra,
            cwd=self.tmp, stdin=stdin,
        )

    def commits(self) -> int:
        done = subprocess.run(
            ["git", "-C", str(self.bare), "rev-list", "--count", "--all"],
            capture_output=True, text=True, check=True,
        )
        return int(done.stdout.strip())

    def page(self, name: str) -> str:
        return (self.out_dir / f"{name}.html").read_text(encoding="utf-8")


class RepublishTests(PublishTestCase):
    def test_republish_keeps_date_summary_and_report_treatment(self):
        source = self.source("pond.md", POND)
        done = self.publish(source, "--date", "2026-09-01", "--summary", "S")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn('class="artifact artifact--report"', self.page("pond"))

        self.source("pond.md", POND.replace("Three.", "Four."))
        done = self.publish(source)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.commits(), 2)
        page = self.page("pond")
        self.assertIn("Four.", page)
        self.assertIn('<time datetime="2026-09-01">', page)
        self.assertIn('<p class="artifact-summary">S</p>', page)
        self.assertIn('class="artifact artifact--report"', page)
        subjects = git(self.bare, "log", "--format=%s", "main").splitlines()
        self.assertEqual(subjects, ["publish pond", "publish pond"])

    def test_republish_keeps_a_treatment_given_before(self):
        source = self.source("pond.md", POND)
        done = self.publish(source, "--variant", "article")
        self.assertEqual(done.returncode, 0, done.stderr)
        done = self.publish(source)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn('<main class="artifact" id="top">', self.page("pond"))

    def test_title_and_summary_are_escaped_once(self):
        source = self.source("fish.md", "# Fish & plants\n\nWater.\n")
        done = self.publish(source, "--summary", "Salt & <pepper>")
        self.assertEqual(done.returncode, 0, done.stderr)
        done = self.publish(source)
        self.assertEqual(done.returncode, 0, done.stderr)

        page = self.page("fish")
        self.assertIn('<h1 class="artifact-title">Fish &amp; plants</h1>', page)
        self.assertIn('<p class="artifact-summary">Salt &amp; &lt;pepper&gt;</p>', page)
        index = (self.out_dir / cli.INDEX_FILE).read_text(encoding="utf-8")
        self.assertIn(">Fish &amp; plants</a>", index)
        self.assertIn(">Salt &amp; &lt;pepper&gt;</td>", index)
        self.assertNotIn("&amp;amp;", index)
        entry = json.loads(
            (self.out_dir / cli.MANIFEST_FILE).read_text(encoding="utf-8")
        )["artifacts"][0]
        self.assertEqual((entry["title"], entry["summary"]),
                         ("Fish & plants", "Salt & <pepper>"))

    def test_publish_prints_the_revision(self):
        source = self.source("pond.md", POND)
        done = self.publish(source)
        self.assertEqual(done.returncode, 0, done.stderr)
        revision = cli.source_revision(POND.encode("utf-8"))
        self.assertIn(revision, done.stdout)
        self.assertIn(f'<meta name="lotuspod:revision" content="{revision}">',
                      self.page("pond"))

    def test_expect_none_refuses_a_page_that_exists(self):
        source = self.source("pond.md", POND)
        done = self.publish(source, "--expect-revision", "none")
        self.assertEqual(done.returncode, 0, done.stderr)
        done = self.publish(source, "--expect-revision", "none")
        self.assertEqual(done.returncode, 3)
        self.assertIn("revision conflict", done.stderr)
        self.assertEqual(self.commits(), 1)


class SourcesAndServeTests(PublishTestCase):
    def setUp(self) -> None:
        super().setUp()
        for name, text in (("garden.html", GARDEN), ("pond.md", POND)):
            done = self.publish(self.source(name, text))
            self.assertEqual(done.returncode, 0, done.stderr)
        done = lotuspod("render", "--name", "quiet", "--title", "Quiet", "--hidden",
                        "--out-dir", str(self.out_dir), cwd=self.tmp)
        self.assertEqual(done.returncode, 0, done.stderr)

    def serve(self) -> int:
        server = cli._make_server(self.out_dir, "127.0.0.1", 0)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()

        def stop() -> None:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)

        self.addCleanup(stop)
        return server.server_address[1]

    def status(self, port: int, path: str) -> int:
        conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
        try:
            conn.request("GET", path)
            return conn.getresponse().status
        finally:
            conn.close()

    def test_index_and_manifest_neither_list_nor_count_sources(self):
        self.assertTrue((self.out_dir / "garden.body.html").is_file())
        self.assertTrue((self.out_dir / "pond.md").is_file())
        for step in ("index", "manifest"):
            done = lotuspod(step, "--out-dir", str(self.out_dir), cwd=self.tmp)
            self.assertEqual(done.returncode, 0, done.stderr)
            self.assertIn("(2 artifacts, 1 not visible)", done.stdout)
        manifest = (self.out_dir / cli.MANIFEST_FILE).read_text(encoding="utf-8")
        index = (self.out_dir / cli.INDEX_FILE).read_text(encoding="utf-8")
        for listing in (manifest, index):
            self.assertIn("garden.html", listing)
            self.assertIn("pond.html", listing)
            self.assertNotIn("garden.body.html", listing)
            self.assertNotIn("pond.md", listing)

    def test_serve_refuses_everything_but_visible_pages_and_theme(self):
        outside = self.tmp / "outside.html"
        outside.write_text(self.page("pond"), encoding="utf-8")
        (self.out_dir / "linked.html").symlink_to(outside)
        (self.tmp / "outside.css").write_text("body{}", encoding="utf-8")
        (self.out_dir / "lotuspod.css").unlink()
        (self.out_dir / "lotuspod.css").symlink_to(self.tmp / "outside.css")
        (self.out_dir / ".draft.html").write_text(self.page("pond"), encoding="utf-8")
        (self.tmp / "secret.txt").write_text("secret", encoding="utf-8")
        self.assertTrue((self.out_dir / ".git" / "config").is_file())
        port = self.serve()

        for path in ("/", "/garden.html", "/pond.html", "/favicon.svg"):
            self.assertEqual(self.status(port, path), 200, path)
        for path in ("/garden.body.html", "/pond.md", "/manifest.json", "/.git/config",
                     "/quiet.html", "/linked.html", "/lotuspod.css", "/.draft.html",
                     "/%2e%2e/secret.txt", "/..%2fsecret.txt"):
            self.assertEqual(self.status(port, path), 404, path)

    def test_a_file_at_the_denial_sentinel_is_never_served(self):
        sentinel = self.out_dir / cli._DENY_PATH_NAME
        sentinel.write_text("sentinel-secret", encoding="utf-8")
        (self.tmp / "secret.txt").write_text("secret", encoding="utf-8")
        port = self.serve()

        self.assertEqual(self.status(port, "/pond.html"), 200)
        for path in ("/pond.md", "/manifest.json", f"/{cli._DENY_PATH_NAME}",
                     "/%2e%2e/secret.txt", "/..%2fsecret.txt"):
            conn = http.client.HTTPConnection("127.0.0.1", port, timeout=5)
            try:
                conn.request("GET", path)
                resp = conn.getresponse()
                self.assertEqual(resp.status, 404, path)
                self.assertNotIn(b"sentinel-secret", resp.read(), path)
            finally:
                conn.close()


class RacingPublishTests(PublishTestCase):
    def test_two_publishes_expecting_one_revision_land_once(self):
        source = self.source("pond.md", POND)
        done = self.publish(source)
        self.assertEqual(done.returncode, 0, done.stderr)
        current = cli.source_revision(POND.encode("utf-8"))
        before = self.commits()

        env = dict(os.environ, PYTHONPATH=str(SRC_DIR))
        racers = []
        for word in ("Five.", "Six."):
            racer = self.source(f"racer-{word[:-1].lower()}.md", POND.replace("Three.", word))
            racers.append(subprocess.Popen(
                [sys.executable, "-m", "lotuspod", "publish", str(racer), "--name", "pond",
                 "--out-dir", str(self.out_dir), "--expect-revision", current],
                cwd=str(self.tmp), env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True,
            ))
        codes = []
        for proc in racers:
            proc.communicate(timeout=TIMEOUT)
            codes.append(proc.returncode)
        self.assertEqual(sorted(codes), [0, 3])
        self.assertEqual(self.commits(), before + 1)
        self.assertEqual(git(self.out_dir, "status", "--porcelain"), "")


class NoRepositoryTests(PublishTestCase):
    def test_publish_into_a_plain_directory_writes_everything_quietly(self):
        plain = self.tmp / "plain"
        plain.mkdir()
        done = self.publish(self.source("pond.md", POND), out_dir=plain)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(done.stderr, "")
        for name in ("pond.html", "pond.md", cli.MANIFEST_FILE, cli.INDEX_FILE):
            self.assertTrue((plain / name).is_file(), name)
        self.assertEqual((plain / "pond.md").read_text(encoding="utf-8"), POND)
        self.assertFalse(any(p.name.startswith(".") for p in plain.iterdir()))


class RefusalTests(PublishTestCase):
    def test_refusals_write_nothing(self):
        done = self.publish(self.source("pond.md", POND))
        self.assertEqual(done.returncode, 0, done.stderr)
        listing = sorted(os.listdir(self.out_dir))
        pages = {p: p.read_bytes() for p in self.out_dir.iterdir() if p.is_file()}
        commits = self.commits()

        cases = (
            (self.source("untitled.md", "Just text.\n\n## A\n"), "no title"),
            (self.tmp / "missing.md", "not found"),
            (self.source("notes.txt", POND), "cannot tell the format"),
        )
        for source, problem in cases:
            with self.subTest(source=source.name):
                done = self.publish(source)
                self.assertEqual(done.returncode, 1)
                self.assertIn(problem, done.stderr)
                self.assertIn(source.name, done.stderr)
                self.assertEqual(sorted(os.listdir(self.out_dir)), listing)
                self.assertEqual(
                    {p: p.read_bytes() for p in self.out_dir.iterdir() if p.is_file()},
                    pages,
                )
                self.assertEqual(self.commits(), commits)


class StandardInputTests(PublishTestCase):
    def test_standard_input_publishes_the_same_page_as_the_file(self):
        from_file = self.tmp / "from-file"
        from_stdin = self.tmp / "from-stdin"
        done = self.publish(self.source("pond.md", POND), "--date", "2026-09-01",
                            out_dir=from_file)
        self.assertEqual(done.returncode, 0, done.stderr)
        done = self.publish("-", "--format", "markdown", "--name", "pond",
                            "--date", "2026-09-01", out_dir=from_stdin, stdin=POND)
        self.assertEqual(done.returncode, 0, done.stderr)
        for name in ("pond.html", "pond.md"):
            self.assertEqual((from_stdin / name).read_bytes(),
                             (from_file / name).read_bytes(), name)


if __name__ == "__main__":
    unittest.main()
