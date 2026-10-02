"""`lotuspod publish`: the kept treatment on a republish, sources and private
files left out of listings and refused by serve, the publish lock under two
racing publishes, a directory that is no repository, the refusals that write
nothing, a page published from standard input, and a page's images - a
markdown image line's or an HTML img element's - stored beside the artifacts
directory, with the references that are refused, and --base for a source on
standard input.

Real git in temporary directories, with a local bare repository as origin;
the CLI runs as a subprocess of this checkout's src/. No network.
"""

from __future__ import annotations

import hashlib
import http.client
import json
import os
import re
import shutil
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
MEDIA_FIXTURES = Path(__file__).parent / "fixtures" / "media"
POND_IMAGES = (
    "# Pond\n\nStill water.\n\n![Pump chart](./chart.png)\n\n"
    "## Fish\n\n![Fish](photos/fish.jpg)\n\nThree.\n"
)
_BODY_RE = re.compile(r'<section class="artifact-body">.*?</section>', re.DOTALL)
GARDEN_IMAGES = (
    "<h1>Garden</h1>\n<p>Beds &amp; paths.</p>\n"
    "<!-- <img src=\"draft.png\"> -->\n"
    "<img alt='Chart'  src=chart.png>\n"
    '<p><img src="photos/fish.jpg" alt="Fish" width="40" height="30"/></p>\n'
)
GARDEN = "<h1>Garden notes</h1>\n<h2>Beds</h2>\n<p>North.</p>\n<h2>Path</h2>\n<p>Gravel.</p>\n"


def git(cwd: Path, *argv: str) -> str:
    done = subprocess.run(
        ["git", "-C", str(cwd), *argv], capture_output=True, text=True, check=True
    )
    return done.stdout


