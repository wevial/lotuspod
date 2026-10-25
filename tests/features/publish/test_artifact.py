"""`lotuspod publish --artifact`: a Claude artifact's HTML file published as a
live pod with its CDN scripts inlined, its font links dropped and its
data-theme following the reader's theme, with real git and the publishing
witness's SSH transport. The CLI runs in a process whose one fetch function
answers fixed bytes, so no test reaches the network."""

from __future__ import annotations

import base64
import hashlib
import html
import json
import re
import subprocess
import sys
import unittest
from pathlib import Path

from tests.features.publish import test_publish_remote_witness as witness
from tests.features.publish.test_publish_remote_witness import TIMEOUT, git

CDNJS = "https://cdnjs.cloudflare.com/ajax/libs/pump/1.0.0/pump.min.js"
JSDELIVR = "https://cdn.jsdelivr.net/npm/valve@2.1.0/dist/valve.js"
CDNJS_BYTES = b"window.pump = {speed: 3};"
JSDELIVR_BYTES = b"window.valve = function () { return 'open'; };"

# Runs the CLI with artifact.fetch answering from the JSON file named in
# ARTIFACT_FETCHES: a URL's text, or null for a fetch that fails.
LAUNCHER = """\
import json, os, sys
from lotuspod.cli import main
from lotuspod.features.publish import artifact
with open(os.environ["ARTIFACT_FETCHES"], encoding="utf-8") as stream:
    answers = json.load(stream)
def fetch(url):
    with open(os.environ["ARTIFACT_FETCHES"] + ".log", "a", encoding="utf-8") as log:
        log.write(url + "\\n")
    if answers.get(url) is None:
        raise OSError("connection refused")
    return answers[url].encode("utf-8")
artifact.fetch = fetch
sys.exit(main(sys.argv[1:]))
"""


def sri(data: bytes, algorithm: str = "sha384") -> str:
    return algorithm + "-" + base64.b64encode(hashlib.new(algorithm, data).digest()).decode()


def csp_hash(data: bytes) -> str:
    return "'sha256-" + base64.b64encode(hashlib.sha256(data).digest()).decode() + "'"


def document(head: str = "", body: str = "") -> str:
    return ('<!DOCTYPE html><html lang="en"><head><meta charset="utf-8">'
            f'<title>Pump board</title>{head}<style>body {{ padding: 8px; }}</style></head>'
            f'<body><p>Board</p>{body}</body></html>\n')


SCRIPTS = (f'<script src="{CDNJS}" integrity="{sri(CDNJS_BYTES)}" crossorigin="anonymous" '
           f'referrerpolicy="no-referrer"></script><p>between</p>'
           f'<script src="{JSDELIVR}"></script>')
INLINED = (f"<script>{CDNJS_BYTES.decode()}</script><p>between</p>"
           f"<script>{JSDELIVR_BYTES.decode()}</script>")


