"""`lotuspod pages diff` lists each page whose body render_kept() now gives
differently from its published file: `markup` when only the HTML differs,
`text` naming the sections whose text changed, `anchors` naming each anchor
moved, and `failed` with the render's error; it writes nothing.

The pages are published with the real `lotuspod publish --local`, into a
clone of a local bare repository; the report runs as a subprocess of this
checkout's src/. Real git, no network.

Run from the repo root:

    python -m unittest tests.features.publish.test_pages_diff -v
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

SRC_DIR = Path(__file__).resolve().parents[3] / "src"

TIMEOUT = 120

FRESH = "# Fresh\n\nStill water.\n\n## Fish\n\nThree.\n\n## Plants\n\nLilies.\n"
DRIFTED = ("# Drifted\n\nA survey of the beds.\n\n## Findings\n\nThe north bed is dry.\n\n"
           "## Next steps\n\nWater it weekly.\n")
RESTYLED = "# Restyled\n\nGravel paths.\n\n## Paths\n\nRaked smooth.\n\n## Edges\n\nStone.\n"
MOVED = "# Moved\n\nA shed.\n\n## Roof\n\nSlate.\n\n## Door\n\nOak.\n"
PICTURED = "# Pictured\n\nA pond.\n\n## Banks\n\nReeds.\n"


def git(cwd: Path, *argv: str) -> str:
    return subprocess.run(["git", "-C", str(cwd), *argv], capture_output=True, text=True,
                          check=True).stdout


def lotuspod(*argv: str, cwd: Path) -> subprocess.CompletedProcess:
    env = dict(os.environ, PYTHONPATH=str(SRC_DIR),
               LOTUSPOD_CONFIG=str(cwd / "no-config.ini"))
    return subprocess.run([sys.executable, "-m", "lotuspod", *argv], cwd=str(cwd), env=env,
                          capture_output=True, text=True, timeout=TIMEOUT)


class PagesDiffTests(unittest.TestCase):
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
        for name, text in (("fresh", FRESH), ("drifted", DRIFTED), ("restyled", RESTYLED)):
            self.publish(name, text)
        self.edit("drifted.md", "The north bed is dry.", "The north bed is flooded.")
        self.edit("restyled.html", "<p>Raked smooth.</p>", "<p><span>Raked</span> smooth.</p>")

    def publish(self, name: str, text: str) -> None:
        source = self.tmp / f"{name}.md"
        source.write_text(text, encoding="utf-8")
        done = lotuspod("publish", str(source), "--local", "--out-dir", str(self.out_dir),
                        cwd=self.tmp)
        self.assertEqual(done.returncode, 0, done.stderr)

    def edit(self, file: str, old: str, new: str) -> None:
        path = self.out_dir / file
        text = path.read_text(encoding="utf-8")
        self.assertEqual(text.count(old), 1, f"{old!r} in {file}")
        path.write_text(text.replace(old, new), encoding="utf-8")

    def report(self, *extra: str) -> subprocess.CompletedProcess:
        return lotuspod("pages", "diff", "--out-dir", str(self.out_dir), *extra, cwd=self.tmp)

    def files(self) -> dict[str, tuple[bytes, int]]:
        return {path.relative_to(self.out_dir).as_posix(): (path.read_bytes(),
                                                            path.stat().st_mtime_ns)
                for path in self.out_dir.rglob("*")
                if path.is_file() and ".git" not in path.relative_to(self.out_dir).parts}

    def commits(self) -> tuple[str, str]:
        return (git(self.out_dir, "rev-list", "--all"), git(self.bare, "rev-list", "--all"))

    def test_a_drifted_source_and_a_restyled_file_are_listed_and_a_fresh_page_is_not(self):
        done = self.report()
        self.assertEqual((done.returncode, done.stderr), (0, ""))
        self.assertEqual(done.stdout.splitlines(), [
            "drifted  text  Findings changed",
            "restyled  markup",
            "3 pages: 1 same, 1 markup, 1 text, 0 anchors, 0 failed",
        ])

    def test_json_holds_the_same_pages_and_counts(self):
        text = self.report()
        done = self.report("--json")
        self.assertEqual((done.returncode, done.stderr), (0, ""))
        found = json.loads(done.stdout)
        pages = {page["name"]: page for page in found["pages"]}
        self.assertEqual(set(pages), {"drifted", "restyled"})
        self.assertEqual(pages["drifted"], {"name": "drifted", "kind": "text",
                                            "sections": ["Findings"], "anchors": [],
                                            "error": ""})
        self.assertEqual(pages["restyled"]["kind"], "markup")
        self.assertEqual(pages["restyled"]["sections"], [])
        counts = found["counts"]
        self.assertEqual(text.stdout.splitlines()[-1],
                         f"{counts['pages']} pages: {counts['same']} same, "
                         f"{counts['markup']} markup, {counts['text']} text, "
                         f"{counts['anchors']} anchors, {counts['failed']} failed")
        self.assertEqual(counts, {"pages": 3, "same": 1, "markup": 1, "text": 1,
                                  "anchors": 0, "failed": 0})

    def test_a_second_h2_id_edited_in_the_file_is_named_under_anchors(self):
        self.publish("moved", MOVED)
        self.edit("moved.html", '<h2 id="door">', '<h2 id="entrance">')
        done = self.report()
        self.assertEqual((done.returncode, done.stderr), (0, ""))
        lines = done.stdout.splitlines()
        self.assertIn("moved  anchors  h2 id 'entrance' in the file, 'door' in the render",
                      lines)
        self.assertEqual(lines[-1], "4 pages: 1 same, 1 markup, 1 text, 1 anchors, 0 failed")

        moved = {page["name"]: page for page in json.loads(self.report("--json").stdout)
                 ["pages"]}["moved"]
        self.assertEqual(moved["kind"], "anchors")
        self.assertEqual(moved["anchors"], [{"kind": "h2 id", "page": "entrance",
                                             "render": "door"}])

    def test_a_page_whose_render_fails_is_failed_and_the_others_still_reported(self):
        self.publish("pictured", PICTURED)
        missing = "/media/" + "0" * 64 + ".png"
        self.edit("pictured.md", "A pond.\n", f"A pond.\n\n![Bank]({missing})\n")
        done = self.report()
        self.assertEqual((done.returncode, done.stderr), (1, ""))
        self.assertEqual(done.stdout.splitlines(), [
            "drifted  text  Findings changed",
            f"pictured  failed  no size for image {missing}",
            "restyled  markup",
            "4 pages: 1 same, 1 markup, 1 text, 0 anchors, 1 failed",
        ])
        done = self.report("--json")
        self.assertEqual(done.returncode, 1)
        pictured = {page["name"]: page for page in json.loads(done.stdout)["pages"]}["pictured"]
        self.assertEqual((pictured["kind"], pictured["error"]),
                         ("failed", f"no size for image {missing}"))

    def test_the_report_writes_nothing_and_commits_nothing(self):
        git(self.out_dir, "add", "-A")
        git(self.out_dir, "commit", "-q", "-m", "edit pages")
        before, commits = self.files(), self.commits()
        status = git(self.out_dir, "status", "--porcelain")
        for extra in ((), ("--json",)):
            with self.subTest(argv=extra):
                done = self.report(*extra)
                self.assertEqual((done.returncode, done.stderr), (0, ""))
                self.assertEqual(self.files(), before)
                self.assertEqual(self.commits(), commits)
                self.assertEqual(git(self.out_dir, "status", "--porcelain"), status)


if __name__ == "__main__":
    unittest.main()
