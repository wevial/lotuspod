"""Test suite for the capture fixture (`tests/capture_site.py`): a sample site
rendered into a scratch directory and served on a free loopback port around
one command.

Each test drives the module as a subprocess, the way a capture runner does,
and gives it a Python command: no Node, no browser. The command writes what
it saw to a file the test owns.

Run from the repo root:

    python -m unittest tests.test_capture_site -v
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
import urllib.error
import urllib.request
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS_DIR = REPO_ROOT / "artifacts"

# Fetches every path in argv[2:] from LOTUSPOD_URL and records status + body.
FETCH_COMMAND = """\
import json, os, sys, urllib.error, urllib.request
base = os.environ["LOTUSPOD_URL"]
seen = {}
for path in sys.argv[2:]:
    try:
        with urllib.request.urlopen(base + path, timeout=10) as response:
            seen[path] = [response.status, response.read().decode("utf-8")]
    except urllib.error.HTTPError as exc:
        seen[path] = [exc.code, ""]
with open(sys.argv[1], "w", encoding="utf-8") as fh:
    json.dump(seen, fh)
"""

# Records LOTUSPOD_URL and the working directory, then exits 3.
RECORD_COMMAND = """\
import json, os, sys
with open(sys.argv[1], "w", encoding="utf-8") as fh:
    json.dump({"url": os.environ["LOTUSPOD_URL"], "cwd": os.getcwd()}, fh)
