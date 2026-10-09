"""`lotuspod publish` over ssh: the far side's failure and revision conflict
reach the caller as they are, no config at all means a local publish, and
the config is found through $LOTUSPOD_CONFIG, else $XDG_CONFIG_HOME, else
~/.config. A page's images travel in one source archive with it, a page
without one goes as its bytes, references are refused before ssh, and the
far side refuses every archive it should not trust.

`ssh` on the PATH is a stub that records its arguments and standard input
and runs the remote command with `sh -c` on this machine, handing it that
standard input; the far side is this checkout's CLI, writing into a clone of
a local bare repository. No network, no real ssh.
"""

from __future__ import annotations

import hashlib
import io
import json
import os
import re
import shlex
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from html.parser import HTMLParser
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parents[1] / "src"
TIMEOUT = 120

POND = "# Pond\n\nStill water.\n\n## Fish\n\nThree.\n"
MEDIA_FIXTURES = Path(__file__).parent / "fixtures" / "media"
POND_IMAGES = (
    "# Pond\n\nStill water.\n\n![Pump chart](./chart.png)\n\n"
    "## Fish\n\n![Fish](photos/fish.jpg)\n\nThree.\n"
)
GARDEN_IMAGES = (
    "<h1>Garden</h1>\n<p>Beds &amp; paths.</p>\n"
    "<!-- <img src=\"draft.png\"> -->\n"
    "<img alt='Chart'  src=chart.png>\n"
    '<p><img src="photos/fish.jpg" alt="Fish" width="40" height="30"/></p>\n'
)

# Saves each call's standard input as SSH_STUB_LOG.N.stdin, N counting from 0.
STUB = """\
#!{python}
import json, os, subprocess, sys
data = sys.stdin.buffer.read()
log = os.environ["SSH_STUB_LOG"]
calls = 0
if os.path.exists(log):
    with open(log, encoding="utf-8") as done:
        calls = len(done.read().splitlines())
with open(f"{{log}}.{{calls}}.stdin", "wb") as saved:
    saved.write(data)
with open(log, "a", encoding="utf-8") as out:
    out.write(json.dumps(sys.argv[1:]) + "\\n")
sys.exit(subprocess.run(["sh", "-c", sys.argv[-1]], input=data).returncode)
"""


def git(cwd: Path, *argv: str) -> str:
    done = subprocess.run(
        ["git", "-C", str(cwd), *argv], capture_output=True, text=True, check=True
    )
    return done.stdout


# Two publishes a second apart stamp different updated times, in the page,
# the index and the manifest; everything else must match byte for byte.
_UPDATED_STAMP_RE = re.compile(rb"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z")


def unstamped(data: bytes) -> bytes:
    return _UPDATED_STAMP_RE.sub(b"STAMP", data)


