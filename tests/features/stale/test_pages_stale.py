"""`lotuspod pages stale` lists each page linking a GitHub pull request that
merged or closed after the page's last publish. `--check` looks the linked
pull requests up first and keeps their states in lotuspod-pulls.json beside
serve's database; without it nothing is looked up.

The pages are published with the real `lotuspod publish --local`, into a
clone of a local bare repository; the first publishes run with publish's
clock set two hours back, so a merge an hour after them is already past when
a page is published again. The command runs as a subprocess of this
checkout's src/. The GitHub API is a local http.server stand-in, the only
fake: no test reaches GitHub.

Run from the repo root:

    python -m unittest tests.features.stale.test_pages_stale -v
"""

from __future__ import annotations

import datetime as _dt
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parents[3] / "src"

TIMEOUT = 120
SHIFT = _dt.timedelta(hours=2)

PLAN = ("# Plan\n\nIn flight: [the pond](https://github.com/acme/pond/pull/7) and "
        "[its files](https://github.com/acme/pond/pull/8/files), again "
        "[here](https://github.com/acme/pond/pull/7#top).\n")
STATUS = "# Status\n\nShipped in [#9](https://github.com/acme/pond/pull/9).\n"
NOTES = "# Notes\n\nNothing linked, [only the index](https://example.com/pull/7).\n"

# publish's clock, set back by the seconds given first on the command line.
SHIFTED_PUBLISH = """\
import datetime, runpy, sys, types
shift = datetime.timedelta(seconds=int(sys.argv.pop(1)))
class Clock(datetime.datetime):
    @classmethod
    def now(cls, tz=None):
        return datetime.datetime.now(tz) - shift
shim = types.ModuleType("datetime")
shim.__dict__.update(vars(datetime))
shim.datetime = Clock
import lotuspod.features.publish.publish as publish
publish._dt = shim
sys.argv[0] = "lotuspod"
runpy.run_module("lotuspod", run_name="__main__", alter_sys=True)
"""


def git(cwd: Path, *argv: str) -> str:
    return subprocess.run(["git", "-C", str(cwd), *argv], capture_output=True, text=True,
                          check=True).stdout


def stamp(moment: _dt.datetime) -> str:
    return moment.astimezone(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse(text: str) -> _dt.datetime:
    return _dt.datetime.fromisoformat(text.replace("Z", "+00:00"))


class StandIn:
    """The GitHub API's pulls route, answering from answers by path, and
    with 403 from the request numbered fail_from on when it is set."""

    def __init__(self) -> None:
        self.answers: dict[str, dict] = {}
        self.requests: list[tuple[str, dict[str, str]]] = []
        self.fail_from: int | None = None
        stand_in = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self) -> None:
                stand_in.requests.append((self.path, dict(self.headers.items())))
                failing = (stand_in.fail_from is not None
                           and len(stand_in.requests) >= stand_in.fail_from)
                found = stand_in.answers.get(self.path)
                code = 403 if failing else 200 if found else 404
                body = json.dumps(found if code == 200 else {"message": "no"}).encode()
                self.send_response(code)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *args) -> None:
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()

    def paths(self) -> list[str]:
        return [path for path, _ in self.requests]


