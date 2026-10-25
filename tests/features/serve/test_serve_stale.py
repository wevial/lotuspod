"""serve marks a page that the GitHub pull requests it links have overtaken:
its header's date line ends, after the Updated date, in "may be out of
date · …", and its index row in "may be out of date". Both are drawn from
the states `lotuspod pages stale` keeps beside serve's database, and only by
serve: render, publish, the published file, `pages diff` and an earlier
version's answer carry none.

The pages are published with the real `lotuspod publish --local` into a
clone of a local bare repository, the first publishes with publish's clock
set two hours back, so a merge an hour after them is already past when a
page is published again. The states file is written in the shape the stale
slice reads, and served by a real `lotuspod serve`; no network.

Run from the repo root:

    python -m unittest tests.features.serve.test_serve_stale -v
"""

from __future__ import annotations

import datetime as _dt
import http.client
import json
import os
import re
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path

from tests import access_keys as keys
from tests.features.serve.test_serve_theme import free_port
from tests.features.stale.test_pages_stale import SHIFT, SHIFTED_PUBLISH, git, parse, stamp

SRC_DIR = Path(__file__).resolve().parents[3] / "src"
TIMEOUT = 120

PAGE_A = "# Pond plan\n\nIn flight: [the pond](https://github.com/acme/pond/pull/7).\n"
# Created on a day before any publish, so the header names the Updated day.
CREATED = "2026-01-05"
PAGE_B = "# Pond status\n\nIn review: [the files](https://github.com/acme/pond/pull/8).\n"


