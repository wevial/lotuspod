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

# Asks /api/whoami with and without LOTUSPOD_TEST_ASSERTION and records
# each answer's status, Cache-Control and JSON body.
WHOAMI_COMMAND = """\
import json, os, sys, urllib.error, urllib.request
url = os.environ["LOTUSPOD_URL"] + "/api/whoami"
seen = {}
for label, headers in (
    ("with", {"Cf-Access-Jwt-Assertion": os.environ["LOTUSPOD_TEST_ASSERTION"]}),
    ("without", {}),
):
    try:
        response = urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=10)
    except urllib.error.HTTPError as exc:
        response = exc
    with response:
        seen[label] = [response.status, response.headers["Cache-Control"],
                       json.loads(response.read().decode("utf-8"))]
with open(sys.argv[1], "w", encoding="utf-8") as fh:
    json.dump(seen, fh)
"""

# Posts an answer to capture-decisions' first question, then records the
# answer's status, the status of the page and of /lotuspod.sqlite3, and every
# lotuspod.sqlite3 under the scratch directory (TMPDIR) while the site is served.
ANSWER_COMMAND = """\
import json, os, pathlib, re, sys, urllib.error, urllib.request
base = os.environ["LOTUSPOD_URL"]
with urllib.request.urlopen(base + "/capture-decisions.html", timeout=10) as response:
    page = response.read().decode("utf-8")
version = re.search(r'data-question="decision-1" data-version="([0-9a-f]+)"', page).group(1)
body = json.dumps({"page": "capture-decisions", "question": "decision-1", "version": version,
                   "choice": "opus", "note": ""}).encode("utf-8")
request = urllib.request.Request(base + "/api/answers", data=body, method="POST", headers={
    "Content-Type": "application/json",
    "Cf-Access-Jwt-Assertion": os.environ["LOTUSPOD_TEST_ASSERTION"],
})
seen = {}
with urllib.request.urlopen(request, timeout=10) as response:
    seen["answer"] = response.status
for path in ("/capture-decisions.html", "/lotuspod.sqlite3", "/site/lotuspod.sqlite3"):
    try:
        with urllib.request.urlopen(base + path, timeout=10) as response:
            seen[path] = response.status
    except urllib.error.HTTPError as exc:
        seen[path] = exc.code
seen["databases"] = sorted(str(p) for p in pathlib.Path(os.environ["TMPDIR"]).rglob("lotuspod.sqlite3"))
with open(sys.argv[1], "w", encoding="utf-8") as fh:
    json.dump(seen, fh)
"""

# Asks the agent socket LOTUSPOD_TEST_SOCKET names GET /v1/whoami with each
# credential the environment names, fetches the owned page and its source
# over HTTP, and records what it saw with the environment's other names and
# the owned page's source file in LOTUSPOD_TEST_OUT.
AGENT_COMMAND = """\
import json, os, pathlib, stat, sys, urllib.error, urllib.request
sys.path.insert(0, "src")
from lotuspod import machine
env = os.environ
socket_path = env["LOTUSPOD_TEST_SOCKET"]
seen = {"python": env["LOTUSPOD_TEST_PYTHON"], "out": env["LOTUSPOD_TEST_OUT"],
        "socketMode": stat.S_IMODE(os.stat(socket_path).st_mode), "whoami": {}}
for label in ("HERMES", "OTHER"):
    token = machine.read_token(env["LOTUSPOD_TEST_CREDENTIAL_" + label])
    seen["whoami"][label] = machine.request(socket_path, token, "GET", "/v1/whoami")
seen["whoami"]["none"] = machine.request(socket_path, None, "GET", "/v1/whoami")
for path in ("/capture-owned.html", "/capture-owned.md"):
    try:
        with urllib.request.urlopen(env["LOTUSPOD_URL"] + path, timeout=10) as response:
            seen[path] = [response.status, response.read().decode("utf-8")]
    except urllib.error.HTTPError as exc:
        seen[path] = [exc.code, ""]
source = pathlib.Path(env["LOTUSPOD_TEST_OUT"]) / "capture-owned.md"
seen["source"] = source.read_text(encoding="utf-8") if source.is_file() else None
with open(sys.argv[1], "w", encoding="utf-8") as fh:
    json.dump(seen, fh)
"""