class RemotePublishTestCase(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name).resolve()
        self.bare = self.tmp / "origin.git"
        self.out_dir = self.tmp / "artifacts"
        git(self.tmp, "init", "-q", "--bare", "-b", "main", str(self.bare))
        git(self.tmp, "clone", "-q", str(self.bare), str(self.out_dir))
        git(self.out_dir, "config", "user.name", "Lotuspod Test")
        git(self.out_dir, "config", "user.email", "test@example.com")
        git(self.out_dir, "config", "commit.gpgsign", "false")
        bin_dir = self.tmp / "bin"
        bin_dir.mkdir()
        stub = bin_dir / "ssh"
        stub.write_text(STUB.format(python=sys.executable), encoding="utf-8")
        stub.chmod(0o755)
        self.log = self.tmp / "ssh.log"
        self.home = self.tmp / "home"
        self.home.mkdir()
        self.env = dict(os.environ, PYTHONPATH=str(SRC_DIR), SSH_STUB_LOG=str(self.log),
                        HOME=str(self.home),
                        PATH=f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}")
        for name in ("LOTUSPOD_CONFIG", "XDG_CONFIG_HOME"):
            self.env.pop(name, None)
        self.pond = self.tmp / "pond.md"
        self.pond.write_text(POND, encoding="utf-8")

    def write_config(self, path: Path, host: str = "writer", **publish: str) -> Path:
        path.parent.mkdir(parents=True, exist_ok=True)
        lines = ["[publish]", f"host = {host}", f"command = {sys.executable} -m lotuspod",
                 f"out_dir = {self.out_dir}"]
        lines += [f"{key} = {value}" for key, value in publish.items()]
        path.write_text("\n".join(lines) + "\n", encoding="utf-8")
        return path

    def publish(self, source: Path | str, *extra: str, stdin: str | None = None,
                **env: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, "-m", "lotuspod", "publish", str(source), *extra],
            cwd=str(self.tmp), env=dict(self.env, **env), input=stdin, capture_output=True,
            text=True, timeout=TIMEOUT,
        )

    def calls(self) -> list:
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text().splitlines() if line]

    def stdin_of(self, call: int) -> bytes:
        """What the call-th ssh call had on its standard input."""
        return Path(f"{self.log}.{call}.stdin").read_bytes()

    def remote_argv(self, call: list) -> list:
        """The arguments the call's remote command gives the far side's CLI."""
        command = f"{sys.executable} -m lotuspod"
        self.assertTrue(call[-1].startswith(command + " "), call[-1])
        return shlex.split(call[-1][len(command):])

    def commits(self) -> int:
        done = subprocess.run(
            ["git", "-C", str(self.bare), "rev-list", "--count", "--all"],
            capture_output=True, text=True, check=True,
        )
        return int(done.stdout.strip())


class FarSideOutcomeTests(RemotePublishTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.config = self.write_config(self.tmp / "config.ini")
        self.env["LOTUSPOD_CONFIG"] = str(self.config)

    def test_a_far_side_failure_exits_1_with_its_error_line(self):
        untitled = self.tmp / "untitled.md"
        untitled.write_text("Just text.\n", encoding="utf-8")
        done = self.publish(untitled)
        self.assertEqual(done.returncode, 1, done.stderr)
        self.assertEqual(len(self.calls()), 1)
        self.assertIn("error: standard input has no title", done.stderr)
        self.assertEqual(self.commits(), 0)

    def test_a_revision_conflict_on_the_far_side_exits_3_and_changes_nothing(self):
        done = self.publish(self.pond, "--date", "2026-09-01")
        self.assertEqual(done.returncode, 0, done.stderr)
        revision = re.search(r"at revision (\w+)", done.stdout).group(1)
        page = (self.out_dir / "pond.html").read_bytes()
        commits = self.commits()

        self.pond.write_text(POND + "\n## Weeds\n\nToo many.\n", encoding="utf-8")
        done = self.publish(self.pond, "--expect-revision", "0" * len(revision))
        self.assertEqual(done.returncode, 3, done.stderr)
        self.assertIn("revision conflict", done.stderr)
        self.assertEqual((self.out_dir / "pond.html").read_bytes(), page)
        self.assertEqual(self.commits(), commits)

        done = self.publish(self.pond, "--expect-revision", revision)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.commits(), commits + 1)

    def test_every_argument_after_the_command_reaches_the_far_side_quoted(self):
        done = self.publish(self.pond, "--title", "A; b $(c)", "--summary", "it's",
                            "--variant", "article", "--date", "2026-09-01")
        self.assertEqual(done.returncode, 0, done.stderr)
        (call,) = self.calls()
        self.assertEqual(call, ["writer", call[-1]])
        command = f"{sys.executable} -m lotuspod"
        self.assertTrue(call[-1].startswith(command + " "), call[-1])
        self.assertEqual(
            shlex.split(call[-1][len(command):]),
            ["publish", "--local", "-", f"--out-dir={self.out_dir}",
             "--format=markdown", "--name=pond", "--title=A; b $(c)",
             "--summary=it's", "--variant=article", "--date=2026-09-01"],
        )

    def test_labels_and_no_labels_reach_the_far_side_in_order(self):
        done = self.publish(self.pond, "--label", "a", "--label", "b")
        self.assertEqual(done.returncode, 0, done.stderr)
        argv = self.remote_argv(self.calls()[-1])
        self.assertEqual([arg for arg in argv if arg.startswith("--label")],
                         ["--label=a", "--label=b"])
        self.assertNotIn("--no-labels", argv)
        page = (self.out_dir / "pond.html").read_text(encoding="utf-8")
        self.assertIn('<meta name="lotuspod:labels" content="a,b">', page)

        done = self.publish(self.pond, "--no-labels")
        self.assertEqual(done.returncode, 0, done.stderr)
        argv = self.remote_argv(self.calls()[-1])
        self.assertIn("--no-labels", argv)
        self.assertEqual([arg for arg in argv if arg.startswith("--label")], [])
        page = (self.out_dir / "pond.html").read_text(encoding="utf-8")
        self.assertNotIn("lotuspod:labels", page)

    def test_a_label_that_is_not_one_is_refused_before_ssh(self):
        done = self.publish(self.pond, "--label", "two words")
        self.assertEqual(done.returncode, 1, done.stderr)
        self.assertIn("'two words'", done.stderr)
        self.assertEqual(self.calls(), [])

    def test_values_beginning_with_a_dash_reach_the_far_side_as_values(self):
        done = self.publish(self.pond, "--title=--draft", "--summary=-v")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(len(self.calls()), 1)
        page = (self.out_dir / "pond.html").read_text(encoding="utf-8")
        self.assertIn('<h1 class="artifact-title">--draft</h1>', page)
        self.assertIn('<p class="artifact-summary">-v</p>', page)

    def test_an_out_dir_without_local_is_refused_before_ssh(self):
        done = self.publish(self.pond, "--out-dir", str(self.tmp / "here"))
        self.assertEqual(done.returncode, 2, done.stderr)
        self.assertIn("--local", done.stderr)
        self.assertEqual(self.calls(), [])
        self.assertFalse((self.tmp / "here").exists())


