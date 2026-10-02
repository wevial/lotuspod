"""The site follows main: deploy/lotuspod-deploy.py and deploy/lotuspod-health.py.

The deploy script runs as a subprocess with real git, against a bare origin,
a site clone and a second clone that pushes. Its reinstall, restart and check
commands are stubs that log their name and the site's HEAD when called. The
health check runs against a real `lotuspod serve` and a stub public server.
"""

from __future__ import annotations

import os
import re
import shlex
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from tests.test_serve_theme import SRC, STYLESHEET, ServedSite

ROOT = Path(__file__).resolve().parents[1]
DEPLOY = ROOT / "deploy" / "lotuspod-deploy.py"
HEALTH = ROOT / "deploy" / "lotuspod-health.py"
SYSTEMD = ROOT / "deploy" / "systemd"
TIMEOUT = 60


def git(cwd: Path, *argv: str) -> str:
    result = subprocess.run(["git", "-C", str(cwd), *argv], capture_output=True, text=True,
                            timeout=TIMEOUT)
    if result.returncode != 0:
        raise AssertionError(f"git {' '.join(argv)}: {result.stderr}")
    return result.stdout.strip()


class Deploy(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name).resolve()
        self.origin = self.tmp / "origin.git"
        self.author = self.tmp / "author"
        self.site = self.tmp / "site"
        self.notes = self.tmp / "notes"
        self.notes.mkdir()
        self.log = self.tmp / "stubs.log"
        self.log.touch()
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith("LOTUSPOD_") and not key.startswith("GIT_")}

        subprocess.run(["git", "init", "--quiet", "--bare", str(self.origin)], check=True)
        git(self.origin, "symbolic-ref", "HEAD", "refs/heads/main")
        subprocess.run(["git", "clone", "--quiet", str(self.origin), str(self.author)],
                       check=True, capture_output=True)
        self.identify(self.author)
        git(self.author, "checkout", "--quiet", "-b", "main")
        (self.author / "pyproject.toml").write_text('[project]\nname = "site"\n', encoding="utf-8")
        (self.author / "README.md").write_text("first\n", encoding="utf-8")
        git(self.author, "add", ".")
        git(self.author, "commit", "--quiet", "-m", "first")
        git(self.author, "push", "--quiet", "origin", "main")
        subprocess.run(["git", "clone", "--quiet", "--branch", "main", str(self.origin),
                        str(self.site)], check=True, capture_output=True)
        self.identify(self.site)
        self.first = self.head()

    def identify(self, repo: Path) -> None:
        git(repo, "config", "user.name", "Test")
        git(repo, "config", "user.email", "test@example.invalid")

    def head(self) -> str:
        return git(self.site, "rev-parse", "HEAD")

    def origin_main(self) -> str:
        return git(self.origin, "rev-parse", "main")

    def push(self, path: str = "README.md", text: str = "second\n") -> str:
        (self.author / path).write_text(text, encoding="utf-8")
        git(self.author, "commit", "--quiet", "-am", f"change {path}")
        git(self.author, "push", "--quiet", "origin", "main")
        return self.origin_main()

    def stub(self, name: str, fails: str = "never", says: str = "") -> str:
        """A command logging `name HEAD`; it fails "never", "always" or on
        its "first" call, printing `says` when it fails."""
        log = shlex.quote(str(self.log))
        line = f'echo "{name} $(git rev-parse HEAD)" >> {log}'
        fail = f"echo {shlex.quote(says)}; exit 1"
        if fails == "always":
            return f"{line}; {fail}"
        if fails == "first":
            flag = shlex.quote(str(self.tmp / f"{name}.failed"))
            return f"{line}; if [ ! -e {flag} ]; then touch {flag}; {fail}; fi"
        return line

    def deploy(self, **commands: str) -> subprocess.CompletedProcess:
        env = dict(self.env, LOTUSPOD_SITE=str(self.site), LOTUSPOD_NOTES=str(self.notes),
                   LOTUSPOD_PYTHON=sys.executable, LOTUSPOD_UNITS="serve.service respond.service",
                   LOTUSPOD_DEPLOY_REINSTALL=commands.get("reinstall", self.stub("reinstall")),
                   LOTUSPOD_DEPLOY_RESTART=commands.get("restart", self.stub("restart")),
                   LOTUSPOD_DEPLOY_CHECK=commands.get("check", self.stub("check")))
        return subprocess.run([sys.executable, str(DEPLOY)], cwd=str(self.tmp), env=env,
                              capture_output=True, text=True, timeout=TIMEOUT)

    def calls(self) -> list[tuple[str, str]]:
        return [tuple(line.split()) for line in self.log.read_text(encoding="utf-8").splitlines()]

    def note_files(self) -> list[Path]:
        return sorted(self.notes.iterdir())

    def only_note(self) -> str:
        notes = self.note_files()
        self.assertEqual(len(notes), 1, [path.name for path in notes])
        text = notes[0].read_text(encoding="utf-8")
        self.assertEqual(text.splitlines()[:2], ["Status: open", "To: claude"])
        return text

    def test_fast_forwards_restarts_and_checks(self):
        new = self.push()
        result = self.deploy()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.head(), new)
        self.assertEqual(self.calls(), [("restart", new), ("check", new)])
        self.assertEqual(self.note_files(), [])

    def test_up_to_date_does_nothing(self):
        result = self.deploy()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.head(), self.first)
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.note_files(), [])

    def test_unreachable_origin_does_nothing(self):
        self.push()
        git(self.site, "remote", "set-url", "origin", str(self.tmp / "no-such-origin"))
        result = self.deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.head(), self.first)
        self.assertEqual(self.calls(), [])
        self.assertEqual(self.note_files(), [])

    def test_force_pushed_main_is_refused_once(self):
        git(self.author, "commit", "--quiet", "--amend", "-m", "rewritten")
        git(self.author, "push", "--quiet", "--force", "origin", "main")
        rewritten = self.origin_main()
        self.assertNotEqual(rewritten, self.first)

        result = self.deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.head(), self.first)
        self.assertEqual(self.calls(), [])
        note = self.only_note()
        self.assertIn("refused", note)
        self.assertIn(self.first, note)
        self.assertIn(rewritten, note)

        self.deploy()
        self.assertEqual(self.head(), self.first)
        self.assertEqual(self.calls(), [])
        self.only_note()

    def test_uncommitted_change_is_kept_and_refused(self):
        self.push()
        (self.site / "README.md").write_text("edited by hand\n", encoding="utf-8")

        result = self.deploy()
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual((self.site / "README.md").read_text(encoding="utf-8"), "edited by hand\n")
        self.assertEqual(self.head(), self.first)
        self.assertEqual(self.calls(), [])
        note = self.only_note()
        self.assertIn("uncommitted", note)
        self.assertIn("README.md", note)

    def assert_rolled_back(self, new: str, step: str, output: str) -> None:
        self.assertEqual(self.head(), self.first)
        note = self.only_note()
        self.assertRegex(note, rf"(?m)^Step: {step}$")
        self.assertIn(output, note)
        self.assertIn(self.first, note)
        self.assertIn(new, note)

        calls = self.calls()
        again = self.deploy()
        self.assertEqual(again.returncode, 0, again.stdout + again.stderr)
        self.assertEqual(self.head(), self.first)
        self.assertEqual(self.calls(), calls)
        self.only_note()

    def test_failed_check_rolls_back_once(self):
        new = self.push()
        result = self.deploy(check=self.stub("check", fails="always", says="theme"))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.calls(), [("restart", new), ("check", new), ("restart", self.first)])
        self.assert_rolled_back(new, "check", "theme")
        self.assertRegex(self.only_note(), r"(?m)^Check: theme$")

    def test_failed_restart_rolls_back_once(self):
        new = self.push()
        result = self.deploy(restart=self.stub("restart", fails="first", says="unit failed"))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.calls(), [("restart", new), ("restart", self.first)])
        self.assert_rolled_back(new, "restart", "unit failed")

    def test_next_push_after_a_rollback_is_tried(self):
        self.push()
        self.deploy(check=self.stub("check", fails="always", says="theme"))
        fixed = self.push(text="fixed\n")
        result = self.deploy()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.head(), fixed)

    def test_changed_pyproject_reinstalls_before_restart(self):
        new = self.push("pyproject.toml", '[project]\nname = "site"\nversion = "2"\n')
        result = self.deploy()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertEqual(self.head(), new)
        self.assertEqual(self.calls(), [("reinstall", new), ("restart", new), ("check", new)])

    def test_changed_pyproject_reinstalls_again_on_rollback(self):
        new = self.push("pyproject.toml", '[project]\nname = "site"\nversion = "2"\n')
        result = self.deploy(check=self.stub("check", fails="always", says="loopback"))
        self.assertNotEqual(result.returncode, 0)
        self.assertEqual(self.head(), self.first)
        self.assertEqual(self.calls(), [
            ("reinstall", new), ("restart", new), ("check", new),
            ("reinstall", self.first), ("restart", self.first)])
        self.only_note()