# Fetches the passages page and records it with the source beside the site.
PASSAGES_COMMAND = """\
import json, os, pathlib, sys, urllib.request
with urllib.request.urlopen(os.environ["LOTUSPOD_URL"] + "/capture-passages.html", timeout=10) as response:
    seen = {"page": [response.status, response.read().decode("utf-8")]}
source = pathlib.Path(os.environ["LOTUSPOD_TEST_OUT"]).parent / "capture-passages.md"
seen["source"] = source.read_text(encoding="utf-8") if source.is_file() else None
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
        self.assertNotIn("<form", article)

        self.assertIn("artifact--report", seen["/capture-report.html"][1])

    def test_decisions_page_has_its_forms_and_page_script(self):
        seen = self.fetch("/capture-decisions.html", "/lotuspod-page.js", "/capture-article.html")
        status, page = seen["/capture-decisions.html"]
        self.assertEqual(status, 200)
        self.assertEqual(page.count('<form class="artifact-decision"'), 2)
        self.assertIn('data-question="decision-1"', page)
        self.assertIn('data-question="decision-2"', page)
        self.assertIn('<script src="lotuspod-page.js?v=', page)
        self.assertNotIn("<table", page)
        self.assertEqual(seen["/lotuspod-page.js"][0], 200)
        # The article has no forms, but folds its two sections.
        self.assertIn('<script src="lotuspod-page.js?v=', seen["/capture-article.html"][1])

    def test_review_sheet_page_asks_six_decisions_and_a_checklist_in_four_sections(self):
        seen = self.fetch("/capture-review-sheet.html")
        status, page = seen["/capture-review-sheet.html"]
        self.assertEqual(status, 200)
        self.assertEqual(page.count('<div class="artifact-section-body"'), 4)
        self.assertEqual(page.count('<form class="artifact-decision"'), 6)
        self.assertEqual(page.count('<form class="artifact-decision artifact-decision--checklist"'), 1)
        for default in ("codex", "3-rounds", "holophyte-only"):
            self.assertIn(f'data-default="{default}"', page)
        self.assertEqual(page.count("data-default="), 3)

    def test_sections_page_wraps_each_section_with_its_box_and_form(self):
        seen = self.fetch("/capture-sections.html")
        status, page = seen["/capture-sections.html"]
        self.assertEqual(status, 200)
        self.assertEqual(page.count('<div class="artifact-section-body"'), 3)
        self.assertEqual(page.count('<details class="artifact-comment" data-page="capture-sections"'), 3)
        self.assertEqual(page.count('<form class="artifact-decision"'), 1)
        self.assertIn("frazil", page)
        self.assertIn("<pre><code>", page)
        self.assertIn('<script src="lotuspod-page.js?v=', page)

    def test_palette_page_has_every_coloured_element_and_a_box_per_section(self):
        seen = self.fetch("/capture-palette.html")
        status, page = seen["/capture-palette.html"]
        self.assertEqual(status, 200)
        self.assertEqual(page.count('<details class="artifact-comment" data-page="capture-palette"'), 4)
        self.assertIn('<a href="capture-article.html">', page)
        self.assertIn("<code>lotuspod publish</code>", page)
        self.assertIn("<th>Month</th>", page)
        self.assertIn("<cite>The pond keeper's notebook</cite>", page)
        self.assertIn("<pre><code>", page)
        self.assertIn('<script src="lotuspod-page.js?v=', page)

    def test_passages_page_is_owned_and_its_source_is_beside_the_site(self):
        from tests import capture_site

        proc = self.run_wrapper(sys.executable, "-c", PASSAGES_COMMAND, str(self.record))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        seen = json.loads(self.record.read_text(encoding="utf-8"))
        status, page = seen["page"]
        self.assertEqual(status, 200)
        self.assertIn("Published by hermes", page)
        self.assertIn('<meta name="lotuspod:revision"', page)
        self.assertEqual(page.count('<details class="artifact-comment" data-page="capture-passages"'), 3)
        self.assertEqual(page.count('<form class="artifact-decision"'), 1)
        self.assertIn(
            "<p>The pond pump stops when the water freezes. The heater on the north wall keeps "
            "the outlet clear, and the pump stops again only in a hard frost.</p>", page)
        self.assertIn("<li>A frozen pump may crack before anyone notices.</li>", page)
        self.assertIn("<li>A cracked pump floods the bed below it.</li>", page)
        long = [line for line in page.splitlines() if line.startswith("<p>Through the winter")]
        self.assertEqual(len(long), 1)
        self.assertGreater(len(long[0]) - len("<p></p>"), 500)
        self.assertEqual(seen["source"], capture_site.PASSAGES_SOURCE)

    def test_form_script_answers_404(self):
        seen = self.fetch("/lotuspod-form.js")
        self.assertEqual(seen["/lotuspod-form.js"][0], 404)

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


class TestAssertionTests(CaptureSiteTestCase):
    def test_site_accepts_the_named_assertion(self):
        proc = self.run_wrapper(
            sys.executable, "-c", WHOAMI_COMMAND, str(self.record)
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        seen = json.loads(self.record.read_text(encoding="utf-8"))
        self.assertEqual(
            seen["with"],
            [200, "no-store", {"actor": {"kind": "human", "email": "maintainer@example.com"}}],
        )
        self.assertEqual(seen["without"], [401, "no-store", {"error": "signed_out"}])


class DatabaseTests(CaptureSiteTestCase):
    def test_answers_go_to_the_scratch_directory_beside_the_site(self):
        outside = [REPO_ROOT / "lotuspod.sqlite3", REPO_ROOT.parent / "lotuspod.sqlite3"]
        before = [path.exists() for path in outside]
        proc = self.run_wrapper(
            sys.executable, "-c", ANSWER_COMMAND, str(self.record)
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        seen = json.loads(self.record.read_text(encoding="utf-8"))
        self.assertEqual(seen["answer"], 201)
        self.assertEqual(seen["/capture-decisions.html"], 200)
        self.assertEqual(seen["/lotuspod.sqlite3"], 404)
        self.assertEqual(seen["/site/lotuspod.sqlite3"], 404)
        # One database, at the top of the fixture's own temporary directory,
        # outside the site it rendered there.
        self.assertEqual(len(seen["databases"]), 1)
        database = Path(seen["databases"][0])
        self.assertEqual(database.parent.parent, self.scratch)
        self.assertTrue(database.parent.name.startswith("lotuspod-capture-"))
        self.assertEqual([path.exists() for path in outside], before)
        self.assertEqual(list(self.scratch.iterdir()), [])


class AgentSocketTests(CaptureSiteTestCase):
    def test_socket_credentials_and_owned_page(self):
        from tests import capture_site

        proc = self.run_wrapper(sys.executable, "-c", AGENT_COMMAND, str(self.record))
        self.assertEqual(proc.returncode, 0, proc.stderr)
        seen = json.loads(self.record.read_text(encoding="utf-8"))

        hermes_status, hermes = seen["whoami"]["HERMES"]
        self.assertEqual(hermes_status, 200)
        self.assertEqual(hermes["credential"]["name"], "hermes")
        self.assertEqual(hermes["credential"]["handles"], ["hermes"])
        self.assertEqual(hermes["credential"]["operations"],
                         ["pull", "claim", "reply", "publish"])
        self.assertIsNone(hermes["credential"]["revokedAt"])
        self.assertNotIn("tokenHash", hermes["credential"])
        other_status, other = seen["whoami"]["OTHER"]
        self.assertEqual(other_status, 200)
        self.assertEqual(other["credential"]["name"], "claude-3f9a2c")
        self.assertEqual(other["credential"]["handles"], ["claude-3f9a2c"])
        self.assertNotIn("publish", other["credential"]["operations"])
        self.assertEqual(seen["whoami"]["none"], [401, {"error": "invalid_credential"}])
        self.assertEqual(seen["socketMode"], 0o600)

        status, page = seen["/capture-owned.html"]
        self.assertEqual(status, 200)
        self.assertIn("Published by hermes", page)
        self.assertEqual(page.count('<form class="artifact-decision"'), 1)
        self.assertIn('data-section="pump"', page)
        self.assertIn('data-section="heater"', page)
        # The source leaves the host's files only through the socket's pull.
        self.assertEqual(seen["/capture-owned.md"][0], 404)
        self.assertEqual(seen["source"], capture_site.OWNED_SOURCE)

        out = Path(seen["out"])
        self.assertEqual(out.name, "site")
        self.assertEqual(out.parent.parent, self.scratch)
        self.assertEqual(seen["python"], sys.executable)
        # The socket, the tokens and the site go with the directory.
        self.assertEqual(list(self.scratch.iterdir()), [])


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

    def test_joined_stylesheet_sits_in_the_theme_while_the_command_runs(self):
        from tests import capture_site

        packaged = capture_site.PACKAGED_CSS
        self.assertFalse(packaged.exists())
        proc = self.run_wrapper(
            sys.executable, "-c",
            "import pathlib, sys; pathlib.Path(sys.argv[2]).write_bytes("
            "pathlib.Path(sys.argv[1]).read_bytes())",
            str(packaged), str(self.record),
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(self.record.read_bytes(),
                         capture_site.cli.theme_file_bytes("lotuspod.css"))
        self.assertFalse(packaged.exists())

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
        # The owned page's publish is the first step to build the index.
        self.assertIn("error: index broken", proc.stderr)
        self.assertIn("failed with exit code 1", proc.stderr)
        self.assertFalse(self.record.exists())
        self.assertEqual(list(self.scratch.iterdir()), [])


class ArtifactsUntouchedTests(CaptureSiteTestCase):
    def test_artifacts_listing_is_unchanged(self):
        before = artifacts_listing()
        self.fetch("/")
        self.assertEqual(artifacts_listing(), before)


if __name__ == "__main__":
    unittest.main()