raise SystemExit(3)
"""


def artifacts_listing() -> list[str] | None:
    if not ARTIFACTS_DIR.is_dir():
        return None
    return sorted(str(p.relative_to(ARTIFACTS_DIR)) for p in ARTIFACTS_DIR.rglob("*"))


class CaptureSiteTestCase(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.work = Path(tmp.name)
        self.record = self.work / "record.json"
        # A temporary directory the test owns: whatever the wrapper makes
        # lands here, so what it leaves behind can be seen.
        self.scratch = self.work / "scratch"
        self.scratch.mkdir()

    def run_wrapper(self, *command: str) -> subprocess.CompletedProcess:
        env = dict(os.environ, TMPDIR=str(self.scratch))
        return subprocess.run(
            [sys.executable, "-m", "tests.capture_site", *command],
            capture_output=True, text=True, env=env, cwd=str(REPO_ROOT),
            timeout=60, check=False,
        )

    def fetch(self, *paths: str) -> dict:
        proc = self.run_wrapper(
            sys.executable, "-c", FETCH_COMMAND, str(self.record), *paths
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return json.loads(self.record.read_text(encoding="utf-8"))


class ServedSiteTests(CaptureSiteTestCase):
    def test_sample_site_answers_and_wrapper_exits_zero(self):
        seen = self.fetch(
            "/", "/capture-article.html", "/capture-report.html", "/lotuspod.css"
        )
        for path, (status, _body) in seen.items():
            with self.subTest(path=path):
                self.assertEqual(status, 200)
        self.assertEqual(len(seen), 4)

        index = seen["/"][1]
        self.assertIn("Capture article", index)
        self.assertIn("Capture report", index)
        self.assertNotIn("Capture hidden", index)

        article = seen["/capture-article.html"][1]
        self.assertIn("artifact-outline-list", article)
        self.assertIn('href="#first-section"', article)
        self.assertIn('href="#second-section"', article)
        self.assertIn('<form class="artifact-form"', article)
        self.assertIn('data-page="capture-article"', article)

        self.assertIn("artifact--report", seen["/capture-report.html"][1])

    def test_form_script_is_served(self):
        seen = self.fetch("/lotuspod-form.js")
        self.assertEqual(seen["/lotuspod-form.js"][0], 200)

    def test_hidden_page_answers_404(self):
        seen = self.fetch("/capture-hidden.html")
        self.assertEqual(seen["/capture-hidden.html"][0], 404)

    def test_every_run_renders_the_same_bytes(self):
        first = self.fetch("/", "/capture-article.html")
        second = self.fetch("/", "/capture-article.html")
        self.assertEqual(first, second)

    def fetch_on(self, day: str, *paths: str) -> dict:
        # Move the CLI's clock from outside: a sitecustomize swaps the
        # datetime module cli.py reads for one whose today() is `day`.
        hook = self.work / f"clock-{day}"
        hook.mkdir()
        (hook / "sitecustomize.py").write_text(
            "import datetime, sys, types\n"
            f"sys.path.insert(0, {str(REPO_ROOT / 'src')!r})\n"
            "from lotuspod import cli\n"
            "class _Day(datetime.date):\n"
            "    @classmethod\n"
            "    def today(cls):\n"
            f"        return cls.fromisoformat({day!r})\n"
            "clock = types.ModuleType('datetime')\n"
            "clock.__dict__.update(vars(datetime))\n"
            "clock.date = _Day\n"
            "cli._dt = clock\n",
            encoding="utf-8",
        )
        env = dict(os.environ, TMPDIR=str(self.scratch), PYTHONPATH=str(hook))
        proc = subprocess.run(
            [sys.executable, "-m", "tests.capture_site",
             sys.executable, "-c", FETCH_COMMAND, str(self.record), *paths],
            capture_output=True, text=True, env=env, cwd=str(REPO_ROOT),
            timeout=60, check=False,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return json.loads(self.record.read_text(encoding="utf-8"))

    def test_another_calendar_day_renders_the_same_bytes(self):
        paths = ("/", "/capture-article.html", "/capture-report.html")
        first = self.fetch_on("2031-03-04", *paths)
        second = self.fetch_on("2032-11-12", *paths)
        self.assertEqual(first, second)
        for path, (_status, body) in first.items():
            with self.subTest(path=path):
                self.assertNotIn("2031-03-04", body)


class TeardownTests(CaptureSiteTestCase):
    def test_command_exit_code_and_cleanup(self):
        proc = self.run_wrapper(
            sys.executable, "-c", RECORD_COMMAND, str(self.record)
        )
        self.assertEqual(proc.returncode, 3, proc.stderr)

        recorded = json.loads(self.record.read_text(encoding="utf-8"))
        self.assertRegex(recorded["url"], r"^http://127\.0\.0\.1:[1-9]\d*$")
        self.assertEqual(Path(recorded["cwd"]), REPO_ROOT)
        with self.assertRaises(urllib.error.URLError) as caught:
            urllib.request.urlopen(recorded["url"] + "/", timeout=5)
        self.assertIsInstance(caught.exception.reason, ConnectionRefusedError)

        self.assertEqual(list(self.scratch.iterdir()), [])

    def test_no_command_exits_2_with_usage(self):
        proc = self.run_wrapper()
        self.assertEqual(proc.returncode, 2)
        self.assertIn("usage:", proc.stderr)
        self.assertEqual(list(self.scratch.iterdir()), [])

    def test_failed_render_exits_1_and_command_does_not_run(self):
        # Break the render from outside: a sitecustomize makes the CLI's
        # index step fail, and the wrapper must stop before COMMAND.
        hook = self.work / "hook"
        hook.mkdir()
        (hook / "sitecustomize.py").write_text(
            "import os, sys\n"
            f"sys.path.insert(0, {str(REPO_ROOT / 'src')!r})\n"
            "from lotuspod import cli\n"
            "def _fail(args):\n"
            "    raise RuntimeError('index broken')\n"
            "cli.cmd_index = _fail\n",
            encoding="utf-8",
        )
        env = dict(os.environ, TMPDIR=str(self.scratch), PYTHONPATH=str(hook))
        proc = subprocess.run(
            [sys.executable, "-m", "tests.capture_site",
             sys.executable, "-c", RECORD_COMMAND, str(self.record)],
            capture_output=True, text=True, env=env, cwd=str(REPO_ROOT),
            timeout=60, check=False,
        )
        self.assertEqual(proc.returncode, 1, proc.stderr)
        self.assertIn("index failed", proc.stderr)
        self.assertFalse(self.record.exists())
        self.assertEqual(list(self.scratch.iterdir()), [])


class ArtifactsUntouchedTests(CaptureSiteTestCase):
    def test_artifacts_listing_is_unchanged(self):
        before = artifacts_listing()
        self.fetch("/")
        self.assertEqual(artifacts_listing(), before)


if __name__ == "__main__":
    unittest.main()