class _Public(BaseHTTPRequestHandler):
    status = 302
    # Set, the answer sends its status and part of its body, then waits on it.
    stall: threading.Event | None = None

    def do_GET(self):
        if self.stall is not None:
            self.send_response(self.status)
            self.send_header("Content-Length", "100")
            self.end_headers()
            self.wfile.write(b"ok")
            self.wfile.flush()
            self.stall.wait(TIMEOUT)
            return
        if self.path == "/signin":
            self.send_response(200)
        else:
            self.send_response(self.status)
            self.send_header("Location", "/signin")
        self.send_header("Content-Length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *args):
        pass


class Health(unittest.TestCase):
    def setUp(self):
        self.site = ServedSite(self)
        self.site.start()

    def public(self, status: int, stall: bool = False) -> str:
        attrs = {"status": status}
        if stall:
            attrs["stall"] = threading.Event()
            self.addCleanup(attrs["stall"].set)
        handler = type("Public", (_Public,), attrs)
        server = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return f"http://127.0.0.1:{server.server_address[1]}/"

    def health(self, public_url: str) -> subprocess.CompletedProcess:
        env = dict(os.environ, PYTHONPATH=str(SRC), LOTUSPOD_PORT=str(self.site.port),
                   LOTUSPOD_PUBLIC_URL=public_url, LOTUSPOD_PYTHON=sys.executable)
        return subprocess.run([sys.executable, str(HEALTH)], env=env, capture_output=True,
                              text=True, timeout=TIMEOUT)

    def test_passes_when_public_redirects(self):
        result = self.health(self.public(302))
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_fails_public_when_public_answers_200(self):
        result = self.health(self.public(200))
        self.assertNotEqual(result.returncode, 0)
        self.assertRegex(result.stdout, r"(?m)^public:")

    def test_fails_public_when_a_200_body_stalls(self):
        result = self.health(self.public(200, stall=True))
        self.assertNotEqual(result.returncode, 0)
        self.assertRegex(result.stdout, r"(?m)^public:")

    def test_fails_theme_when_stylesheet_changes_after_start(self):
        (self.site.out / STYLESHEET).write_text("/* not the theme */\n", encoding="utf-8")
        result = self.health(self.public(302))
        self.assertNotEqual(result.returncode, 0)
        self.assertRegex(result.stdout, r"(?m)^theme:")


def unit(name: str) -> dict[str, list[str]]:
    keys: dict[str, list[str]] = {}
    for line in (SYSTEMD / name).read_text(encoding="utf-8").splitlines():
        if "=" in line and not line.lstrip().startswith(("#", ";")):
            key, value = line.split("=", 1)
            keys.setdefault(key.strip(), []).append(value.strip())
    return keys


class Units(unittest.TestCase):
    def test_timer_starts_the_service_every_minute(self):
        timer = unit("lotuspod-deploy.timer")
        self.assertEqual(timer.get("OnCalendar"), ["minutely"])
        self.assertEqual(timer.get("Unit", ["lotuspod-deploy.service"]), ["lotuspod-deploy.service"])

    def test_service_is_a_oneshot_running_the_script_with_python3(self):
        service = unit("lotuspod-deploy.service")
        self.assertEqual(service.get("Type"), ["oneshot"])
        self.assertEqual(len(service.get("EnvironmentFile", [])), 1)
        self.assertNotIn("WorkingDirectory", service)
        [exec_start] = service["ExecStart"]
        command = exec_start.split()
        self.assertTrue(command[0].endswith("python3"), exec_start)
        self.assertEqual(command[1:], ["${LOTUSPOD_SITE}/deploy/lotuspod-deploy.py"])

    def test_env_example_names_every_key(self):
        text = (SYSTEMD / "deploy.env.example").read_text(encoding="utf-8")
        for key in ("LOTUSPOD_SITE", "LOTUSPOD_PYTHON", "LOTUSPOD_UNITS", "LOTUSPOD_PORT",
                    "LOTUSPOD_PUBLIC_URL", "LOTUSPOD_NOTES", "LOTUSPOD_DEPLOY_REINSTALL",
                    "LOTUSPOD_DEPLOY_RESTART", "LOTUSPOD_DEPLOY_CHECK"):
            self.assertRegex(text, rf"(?m)^#?{key}=")

    def test_no_file_names_a_home_directory_or_srv(self):
        files = sorted(SYSTEMD.iterdir())
        self.assertEqual([path.name for path in files],
                         ["deploy.env.example", "lotuspod-deploy.service", "lotuspod-deploy.timer"])
        for path in files:
            text = path.read_text(encoding="utf-8")
            self.assertIsNone(re.search(r"/home/|/Users/|/root\b|~|/srv\b", text), path.name)


if __name__ == "__main__":
    unittest.main()