class ServeStaleMarks(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name).resolve()
        short = tempfile.TemporaryDirectory(dir="/tmp", prefix="lp")
        self.addCleanup(short.cleanup)
        self.sock = Path(short.name) / "s.sock"
        self.out = self.tmp / "artifacts"
        self.states = self.tmp / "lotuspod-pulls.json"
        bare = self.tmp / "origin.git"
        git(self.tmp, "init", "-q", "--bare", "-b", "main", str(bare))
        git(self.tmp, "clone", "-q", str(bare), str(self.out))
        git(self.out, "config", "user.name", "Lotuspod Test")
        git(self.out, "config", "user.email", "test@example.com")
        git(self.out, "config", "commit.gpgsign", "false")
        self.publish("pond-plan", PAGE_A, shift=SHIFT)
        self.publish("pond-status", PAGE_B, shift=SHIFT)
        manifest = json.loads((self.out / "manifest.json").read_text(encoding="utf-8"))
        self.updated = {meta["file"]: meta["updated"] for meta in manifest["artifacts"]}
        self.merged = stamp(parse(self.updated["pond-plan.html"]) + _dt.timedelta(hours=1))
        self.store(merged_7=True)
        self.port = 0
        # /api, which reads a page's versions, trusts the test key.
        (self.tmp / "config.ini").write_text(keys.config_text(), encoding="utf-8")

    def env(self) -> dict[str, str]:
        env = {key: value for key, value in os.environ.items() if key != "GITHUB_TOKEN"}
        env.update(PYTHONPATH=str(SRC_DIR), LOTUSPOD_CONFIG=str(self.tmp / "config.ini"))
        return env

    def cli(self, *argv: str) -> subprocess.CompletedProcess:
        return subprocess.run([sys.executable, "-m", "lotuspod", *argv], cwd=str(self.tmp),
                              env=self.env(), capture_output=True, text=True, timeout=TIMEOUT)

    def publish(self, name: str, text: str, shift: _dt.timedelta | None = None) -> None:
        source = self.tmp / f"{name}.md"
        source.write_text(text, encoding="utf-8")
        argv = ["publish", str(source), "--local", "--date", CREATED, "--out-dir", str(self.out)]
        if shift is None:
            command = [sys.executable, "-m", "lotuspod", *argv]
        else:
            command = [sys.executable, "-c", SHIFTED_PUBLISH, str(int(shift.total_seconds())),
                       *argv]
        done = subprocess.run(command, cwd=str(self.tmp), env=self.env(), capture_output=True,
                              text=True, timeout=TIMEOUT)
        self.assertEqual(done.returncode, 0, done.stderr)

    def store(self, merged_7: bool) -> None:
        checked = stamp(_dt.datetime.now(_dt.timezone.utc))
        pull_7 = ({"state": "merged", "at": self.merged, "checked": checked} if merged_7
                  else {"state": "open", "at": None, "checked": checked})
        text = json.dumps({"pulls": {
            "acme/pond#7": pull_7,
            "acme/pond#8": {"state": "open", "at": None, "checked": checked},
        }}, indent=2) + "\n"
        before = self.states.stat() if self.states.exists() else None
        self.states.write_text(text, encoding="utf-8")
        # A rewrite within the clock's grain at the same size still reads anew.
        if before is not None and before.st_mtime_ns == self.states.stat().st_mtime_ns:
            os.utime(self.states, ns=(before.st_mtime_ns + 10**9,) * 2)

    def serve(self) -> None:
        self.port = free_port()
        log = open(self.tmp / "serve.log", "w+", encoding="utf-8")
        self.addCleanup(log.close)
        server = subprocess.Popen(
            [sys.executable, "-m", "lotuspod", "serve", "--out-dir", str(self.out),
             "--host", "127.0.0.1", "--port", str(self.port),
             "--db", str(self.tmp / "lotuspod.sqlite3"), "--socket", str(self.sock)],
            cwd=str(self.tmp), env=self.env(), stdout=log, stderr=log)
        self.addCleanup(server.wait, 10)
        self.addCleanup(server.terminate)
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if server.poll() is not None:
                log.seek(0)
                self.fail(f"serve exited {server.returncode}: {log.read()}")
            try:
                if self.ask("/")[0] == 200:
                    return
            except OSError:
                pass
            time.sleep(0.2)
        self.fail("serve did not answer / on its port")

    def ask(self, path: str, headers: dict | None = None
            ) -> tuple[int, http.client.HTTPMessage, str]:
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=30)
        try:
            conn.request("GET", path, headers={"Cf-Access-Jwt-Assertion": keys.assertion(),
                                               **(headers or {})})
            response = conn.getresponse()
            return response.status, response.headers, response.read().decode("utf-8")
        finally:
            conn.close()

    def header_line(self, page: str) -> str:
        found = re.search(r'<header class="artifact-header".*?<p class="artifact-meta">(.*?)</p>',
                          page, re.DOTALL)
        self.assertIsNotNone(found, "no header date line")
        return found.group(1)

    def index_row(self, index: str, name: str) -> str:
        found = re.search(rf'<tr data-page="{name}"[^>]*>.*?</tr>', index, re.DOTALL)
        self.assertIsNotNone(found, f"no index row for {name}")
        return found.group(0)

    def test_a_page_a_merge_overtook_is_marked_and_a_current_one_is_not(self):
        self.serve()
        status, _, page_a = self.ask("/pond-plan.html")
        self.assertEqual(status, 200)
        line = self.header_line(page_a)
        mark = re.search(r'<span class="artifact-stale" title="([^"]*)">([^<]*)</span>', line)
        self.assertIsNotNone(mark, line)
        self.assertEqual(mark.groups(),
                         ("acme/pond#7", "may be out of date · 1 linked PR merged since"))
        self.assertLess(line.index("Updated"), line.index("artifact-stale"))

        status, _, page_b = self.ask("/pond-status.html")
        self.assertEqual(status, 200)
        self.assertNotIn("artifact-stale", page_b)

        status, _, index = self.ask("/index.html")
        self.assertEqual(status, 200)
        row_a = self.index_row(index, "pond-plan")
        self.assertIn('<span class="index-stale" title="acme/pond#7">may be out of date</span>'
                      "</td>", row_a)
        self.assertNotIn("index-stale", self.index_row(index, "pond-status"))

    def test_the_mark_follows_the_stored_states_and_goes_with_a_publish(self):
        self.serve()
        status, headers, page = self.ask("/pond-plan.html")
        self.assertEqual(status, 200)
        self.assertIn("artifact-stale", page)
        tag = headers["ETag"]
        status, _, _ = self.ask("/pond-plan.html", {"If-None-Match": tag})
        self.assertEqual(status, 304)

        self.store(merged_7=False)
        status, headers, page = self.ask("/pond-plan.html", {"If-None-Match": tag})
        self.assertEqual(status, 200)
        self.assertNotEqual(headers["ETag"], tag)
        self.assertNotIn("artifact-stale", page)
        _, _, index = self.ask("/index.html")
        self.assertNotIn("index-stale", index)

        self.store(merged_7=True)
        status, _, page = self.ask("/pond-plan.html")
        self.assertIn("artifact-stale", page)
        self.publish("pond-plan", PAGE_A)
        status, _, page = self.ask("/pond-plan.html")
        self.assertEqual(status, 200)
        self.assertNotIn("artifact-stale", page)
        _, _, index = self.ask("/index.html")
        self.assertNotIn("index-stale", index)

    def test_render_publish_diff_and_an_earlier_version_carry_no_mark(self):
        rendered = self.tmp / "rendered"
        done = self.cli("render", "--name", "pond-plan", "--title", "Pond plan",
                        "--markdown", str(self.tmp / "pond-plan.md"),
                        "--out-dir", str(rendered))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertNotIn("artifact-stale", (rendered / "pond-plan.html").read_text("utf-8"))
        self.assertNotIn("artifact-stale", (self.out / "pond-plan.html").read_text("utf-8"))

        done = self.cli("pages", "diff", "--json", "--out-dir", str(self.out))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(json.loads(done.stdout)["pages"], [])

        self.serve()
        status, _, page = self.ask("/pond-plan.html")
        self.assertIn("artifact-stale", page)
        first = git(self.out, "log", "--format=%H", "--reverse", "--", "pond-plan.html").split()[0]
        status, _, old = self.ask(f"/pond-plan.html?version={first}")
        self.assertEqual(status, 200)
        self.assertIn("artifact-meta", old)
        self.assertNotIn("artifact-stale", old)
        self.assertNotIn("may be out of date", (self.out / "manifest.json").read_text("utf-8"))


if __name__ == "__main__":
    unittest.main()