class PagesStaleTests(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name).resolve()
        self.bare = self.tmp / "origin.git"
        self.out_dir = self.tmp / "artifacts"
        self.states = self.tmp / "lotuspod-pulls.json"
        git(self.tmp, "init", "-q", "--bare", "-b", "main", str(self.bare))
        git(self.tmp, "clone", "-q", str(self.bare), str(self.out_dir))
        git(self.out_dir, "config", "user.name", "Lotuspod Test")
        git(self.out_dir, "config", "user.email", "test@example.com")
        git(self.out_dir, "config", "commit.gpgsign", "false")
        for name, text in (("plan", PLAN), ("status", STATUS), ("notes", NOTES)):
            self.publish(name, text, shift=SHIFT)
        self.updated = self.manifest_updated()
        published = max(parse(value) for value in self.updated.values())
        self.merged_7 = stamp(published + _dt.timedelta(hours=1))
        self.merged_9 = stamp(min(parse(value) for value in self.updated.values())
                              - _dt.timedelta(days=1))
        self.stand_in = StandIn()
        self.addCleanup(self.stand_in.close)
        self.stand_in.answers = {
            "/repos/acme/pond/pulls/7": {"state": "closed", "merged_at": self.merged_7,
                                         "closed_at": self.merged_7},
            "/repos/acme/pond/pulls/8": {"state": "open", "merged_at": None,
                                         "closed_at": None},
            "/repos/acme/pond/pulls/9": {"state": "closed", "merged_at": self.merged_9,
                                         "closed_at": self.merged_9},
        }

    def env(self, **extra: str) -> dict[str, str]:
        env = {key: value for key, value in os.environ.items() if key != "GITHUB_TOKEN"}
        env.update(PYTHONPATH=str(SRC_DIR), LOTUSPOD_CONFIG=str(self.tmp / "no-config.ini"))
        env.update(extra)
        return env

    def publish(self, name: str, text: str, shift: _dt.timedelta | None = None) -> None:
        source = self.tmp / f"{name}.md"
        source.write_text(text, encoding="utf-8")
        argv = ["publish", str(source), "--local", "--out-dir", str(self.out_dir)]
        if shift is None:
            command = [sys.executable, "-m", "lotuspod", *argv]
        else:
            command = [sys.executable, "-c", SHIFTED_PUBLISH, str(int(shift.total_seconds())),
                       *argv]
        done = subprocess.run(command, cwd=str(self.tmp), env=self.env(), capture_output=True,
                              text=True, timeout=TIMEOUT)
        self.assertEqual(done.returncode, 0, done.stderr)

    def manifest_updated(self) -> dict[str, str]:
        manifest = json.loads((self.out_dir / "manifest.json").read_text(encoding="utf-8"))
        return {meta["file"][:-len(".html")]: meta["updated"] for meta in manifest["artifacts"]}

    def stale(self, *extra: str, **env: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, "-m", "lotuspod", "pages", "stale", "--out-dir", str(self.out_dir),
             *extra],
            cwd=str(self.tmp), env=self.env(LOTUSPOD_GITHUB_API=self.stand_in.url, **env),
            capture_output=True, text=True, timeout=TIMEOUT)

    def stored(self) -> dict[str, dict]:
        return json.loads(self.states.read_text(encoding="utf-8"))["pulls"]

    def test_check_lists_the_page_a_merge_after_its_publish_overtook(self):
        self.assertLess(parse(self.updated["plan"]), parse(self.merged_7))
        done = self.stale("--check", "--json")
        self.assertEqual((done.returncode, done.stderr), (0, ""))
        found = json.loads(done.stdout)
        self.assertEqual(found, {
            "pages": [{
                "page": "plan", "title": "Plan", "updated": self.updated["plan"],
                "merged": [{"pull": "acme/pond#7", "url": "https://github.com/acme/pond/pull/7",
                            "at": self.merged_7}],
                "closed": [],
            }],
            "unchecked": 0,
        })
        self.assertEqual(sorted(self.stand_in.paths()), [
            "/repos/acme/pond/pulls/7", "/repos/acme/pond/pulls/8", "/repos/acme/pond/pulls/9"])
        stored = self.stored()
        self.assertEqual({key: (entry["state"], entry["at"]) for key, entry in stored.items()}, {
            "acme/pond#7": ("merged", self.merged_7),
            "acme/pond#8": ("open", None),
            "acme/pond#9": ("merged", self.merged_9),
        })
        for entry in stored.values():
            self.assertLess(_dt.datetime.now(_dt.timezone.utc) - parse(entry["checked"]),
                            _dt.timedelta(minutes=5))
        self.assertFalse((self.out_dir / "lotuspod-pulls.json").exists())

    def test_a_fresh_check_looks_nothing_up_and_a_merged_pull_is_never_looked_up_again(self):
        self.assertEqual(self.stale("--check").returncode, 0)
        self.stand_in.requests.clear()

        done = self.stale("--check")
        self.assertEqual((done.returncode, done.stderr), (0, ""))
        self.assertEqual(self.stand_in.paths(), [])
        self.assertEqual(done.stdout.splitlines(), [
            f"plan  updated {self.updated['plan']}  1 merged since: acme/pond#7"])

        done = self.stale("--check", "--every", "0")
        self.assertEqual((done.returncode, done.stderr), (0, ""))
        self.assertEqual(self.stand_in.paths(), ["/repos/acme/pond/pulls/8"])

        self.stand_in.requests.clear()
        self.publish("plan", PLAN)
        self.assertGreater(parse(self.manifest_updated()["plan"]), parse(self.merged_7))
        done = self.stale()
        self.assertEqual((done.returncode, done.stderr, done.stdout),
                         (0, "", "no page is out of date\n"))
        self.assertEqual(self.stand_in.paths(), [])

    def test_the_token_and_the_user_agent_are_sent(self):
        done = self.stale("--check", GITHUB_TOKEN="tok-123")
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(len(self.stand_in.requests), 3)
        for _, headers in self.stand_in.requests:
            self.assertEqual(headers.get("Authorization"), "Bearer tok-123")
            self.assertEqual(headers.get("User-Agent"), "lotuspod")
            self.assertEqual(headers.get("Accept"), "application/vnd.github+json")

    def test_no_token_sends_no_authorization(self):
        self.assertEqual(self.stale("--check").returncode, 0)
        self.assertTrue(self.stand_in.requests)
        for _, headers in self.stand_in.requests:
            self.assertNotIn("Authorization", headers)

    def test_a_refusal_stops_the_lookups_keeps_what_was_learned_and_still_lists(self):
        self.stand_in.fail_from = 2
        done = self.stale("--check")
        self.assertEqual(done.returncode, 0)
        errors = done.stderr.splitlines()
        self.assertEqual(len(errors), 1, done.stderr)
        self.assertTrue(errors[0].startswith("pages stale: stopped looking up:"), errors[0])
        self.assertTrue(errors[0].endswith("2 of 3 pull requests not checked"), errors[0])
        self.assertEqual(len(self.stand_in.requests), 2)
        self.assertEqual(done.stdout.splitlines(), [
            f"plan  updated {self.updated['plan']}  1 merged since: acme/pond#7"])
        self.assertEqual({key: entry["state"] for key, entry in self.stored().items()},
                         {"acme/pond#7": "merged"})
        found = json.loads(self.stale("--json").stdout)
        self.assertEqual(found["unchecked"], 2)

    def test_a_database_inside_the_output_directory_is_refused_and_no_state_written(self):
        done = self.stale("--check", "--db", str(self.out_dir / "lotuspod.sqlite3"))
        self.assertNotEqual(done.returncode, 0)
        self.assertIn("inside the output directory", done.stderr)
        self.assertEqual(self.stand_in.requests, [])
        self.assertEqual(list(self.out_dir.glob("lotuspod-pulls.json")), [])
        self.assertFalse(self.states.exists())

    def test_the_states_sit_beside_a_named_database(self):
        db_dir = self.tmp / "state"
        db_dir.mkdir()
        done = self.stale("--check", "--db", str(db_dir / "serve.sqlite3"))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertTrue((db_dir / "lotuspod-pulls.json").is_file())
        self.assertFalse(self.states.exists())

    def test_no_run_changes_the_output_directory(self):
        status = git(self.out_dir, "status", "--porcelain")
        head = git(self.out_dir, "rev-parse", "HEAD")
        for extra in (("--check", "--json"), ("--check", "--every", "0"), (), ("--json",),
                      ("--db", str(self.out_dir / "x.sqlite3"))):
            with self.subTest(argv=extra):
                self.stale(*extra)
                self.assertEqual(git(self.out_dir, "status", "--porcelain"), status)
                self.assertEqual(git(self.out_dir, "rev-parse", "HEAD"), head)

    def test_an_archived_page_is_not_listed(self):
        self.assertEqual(self.stale("--check").returncode, 0)
        done = subprocess.run(
            [sys.executable, "-m", "lotuspod", "archive", "plan", "--out-dir", str(self.out_dir)],
            cwd=str(self.tmp), env=self.env(), capture_output=True, text=True, timeout=TIMEOUT)
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.stale().stdout, "no page is out of date\n")


if __name__ == "__main__":
    unittest.main()
