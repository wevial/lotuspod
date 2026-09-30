"""`lotuspod publish` over ssh: the far side's failure and revision conflict
reach the caller as they are, no config at all means a local publish, and
the config is found through $LOTUSPOD_CONFIG, else $XDG_CONFIG_HOME, else
~/.config.

`ssh` on the PATH is a stub that records its arguments and runs the remote
command with `sh -c` on this machine; the far side is this checkout's CLI,
writing into a clone of a local bare repository. No network, no real ssh.
"""

from __future__ import annotations

import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parents[1] / "src"
TIMEOUT = 120

POND = "# Pond\n\nStill water.\n\n## Fish\n\nThree.\n"

STUB = """\
#!{python}
import json, os, subprocess, sys
with open(os.environ["SSH_STUB_LOG"], "a", encoding="utf-8") as log:
    log.write(json.dumps(sys.argv[1:]) + "\\n")
sys.exit(subprocess.run(["sh", "-c", sys.argv[-1]]).returncode)
"""


def git(cwd: Path, *argv: str) -> str:
    done = subprocess.run(
        ["git", "-C", str(cwd), *argv], capture_output=True, text=True, check=True
    )
    return done.stdout


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
        git(self.out_dir, "config", "user.email", "test@lotuspod.invalid")
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

    def publish(self, source: Path | str, *extra: str, **env: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, "-m", "lotuspod", "publish", str(source), *extra],
            cwd=str(self.tmp), env=dict(self.env, **env), capture_output=True, text=True,
            timeout=TIMEOUT,
        )

    def calls(self) -> list:
        if not self.log.exists():
            return []
        return [json.loads(line) for line in self.log.read_text().splitlines() if line]

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
            self.assertEqual(page.read_bytes(), (local / page.name).read_bytes(), page.name)

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


if __name__ == "__main__":
    unittest.main()