class ArtifactPublish(unittest.TestCase):
    # The witness's real git and SSH fixture, without its test cases.
    setUp_witness = witness.RemotePublishWitness.setUp
    write_config = witness.RemotePublishWitness.write_config
    calls = witness.RemotePublishWitness.calls
    commits = witness.RemotePublishWitness.commits
    remote_bytes = witness.RemotePublishWitness.remote_bytes

    def setUp(self):
        self.setUp_witness()
        self.launcher = self.tmp / "launch.py"
        self.launcher.write_text(LAUNCHER, encoding="utf-8")
        self.fetches = self.tmp / "fetches.json"
        self.answer({CDNJS: CDNJS_BYTES.decode(), JSDELIVR: JSDELIVR_BYTES.decode()})
        self.env["ARTIFACT_FETCHES"] = str(self.fetches)

    def answer(self, answers: dict) -> None:
        self.fetches.write_text(json.dumps(answers), encoding="utf-8")

    def fetched(self) -> list[str]:
        log = Path(str(self.fetches) + ".log")
        return log.read_text().splitlines() if log.exists() else []

    def source(self, text: str) -> Path:
        path = self.tmp / "board.html"
        path.write_text(text, encoding="utf-8")
        return path

    def publish(self, source: Path, *extra: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(self.launcher), "publish", str(source), *extra],
            cwd=str(self.tmp), env=self.env, capture_output=True, text=True, timeout=TIMEOUT)

    def publish_local(self, source: Path, *extra: str) -> subprocess.CompletedProcess:
        return self.publish(source, "--artifact", "--local", "--out-dir", str(self.out), *extra)

    def widget(self) -> str:
        return next(self.out.glob("board.w-*.html")).read_text(encoding="utf-8")

    def test_cdn_scripts_are_inlined_in_place_and_covered_by_their_hashes(self):
        done = self.publish_local(self.source(document(body=SCRIPTS)))
        self.assertEqual(done.returncode, 0, done.stderr)
        self.assertEqual(self.fetched(), [CDNJS, JSDELIVR])
        page = (self.out / "board.html").read_text(encoding="utf-8")
        self.assertIn('<h1 class="artifact-title">Pump board</h1>', page)
        widget = self.widget()
        self.assertIn(INLINED, widget)
        self.assertNotIn(CDNJS, widget)
        self.assertNotIn(JSDELIVR, widget)
        policy = html.unescape(re.search(
            r'<meta http-equiv="Content-Security-Policy" content="([^"]*)"', widget).group(1))
        script_src = re.search(r"script-src ([^;]*)", policy).group(1).split()
        for data in (CDNJS_BYTES, JSDELIVR_BYTES):
            self.assertIn(csp_hash(data), script_src)
        self.assertFalse([source for source in script_src if "https:" in source], script_src)
        kept = (self.out / "board.md").read_text(encoding="utf-8")
        self.assertIn(INLINED, kept)
        self.assertNotIn("src=", kept)
        names = git(self.out, "show", "--pretty=", "--name-only", "HEAD").stdout.decode()
        for name in ("board.html", "board.md"):
            self.assertIn(name, names.split())
        self.assertEqual(self.commits(), 1)

    def test_the_theme_script_comes_first_after_the_policy_and_bridge(self):
        done = self.publish_local(self.source(document()))
        self.assertEqual(done.returncode, 0, done.stderr)
        widget = self.widget()
        bridge = widget.index("lotuspod:resize")
        theme = widget.index('setAttribute("data-theme", "light")')
        self.assertLess(bridge, theme)
        self.assertLess(theme, widget.index("<title>Pump board</title>"))

    def test_refusals_name_the_url_and_write_nothing(self):
        cases = [
            ("integrity", CDNJS, f'<script src="{CDNJS}" integrity="{sri(b"other")}"></script>'),
            ("unpkg", "https://unpkg.com/pump@1.0.0/pump.js",
             '<script src="https://unpkg.com/pump@1.0.0/pump.js"></script>'),
            ("stylesheet", "https://example.com/board.css",
             '<link rel="stylesheet" href="https://example.com/board.css">'),
            ("fetch", JSDELIVR, f'<script src="{JSDELIVR}"></script>'),
        ]
        self.answer({CDNJS: CDNJS_BYTES.decode(), JSDELIVR: None})
        for case, url, element in cases:
            with self.subTest(case=case):
                done = self.publish_local(self.source(document(head=element)))
                self.assertNotEqual(done.returncode, 0)
                self.assertIn(url, done.stderr)
                self.assertEqual(list(self.out.glob("board*")), [])
                self.assertEqual(git(self.out, "rev-list", "--all").stdout, b"")
                self.assertEqual(self.commits(), 0)

    def test_font_links_are_dropped_with_one_warning_per_stylesheet(self):
        stylesheet = "https://fonts.googleapis.com/css2?family=Inter:wght@400;600&display=swap"
        head = ('<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>'
                f'<link href="{html.escape(stylesheet)}" rel="stylesheet">')
        done = self.publish_local(self.source(document(head=head)))
        self.assertEqual(done.returncode, 0, done.stderr)
        widget = self.widget()
        self.assertNotIn("fonts.googleapis.com", widget)
        self.assertNotIn("fonts.gstatic.com", widget)
        warnings = [line for line in done.stderr.splitlines() if line.startswith("warning:")]
        self.assertEqual(len([line for line in warnings if "fonts." in line]), 1, done.stderr)
        self.assertIn(stylesheet, done.stderr)

    def test_over_ssh_the_writer_host_receives_the_adapted_document(self):
        source = self.source(document(body=f'<script src="{JSDELIVR}"></script>'))
        done = self.publish(source, "--artifact")
        self.assertEqual(done.returncode, 0, done.stderr)
        calls = self.calls()
        self.assertEqual(len(calls), 1, calls)
        self.assertNotIn("--artifact", calls[0][-1])
        kept = self.remote_bytes("board.md").decode("utf-8")
        self.assertIn(f"<script>{JSDELIVR_BYTES.decode()}</script>", kept)
        self.assertNotIn(JSDELIVR, kept)
        self.assertEqual(self.fetched(), [JSDELIVR])


if __name__ == "__main__":
    unittest.main()