class NoConfigTests(RemotePublishTestCase):
    def test_no_config_anywhere_publishes_here_exactly_as_local(self):
        xdg = self.tmp / "xdg"
        xdg.mkdir()
        here = self.tmp / "here"
        done = self.publish(self.pond, "--date", "2026-09-01", "--out-dir", str(here),
                            XDG_CONFIG_HOME=str(xdg))
        self.assertEqual(done.returncode, 0, done.stderr)
        local = self.tmp / "local"
        expected = self.publish(self.pond, "--date", "2026-09-01", "--out-dir", str(local),
                                "--local")
        self.assertEqual(expected.returncode, 0, expected.stderr)
        self.assertEqual(self.calls(), [])
        self.assertEqual(done.stdout.replace(str(here), "DIR"),
                         expected.stdout.replace(str(local), "DIR"))
        self.assertEqual(done.stderr, expected.stderr)
        self.assertEqual(sorted(p.name for p in here.iterdir()),
                         sorted(p.name for p in local.iterdir()))
        for page in here.iterdir():
            self.assertEqual(unstamped(page.read_bytes()),
                             unstamped((local / page.name).read_bytes()), page.name)

    def test_a_config_variable_naming_no_file_publishes_here(self):
        here = self.tmp / "here"
        done = self.publish(self.pond, "--out-dir", str(here),
                            LOTUSPOD_CONFIG=str(self.tmp / "missing.ini"),
                            XDG_CONFIG_HOME=str(self.tmp / "xdg"))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.calls(), [])
        self.assertTrue((here / "pond.html").is_file())

    def test_no_config_publishes_into_a_repository_with_one_commit(self):
        done = self.publish(self.pond, "--out-dir", str(self.out_dir))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.commits(), 1)


