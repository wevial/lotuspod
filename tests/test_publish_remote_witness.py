"""Witness: `lotuspod publish SOURCE` on a machine whose config names the
writer host publishes there over ssh, with one commit in the artifacts
repository, and no argument is run as a shell command on the far side.

A real ssh session is not available here, so `ssh` on the PATH is a stub
that records its arguments and runs the remote command with `sh -c` on this
machine. The far side is the real CLI of this checkout, writing into a
clone of a local bare repository with real git.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from html.parser import HTMLParser
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
SRC = REPO / "src"
TIMEOUT = 120

POND = """\
# Pond

Still water.

## Fish

Three of them.

## Weeds

Too many.
"""

GARDEN = """\
<h1>Garden</h1>
<h2>Beds</h2>
<p>North and south.</p>
<h2>Path</h2>
<p>Gravel.</p>
"""

HOSTILE = "Q's \"plan\"; $(touch pwned) `touch pwned2`"

STUB = """\
#!{python}
import json, os, subprocess, sys
with open(os.environ["SSH_STUB_LOG"], "a", encoding="utf-8") as log:
    log.write(json.dumps(sys.argv[1:]) + "\\n")
sys.exit(subprocess.run(["sh", "-c", sys.argv[-1]]).returncode)
"""


class _Titles(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.depth = 0
        self.titles = []

    def handle_starttag(self, tag, attrs):
        if tag == "h1":
            self.depth += 1
            self.titles.append("")

    def handle_endtag(self, tag):
        if tag == "h1" and self.depth:
            self.depth -= 1

    def handle_data(self, data):
        if self.depth:
            self.titles[-1] += data


def git(cwd: Path, *argv: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(cwd), *argv], capture_output=True,
                          timeout=TIMEOUT)


class RemotePublishWitness(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name).resolve()
        self.bare = self.tmp / "origin.git"
        self.out = self.tmp / "artifacts"
        for argv in (("init", "-q", "--bare", "-b", "main", str(self.bare)),
                     ("clone", "-q", str(self.bare), str(self.out))):
            done = git(self.tmp, *argv)
            self.assertEqual(done.returncode, 0, done.stderr)
        for key, value in (("user.name", "Witness"),
                           ("user.email", "witness@lotuspod.invalid"),
                           ("commit.gpgsign", "false")):
            git(self.out, "config", key, value)
        bin_dir = self.tmp / "bin"
        bin_dir.mkdir()
        stub = bin_dir / "ssh"
        stub.write_text(STUB.format(python=sys.executable), encoding="utf-8")
        stub.chmod(0o755)
        self.log = self.tmp / "ssh.log"
        self.config = self.tmp / "config.ini"
        self.write_config(out_dir=str(self.out))
        self.env = dict(os.environ, PYTHONPATH=str(SRC), SSH_STUB_LOG=str(self.log),
                        LOTUSPOD_CONFIG=str(self.config),
                        PATH=f"{bin_dir}{os.pathsep}{os.environ.get('PATH', '')}")

    def write_config(self, **publish):
        lines = ["[publish]", "host = writer", f"command = {sys.executable} -m lotuspod"]
        lines += [f"{key} = {value}" for key, value in publish.items()]
        self.config.write_text("\n".join(lines) + "\n", encoding="utf-8")

    def publish(self, source: Path, *extra: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, "-m", "lotuspod", "publish", str(source), *extra],
            cwd=str(self.tmp), env=self.env, capture_output=True, text=True,
            timeout=TIMEOUT)

    def calls(self) -> list:
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text().splitlines() if line]

    def commits(self) -> int:
        done = git(self.bare, "rev-list", "--count", "main")
        return int(done.stdout) if done.returncode == 0 else 0

    def remote_bytes(self, name: str) -> bytes:
        done = git(self.bare, "show", f"main:{name}")
        return done.stdout if done.returncode == 0 else b""

    def test_a_markdown_page_is_published_on_the_writer_host_over_ssh(self):
        source = self.tmp / "pond.md"
        source.write_text(POND, encoding="utf-8")
        done = self.publish(source, "--date", "2026-09-01")
        self.assertEqual(done.returncode, 0, done.stderr)
        calls = self.calls()
        self.assertEqual(len(calls), 1, calls)
        self.assertEqual(calls[0][-2], "writer")
        self.assertEqual(self.commits(), 1)
        self.assertEqual(self.remote_bytes("pond.md"), POND.encode("utf-8"))
        self.assertIn(b"Three of them.", self.remote_bytes("pond.html"))

    def test_an_html_page_is_published_over_ssh_with_its_source(self):
        source = self.tmp / "garden.html"
        source.write_text(GARDEN, encoding="utf-8")
        done = self.publish(source)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(len(self.calls()), 1)
        self.assertEqual(self.commits(), 1)
        self.assertEqual(self.remote_bytes("garden.body.html"), GARDEN.encode("utf-8"))
        self.assertIn(b'id="beds"', self.remote_bytes("garden.html"))

    def test_a_hostile_title_is_rendered_as_text_and_never_run(self):
        source = self.tmp / "pond.md"
        source.write_text(POND, encoding="utf-8")
        done = self.publish(source, "--title", HOSTILE)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(len(self.calls()), 1)
        page = self.out / "pond.html"
        self.assertTrue(page.is_file(), "the page was not written on the far side")
        titles = _Titles()
        titles.feed(page.read_text(encoding="utf-8"))
        self.assertEqual([t.strip() for t in titles.titles], [HOSTILE])
        self.assertEqual(sorted(p.name for p in self.tmp.rglob("pwned*")), [])

    def test_local_publishes_here_and_never_calls_ssh(self):
        source = self.tmp / "pond.md"
        source.write_text(POND, encoding="utf-8")
        other = self.tmp / "other"
        done = self.publish(source, "--local", "--out-dir", str(other))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.calls(), [])
        self.assertTrue((other / "pond.html").is_file())
        self.assertEqual(self.commits(), 0)

    def test_a_host_without_an_output_directory_is_refused_before_ssh(self):
        self.write_config()
        source = self.tmp / "pond.md"
        source.write_text(POND, encoding="utf-8")
        done = self.publish(source)
        self.assertEqual(done.returncode, 2, done.stderr)
        self.assertIn("out_dir", done.stderr)
        self.assertEqual(self.calls(), [])


if __name__ == "__main__":
    unittest.main()