def lotuspod(*argv: str, cwd: Path, stdin: str | None = None,
             env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
    env = dict(os.environ, PYTHONPATH=str(SRC_DIR), **(env or {}))
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
                stdin: str | None = None,
                env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
        return lotuspod(
            "publish", str(source), "--out-dir", str(out_dir or self.out_dir), *extra,
            cwd=self.tmp, stdin=stdin, env=env,
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


class PageScriptTests(PublishTestCase):
    def test_every_published_page_loads_the_page_script_to_notice_a_republish(self):
        """LOTUS-41: a published page carries a revision, so it loads the
        page script even with no comments, decisions or sections."""
        source = self.source("note.md", "# Note\n\nOne line, no sections.\n")
        done = self.publish(source, "--no-comments")
        self.assertEqual(done.returncode, 0, done.stderr)
        page = self.page("note")
        self.assertIn('<meta name="lotuspod:revision"', page)
        self.assertIn(f'<script src="{cli.PAGE_SCRIPT}?v=', page)


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



def stored_name(data: bytes, extension: str) -> str:
    return f"{hashlib.sha256(data).hexdigest()}.{extension}"


class ImageTestCase(PublishTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.media = self.tmp / "lotuspod-media"
        self.writing = self.tmp / "writing"
        (self.writing / "photos").mkdir(parents=True)
        self.chart = (MEDIA_FIXTURES / "chart-1600x600.png").read_bytes()
        self.fish = (MEDIA_FIXTURES / "fish-320x240.jpg").read_bytes()
        (self.writing / "chart.png").write_bytes(self.chart)
        (self.writing / "photos" / "fish.jpg").write_bytes(self.fish)

    def write(self, directory: Path, name: str, text: str) -> Path:
        path = directory / name
        path.write_text(text, encoding="utf-8")
        return path

    def assertRefused(self, done: subprocess.CompletedProcess, reference: str,
                      reason: str) -> None:
        """One error line naming the reference and why, and nothing written."""
        self.assertEqual(done.returncode, 1, done.stdout)
        lines = done.stderr.strip().splitlines()
        self.assertEqual(len(lines), 1, done.stderr)
        self.assertIn(reference, lines[0])
        self.assertIn(reason, lines[0])
        self.assertEqual(sorted(os.listdir(self.out_dir)), [".git"])
        self.assertFalse(self.media.exists() and any(self.media.iterdir()))
        self.assertEqual(self.commits(), 0)


class ImageTests(ImageTestCase):
    def test_images_are_stored_beside_the_artifacts_and_drawn_at_their_size(self):
        source = self.write(self.writing, "pond.md", POND_IMAGES)
        done = self.publish(source, "--local")
        self.assertEqual(done.returncode, 0, done.stderr)

        chart, fish = stored_name(self.chart, "png"), stored_name(self.fish, "jpg")
        self.assertEqual(sorted(os.listdir(self.media)), sorted([chart, fish]))
        self.assertEqual((self.media / chart).read_bytes(), self.chart)
        self.assertEqual((self.media / fish).read_bytes(), self.fish)

        page = self.page("pond")
        for name, alt, width, height in ((chart, "Pump chart", 1600, 600),
                                         (fish, "Fish", 320, 240)):
            url = f"/media/{name}"
            self.assertIn(
                f'<figure class="artifact-figure"><a href="{url}"><img src="{url}" '
                f'alt="{alt}" loading="lazy" width="{width}" height="{height}"></a></figure>',
                page,
            )
        self.assertNotIn("chart.png", page)
        self.assertNotIn("photos/fish.jpg", page)

        kept = (self.out_dir / "pond.md").read_text(encoding="utf-8")
        self.assertEqual(
            kept,
            POND_IMAGES.replace("./chart.png", f"/media/{chart}")
            .replace("photos/fish.jpg", f"/media/{fish}"),
        )
        self.assertEqual(self.commits(), 1)
        files = git(self.out_dir, "show", "--name-only", "--format=", "HEAD").split()
        self.assertTrue(files)
        for file in files:
            self.assertFalse(file.endswith((".png", ".jpg", ".jpeg", ".webp", ".gif")), file)
        self.assertEqual(git(self.out_dir, "status", "--porcelain", "--ignored"), "")

    def test_the_kept_source_republishes_from_anywhere_and_a_missing_media_url_is_refused(self):
        done = self.publish(self.write(self.writing, "pond.md", POND_IMAGES), "--local")
        self.assertEqual(done.returncode, 0, done.stderr)
        body = _BODY_RE.search(self.page("pond")).group(0)
        elsewhere = self.tmp / "elsewhere"
        elsewhere.mkdir()
        kept = shutil.copy(self.out_dir / "pond.md", elsewhere / "pond.md")

        done = self.publish(kept, "--local")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(_BODY_RE.search(self.page("pond")).group(0), body)
        self.assertEqual(len(os.listdir(self.media)), 2)

        missing = f"/media/{'0' * 64}.png"
        source = self.write(elsewhere, "pond.md", POND_IMAGES.replace("./chart.png", missing))
        commits = self.commits()
        done = self.publish(source, "--local")
        self.assertEqual(done.returncode, 1)
        self.assertIn(missing, done.stderr)
        self.assertIn("names no image stored", done.stderr)
        self.assertEqual(self.commits(), commits)
        self.assertEqual(len(os.listdir(self.media)), 2)

    def test_a_revision_conflict_stores_no_image(self):
        source = self.write(self.writing, "pond.md", POND_IMAGES)
        done = self.publish(source, "--local", "--expect-revision", "0" * 12)
        self.assertEqual(done.returncode, 3)
        self.assertFalse(self.media.exists())
        self.assertEqual(sorted(os.listdir(self.out_dir)), [".git"])


class ImageRefusalTests(ImageTestCase):
    def publish_reference(self, reference: str, directory: Path | None = None,
                          env: dict[str, str] | None = None) -> subprocess.CompletedProcess:
        source = self.write(directory or self.writing, "pond.md",
                            f"# Pond\n\n![Image]({reference})\n")
        return self.publish(source, "--local", env=env)

    def test_files_that_are_not_images_within_the_cap_are_refused(self):
        shutil.copy(MEDIA_FIXTURES / "logo.svg", self.writing / "logo.svg")
        shutil.copy(MEDIA_FIXTURES / "fish-320x240.jpg", self.writing / "jpeg.png")
        shutil.copy(MEDIA_FIXTURES / "padded-48x32-2000-bytes.png", self.writing / "big.png")
        self.assertEqual((self.writing / "big.png").stat().st_size, 2000)
        config = self.tmp / "config.ini"
        config.write_text("[media]\nmax_image_bytes = 1000\n", encoding="utf-8")

        for reference, reason, env in (
            ("./missing.png", "no such file", None),
            ("logo.svg", "SVG images are not published", None),
            ("jpeg.png", "a JPEG image named .png", None),
            ("big.png", "2000 bytes, over the 1000-byte cap", {"LOTUSPOD_CONFIG": str(config)}),
        ):
            with self.subTest(reference=reference):
                self.assertRefused(self.publish_reference(reference, env=env), reference, reason)

        done = self.publish_reference("big.png")
        self.assertEqual(done.returncode, 0, done.stderr)

    def test_references_outside_the_source_directory_are_refused(self):
        beside = self.tmp / "beside.png"
        beside.write_bytes(self.chart)
        (self.writing / "linked.png").symlink_to(beside)
        cases = (
            # From a source directory two steps below the root, /etc/passwd.
            ("../../etc/passwd", self.tmp),
            ("../beside.png", self.writing),
            (str(beside), self.writing),
            ("linked.png", self.writing),
        )
        for reference, directory in cases:
            with self.subTest(reference=reference):
                done = self.publish_reference(reference, directory)
                self.assertRefused(done, reference, "outside the source's directory")

    def test_remote_and_inline_images_are_refused(self):
        for reference in ("https://example.com/a.png", "//example.com/a.png",
                          "data:image/png;base64,iVBORw0KGgo="):
            with self.subTest(reference=reference):
                self.assertRefused(self.publish_reference(reference), reference,
                                   "remote and inline images are not published")


class HtmlImageTests(ImageTestCase):
    def test_img_elements_are_stored_and_filled_in_and_nothing_else_changes(self):
        done = self.publish(self.write(self.writing, "garden.html", GARDEN_IMAGES), "--local")
        self.assertEqual(done.returncode, 0, done.stderr)

        chart, fish = stored_name(self.chart, "png"), stored_name(self.fish, "jpg")
        self.assertEqual(sorted(os.listdir(self.media)), sorted([chart, fish]))
        chart_tag = (f"<img alt='Chart'  src=\"/media/{chart}\" loading=\"lazy\" "
                     'width="1600" height="600">')
        fish_tag = (f'<img src="/media/{fish}" loading="lazy" alt="Fish" width="40" '
                    'height="30"/>')
        kept = (self.out_dir / "garden.body.html").read_text(encoding="utf-8")
        self.assertEqual(
            kept,
            GARDEN_IMAGES.replace("<img alt='Chart'  src=chart.png>", chart_tag)
            .replace('<img src="photos/fish.jpg" alt="Fish" width="40" height="30"/>', fish_tag),
        )
        page = self.page("garden")
        self.assertIn(chart_tag, page)
        self.assertIn(fish_tag, page)
        self.assertIn('<!-- <img src="draft.png"> -->', page)
        self.assertEqual(self.commits(), 1)

        # The kept source republishes as it is: every img already filled in.
        elsewhere = self.tmp / "elsewhere"
        elsewhere.mkdir()
        again = shutil.copy(self.out_dir / "garden.body.html", elsewhere / "garden.html")
        done = self.publish(again, "--local")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual((self.out_dir / "garden.body.html").read_text(encoding="utf-8"), kept)

    def test_img_references_that_cannot_be_published_are_refused(self):
        (self.tmp / "beside.png").write_bytes(self.chart)
        cases = (
            ('<img src="https://example.com/a.png" alt="A">', "https://example.com/a.png",
             "remote and inline images are not published"),
            ('<img src="chart.png" srcset="chart.png 2x" alt="A">', "chart.png 2x", "srcset"),
            ('<picture><source srcset="photos/fish.jpg 1x"><img src="chart.png" alt="A">'
             "</picture>", "photos/fish.jpg 1x", "srcset"),
            ('<img src="../beside.png" alt="A">', "../beside.png",
             "outside the source's directory"),
        )
        for element, reference, reason in cases:
            with self.subTest(element=element):
                source = self.write(self.writing, "garden.html",
                                    f"<h1>Garden</h1>\n<p>{element}</p>\n")
                self.assertRefused(self.publish(source, "--local"), reference, reason)


class BaseTests(ImageTestCase):
    ARGV = ("-", "--local", "--format", "markdown", "--name", "pond")

    def test_standard_input_finds_its_images_under_base_and_is_refused_without(self):
        done = self.publish(*self.ARGV, stdin=POND_IMAGES)
        self.assertRefused(done, "./chart.png", "--base")

        done = self.publish(*self.ARGV, "--base", str(self.writing), stdin=POND_IMAGES)
        self.assertEqual(done.returncode, 0, done.stderr)
        chart, fish = stored_name(self.chart, "png"), stored_name(self.fish, "jpg")
        self.assertEqual(sorted(os.listdir(self.media)), sorted([chart, fish]))
        self.assertEqual(
            (self.out_dir / "pond.md").read_text(encoding="utf-8"),
            POND_IMAGES.replace("./chart.png", f"/media/{chart}")
            .replace("photos/fish.jpg", f"/media/{fish}"),
        )
        self.assertIn(f'<img src="/media/{fish}" alt="Fish" loading="lazy" width="320" '
                      'height="240">', self.page("pond"))

    def test_base_names_another_directory_than_the_source_files(self):
        elsewhere = self.tmp / "elsewhere"
        elsewhere.mkdir()
        source = self.write(elsewhere, "pond.md", POND_IMAGES)
        done = self.publish(source, "--local")
        self.assertRefused(done, "./chart.png", "no such file")
        done = self.publish(source, "--local", "--base", str(self.writing))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(len(os.listdir(self.media)), 2)


if __name__ == "__main__":
    unittest.main()