class ConfigLocationTests(RemotePublishTestCase):
    def test_xdg_config_home_is_used_without_lotuspod_config(self):
        xdg = self.tmp / "xdg"
        self.write_config(xdg / "lotuspod" / "config.ini", host="xdg-writer")
        done = self.publish(self.pond, XDG_CONFIG_HOME=str(xdg))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual([call[0] for call in self.calls()], ["xdg-writer"])

    def test_lotuspod_config_wins_over_xdg_config_home(self):
        xdg = self.tmp / "xdg"
        self.write_config(xdg / "lotuspod" / "config.ini", host="xdg-writer")
        named = self.write_config(self.tmp / "named.ini", host="named-writer")
        done = self.publish(self.pond, XDG_CONFIG_HOME=str(xdg), LOTUSPOD_CONFIG=str(named))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual([call[0] for call in self.calls()], ["named-writer"])

    def test_a_config_variable_naming_no_file_falls_through_to_the_next(self):
        xdg = self.tmp / "xdg"
        self.write_config(xdg / "lotuspod" / "config.ini", host="xdg-writer")
        done = self.publish(self.pond, XDG_CONFIG_HOME=str(xdg),
                            LOTUSPOD_CONFIG=str(self.tmp / "missing.ini"))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual([call[0] for call in self.calls()], ["xdg-writer"])

    def test_home_config_is_used_without_either_variable(self):
        self.write_config(self.home / ".config" / "lotuspod" / "config.ini", host="home-writer")
        done = self.publish(self.pond)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual([call[0] for call in self.calls()], ["home-writer"])


def stored_name(data: bytes, extension: str) -> str:
    return f"{hashlib.sha256(data).hexdigest()}.{extension}"


class _Images(HTMLParser):
    """Every img element's attributes, in order."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.images: list[dict] = []

    def handle_starttag(self, tag, attrs):
        if tag == "img":
            self.images.append(dict(attrs))


def page_images(page: str) -> list[dict]:
    parser = _Images()
    parser.feed(page)
    parser.close()
    return parser.images


class RemoteImageTestCase(RemotePublishTestCase):
    def setUp(self) -> None:
        super().setUp()
        self.config = self.write_config(self.tmp / "config.ini")
        self.env["LOTUSPOD_CONFIG"] = str(self.config)
        self.media = self.tmp / "lotuspod-media"
        self.writing = self.tmp / "writing"
        (self.writing / "photos").mkdir(parents=True)
        self.chart = (MEDIA_FIXTURES / "chart-1600x600.png").read_bytes()
        self.fish = (MEDIA_FIXTURES / "fish-320x240.jpg").read_bytes()
        (self.writing / "chart.png").write_bytes(self.chart)
        (self.writing / "photos" / "fish.jpg").write_bytes(self.fish)
        self.chart_name = stored_name(self.chart, "png")
        self.fish_name = stored_name(self.fish, "jpg")

    def write(self, name: str, text: str, directory: Path | None = None) -> Path:
        path = (directory or self.writing) / name
        path.write_text(text, encoding="utf-8")
        return path

    def media_files(self) -> list[str]:
        return sorted(os.listdir(self.media)) if self.media.exists() else []

    def assertNothingWritten(self) -> None:
        self.assertEqual(sorted(os.listdir(self.out_dir)), [".git"])
        self.assertEqual(self.media_files(), [])
        self.assertEqual(self.commits(), 0)


class RemoteImageTests(RemoteImageTestCase):
    def test_a_page_and_its_images_go_in_one_archive_over_one_ssh_call(self):
        done = self.publish(self.write("pond.md", POND_IMAGES))
        self.assertEqual(done.returncode, 0, done.stderr)

        (call,) = self.calls()
        self.assertEqual(call[0], "writer")
        self.assertIn("--source-archive", self.remote_argv(call))
        kept = POND_IMAGES.replace("./chart.png", f"/media/{self.chart_name}") \
            .replace("photos/fish.jpg", f"/media/{self.fish_name}")
        with tarfile.open(fileobj=io.BytesIO(self.stdin_of(0)), mode="r:") as archive:
            members = archive.getmembers()
            self.assertEqual([m.name for m in members],
                             ["source", f"media/{self.chart_name}", f"media/{self.fish_name}"])
            self.assertTrue(all(m.isreg() for m in members))
            self.assertEqual(archive.extractfile("source").read().decode("utf-8"), kept)
            self.assertEqual(archive.extractfile(f"media/{self.chart_name}").read(), self.chart)
            self.assertEqual(archive.extractfile(f"media/{self.fish_name}").read(), self.fish)

        self.assertEqual(self.media_files(), sorted([self.chart_name, self.fish_name]))
        self.assertEqual((self.media / self.chart_name).read_bytes(), self.chart)
        self.assertEqual((self.media / self.fish_name).read_bytes(), self.fish)
        page = (self.out_dir / "pond.html").read_text(encoding="utf-8")
        self.assertEqual(
            [(img["src"], img["width"], img["height"]) for img in page_images(page)],
            [(f"/media/{self.chart_name}", "1600", "600"),
             (f"/media/{self.fish_name}", "320", "240")],
        )
        self.assertEqual((self.out_dir / "pond.md").read_text(encoding="utf-8"), kept)
        self.assertEqual(self.commits(), 1)
        files = git(self.out_dir, "show", "--name-only", "--format=", "HEAD").split()
        self.assertIn("pond.md", files)
        for file in files:
            self.assertFalse(file.endswith((".png", ".jpg", ".jpeg", ".webp", ".gif")), file)

    def test_a_page_without_an_image_to_send_goes_as_its_bytes(self):
        plain = self.write("plain.md", POND)
        done = self.publish(plain)
        self.assertEqual(done.returncode, 0, done.stderr)
        done = self.publish(self.write("pond.md", POND_IMAGES), "--local",
                            "--out-dir", str(self.out_dir))
        self.assertEqual(done.returncode, 0, done.stderr)
        stored = self.write("stored.md", (self.out_dir / "pond.md").read_text(encoding="utf-8"),
                            directory=self.tmp)
        commits = self.commits()
        done = self.publish(stored)
        self.assertEqual(done.returncode, 0, done.stderr)

        calls = self.calls()
        self.assertEqual(len(calls), 2)
        for index, (call, source) in enumerate(zip(calls, (plain, stored))):
            with self.subTest(source=source.name):
                self.assertNotIn("--source-archive", self.remote_argv(call))
                self.assertEqual(self.stdin_of(index), source.read_bytes())
        self.assertEqual(self.commits(), commits + 1)
        self.assertEqual((self.out_dir / "stored.md").read_bytes(), stored.read_bytes())
        page = (self.out_dir / "stored.html").read_text(encoding="utf-8")
        self.assertEqual([img["width"] for img in page_images(page)], ["1600", "320"])

    def test_a_refused_reference_stops_before_ssh(self):
        shutil.copy(MEDIA_FIXTURES / "logo.svg", self.writing / "logo.svg")
        (self.tmp / "beside.png").write_bytes(self.chart)
        for reference, reason in (("./missing.png", "no such file"),
                                  ("logo.svg", "SVG images are not published"),
                                  ("../beside.png", "outside the source's directory")):
            with self.subTest(reference=reference):
                done = self.publish(self.write("pond.md", f"# Pond\n\n![Image]({reference})\n"))
                self.assertEqual(done.returncode, 1, done.stderr)
                self.assertIn(reference, done.stderr)
                self.assertIn(reason, done.stderr)
                self.assertEqual(self.calls(), [])
                self.assertFalse(self.log.exists())
                self.assertNothingWritten()

    def test_an_html_source_publishes_there_as_it_does_here(self):
        source = self.write("garden.html", GARDEN_IMAGES)
        here = self.tmp / "here"
        done = self.publish(source, "--local", "--out-dir", str(here), "--date", "2026-09-01")
        self.assertEqual(done.returncode, 0, done.stderr)
        done = self.publish(source, "--date", "2026-09-01")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertIn("--source-archive", self.remote_argv(self.calls()[0]))
        for name in ("garden.html", "garden.body.html"):
            self.assertEqual(unstamped((self.out_dir / name).read_bytes()),
                             unstamped((here / name).read_bytes()), name)
        self.assertEqual(self.media_files(), sorted([self.chart_name, self.fish_name]))

    def test_standard_input_finds_its_images_under_base(self):
        argv = ("-", "--format", "markdown", "--name", "pond")
        done = self.publish(*argv, stdin=POND_IMAGES)
        self.assertEqual(done.returncode, 1, done.stderr)
        self.assertIn("--base", done.stderr)
        self.assertEqual(self.calls(), [])
        self.assertNothingWritten()

        done = self.publish(*argv, "--base", str(self.writing), stdin=POND_IMAGES)
        self.assertEqual(done.returncode, 0, done.stderr)
        (call,) = self.calls()
        self.assertNotIn(str(self.writing), call[-1])
        self.assertFalse(any(arg.startswith("--base") for arg in self.remote_argv(call)))
        self.assertEqual(self.media_files(), sorted([self.chart_name, self.fish_name]))
        self.assertEqual(
            (self.out_dir / "pond.md").read_text(encoding="utf-8"),
            POND_IMAGES.replace("./chart.png", f"/media/{self.chart_name}")
            .replace("photos/fish.jpg", f"/media/{self.fish_name}"),
        )


def archive(*members: tuple) -> bytes:
    """A tar of members, each (name, bytes) for a regular file, a TarInfo, or
    (TarInfo, bytes) for any header with a body, written as given."""
    out = io.BytesIO()
    with tarfile.open(fileobj=out, mode="w", format=tarfile.USTAR_FORMAT) as tar:
        for member in members:
            if isinstance(member, tarfile.TarInfo):
                tar.addfile(member)
                continue
            info, data = member
            if not isinstance(info, tarfile.TarInfo):
                info = tarfile.TarInfo(info)
            info.size = len(data)
            tar.addfile(info, io.BytesIO(data))
    return out.getvalue()


def extension(name: str, kind: bytes, body: bytes) -> tuple:
    """An extension header named name of type kind, with body."""
    info = tarfile.TarInfo(name)
    info.type = kind
    return info, body


def pax_record(key: str, value: str) -> bytes:
    """One PAX record: its own length, then key=value."""
    rest = f" {key}={value}\n"
    length = len(rest) + 1
    while len(f"{length}{rest}") != length:
        length += 1
    return f"{length}{rest}".encode("utf-8")


class FarSideArchiveTests(RemoteImageTestCase):
    """Archives fed straight to the far side, with no ssh."""

    def far_side(self, data: bytes, **env: str) -> subprocess.CompletedProcess:
        done = subprocess.run(
            [sys.executable, "-m", "lotuspod", "publish", "--local", "-", "--source-archive",
             f"--out-dir={self.out_dir}", "--format=markdown", "--name=pond"],
            cwd=str(self.tmp), env=dict(self.env, **env), input=data, capture_output=True,
            timeout=TIMEOUT,
        )
        return subprocess.CompletedProcess(done.args, done.returncode,
                                           done.stdout.decode(), done.stderr.decode())

    def source(self, *names: str) -> bytes:
        lines = "".join(f"![Image](/media/{name})\n\n" for name in names)
        return f"# Pond\n\n{lines}".encode("utf-8")

    def test_a_whole_archive_publishes(self):
        done = self.far_side(archive(("source", self.source(self.chart_name)),
                                     (f"media/{self.chart_name}", self.chart)))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.media_files(), [self.chart_name])
        self.assertEqual((self.out_dir / "pond.md").read_bytes(), self.source(self.chart_name))

    def test_every_untrusted_archive_is_refused_and_nothing_is_written(self):
        padded = (MEDIA_FIXTURES / "padded-48x32-2000-bytes.png").read_bytes()
        padded_name = stored_name(padded, "png")
        svg = (MEDIA_FIXTURES / "logo.svg").read_bytes()
        svg_name = stored_name(svg, "png")
        link = tarfile.TarInfo(f"media/{self.chart_name}")
        link.type, link.linkname = tarfile.SYMTYPE, "/etc/passwd"
        climbing = f"media/../{self.chart_name}"
        whole = archive(("source", self.source(self.chart_name)),
                        (f"media/{self.chart_name}", self.chart))
        # A source naming no image, so only how the archive ends can refuse it.
        alone = archive(("source", self.source()), (f"media/{self.chart_name}", self.chart))
        source_end = 2 * tarfile.BLOCKSIZE
        small = self.tmp / "small.ini"
        small.write_text("[media]\nmax_image_bytes = 1000\n", encoding="utf-8")
        missing = stored_name(b"nowhere", "png")

        cases = (
            ("bytes not matching the name", f"media/{padded_name}", None,
             archive(("source", self.source(padded_name)), (f"media/{padded_name}", self.chart))),
            ("a .. step", climbing, None,
             archive(("source", self.source(self.chart_name)), (climbing, self.chart))),
            ("a symbolic link", f"media/{self.chart_name}", None,
             archive(("source", self.source(self.chart_name)), link)),
            ("a second source", "source", None,
             archive(("source", self.source()), ("source", self.source()))),
            ("an SVG named as a PNG", f"media/{svg_name}", None,
             archive(("source", self.source(svg_name)), (f"media/{svg_name}", svg))),
            ("a member the source does not name", f"media/{self.fish_name}", None,
             archive(("source", self.source(self.chart_name)),
                     (f"media/{self.chart_name}", self.chart),
                     (f"media/{self.fish_name}", self.fish))),
            ("an image over the far side's cap", f"media/{padded_name}", str(small),
             archive(("source", self.source(padded_name)), (f"media/{padded_name}", padded))),
            ("a media URL neither sent nor stored", f"/media/{missing}", None,
             archive(("source", self.source(self.chart_name, missing)),
                     (f"media/{self.chart_name}", self.chart))),
            ("an archive cut off mid-member", f"media/{self.chart_name}", None,
             whole[:512 * 4 + len(self.chart) // 2]),
            ("an archive cut off mid-header", "source", None,
             alone[:source_end + tarfile.BLOCKSIZE // 2]),
            ("an archive cut off between members", "source", None, alone[:source_end]),
            ("a malformed block for the end-of-archive marker", "source", None,
             alone[:source_end] + b"\x01" * tarfile.BLOCKSIZE + bytes(tarfile.RECORDSIZE)),
            ("a PAX header", "../untrusted-header", None,
             archive(extension("../untrusted-header", tarfile.XHDTYPE,
                               pax_record("comment", "hello")),
                     ("source", self.source()))),
            ("a PAX header renaming the next member", "./PaxHeaders/x", None,
             archive(extension("./PaxHeaders/x", tarfile.XHDTYPE,
                               pax_record("path", "source")),
                     ("elsewhere", self.source()))),
            ("a global PAX header", "pax_global_header", None,
             archive(extension("pax_global_header", tarfile.XGLTYPE,
                               pax_record("comment", "hello")),
                     ("source", self.source()))),
            ("a GNU long name", "././@LongLink", None,
             archive(extension("././@LongLink", tarfile.GNUTYPE_LONGNAME, b"source\0"),
                     ("elsewhere", self.source()))),
        )
        for case, named, config, data in cases:
            with self.subTest(case=case):
                env = {"LOTUSPOD_CONFIG": config} if config else {}
                done = self.far_side(data, **env)
                self.assertEqual(done.returncode, 1, done.stderr)
                (line,) = done.stderr.splitlines()
                self.assertIn(named, line)
                self.assertFalse((self.out_dir / "pond.html").exists())
                self.assertFalse((self.out_dir / "pond.md").exists())
                self.assertNothingWritten()


if __name__ == "__main__":
    unittest.main()
