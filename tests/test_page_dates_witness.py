"""Witness: a page carries the date it was created and the time it was last
updated. Publish keeps the first and stamps the second; the manifest records
both, taking an unstamped page's updated time from its newest commit when the
output directory is the top of its own repository.

Real git in temporary directories, with a local identity. The CLI runs as a
subprocess of this checkout's src/, and the pages are read by parsing them.
"""

from __future__ import annotations

import datetime
import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from tests.test_publish_witness import Node, meta, parse

REPO = Path(__file__).resolve().parents[1]
SRC = REPO / "src"
TIMEOUT = 120

FIRST = """\
# Pond plan

The pond needs clean water.

## Next steps

1. Order a pump
"""

SECOND = FIRST.replace("1. Order a pump", "1. The pump was replaced")


def git(cwd: Path, *argv: str, env: dict | None = None) -> subprocess.CompletedProcess:
    return subprocess.run(["git", "-C", str(cwd), *argv], capture_output=True,
                          text=True, env=env, timeout=TIMEOUT)


def utc_now() -> str:
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def header_line(root: Node) -> tuple[str, list[str]]:
    """The header's date line as text, and its time elements' datetimes."""
    (line,) = root.find("p", "artifact-meta")
    return (" ".join(line.text().split()),
            [time.attrs.get("datetime", "") for time in line.find("time")])


class PageDatesWitness(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.tmp = Path(tmp.name).resolve()
        self.env = dict(os.environ, PYTHONPATH=str(SRC))

    def lotuspod(self, *argv: str, env: dict | None = None) -> subprocess.CompletedProcess:
        done = subprocess.run(
            [sys.executable, "-m", "lotuspod", *argv], cwd=str(self.tmp),
            env=env or self.env, capture_output=True, text=True, timeout=TIMEOUT)
        self.assertEqual(done.returncode, 0, done.stderr)
        return done

    def repository(self, name: str) -> Path:
        out = self.tmp / name
        done = git(self.tmp, "init", "-q", "-b", "main", str(out))
        self.assertEqual(done.returncode, 0, done.stderr)
        for key, value in (("user.name", "Witness"),
                           ("user.email", "witness@example.com"),
                           ("commit.gpgsign", "false")):
            git(out, "config", key, value)
        return out

    def page(self, out: Path, name: str) -> Node:
        return parse((out / f"{name}.html").read_text(encoding="utf-8"))

    def manifest(self, out: Path) -> dict:
        self.lotuspod("manifest", "--out-dir", str(out))
        data = json.loads((out / "manifest.json").read_text(encoding="utf-8"))
        return {entry["file"]: entry for entry in data["artifacts"]}

    def test_a_republished_page_keeps_its_created_date_and_shows_its_update(self):
        out = self.repository("artifacts")
        source = self.tmp / "pond-plan.md"
        source.write_text(FIRST, encoding="utf-8")
        self.lotuspod("publish", str(source), "--local", "--date", "2026-09-01",
                      "--out-dir", str(out))
        first = meta(self.page(out, "pond-plan"), "lotuspod:updated")

        source.write_text(SECOND, encoding="utf-8")
        before = utc_now()
        self.lotuspod("publish", str(source), "--local", "--out-dir", str(out))
        after = utc_now()

        root = self.page(out, "pond-plan")
        self.assertIn("The pump was replaced", root.text())
        self.assertEqual(root.find("time")[0].attrs.get("datetime"), "2026-09-01")
        updated = meta(root, "lotuspod:updated")
        self.assertRegex(updated, r"\A\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ\Z")
        self.assertTrue(first <= before <= updated <= after, (first, before, updated, after))
        text, times = header_line(root)
        self.assertEqual(text, f"Created 2026-09-01 · Updated {updated[:10]}")
        self.assertEqual(times, ["2026-09-01", updated])

        entry = self.manifest(out)["pond-plan.html"]
        self.assertEqual((entry["date"], entry["created"], entry["updated"]),
                         ("2026-09-01", "2026-09-01", updated))

    def test_a_page_published_once_today_shows_only_its_created_date(self):
        out = self.tmp / "plain"
        source = self.tmp / "pond-plan.md"
        source.write_text(FIRST, encoding="utf-8")
        self.lotuspod("publish", str(source), "--local", "--out-dir", str(out))

        root = self.page(out, "pond-plan")
        updated = meta(root, "lotuspod:updated")
        today = updated[:10]
        self.assertEqual(today, utc_now()[:10])
        text, times = header_line(root)
        self.assertEqual(text, f"Created {today}")
        self.assertEqual(times, [today])

    def render_twice(self, out: Path) -> None:
        """Render one page on 2026-09-01, then again changed on 2026-09-20,
        committing each where out is a repository's top; no stamp either time."""
        for day, body in (("2026-09-01", "<p>First.</p>"), ("2026-09-20", "<p>Second.</p>")):
            moment = f"{day}T10:00:00+00:00"
            env = dict(self.env, GIT_COMMITTER_DATE=moment, GIT_AUTHOR_DATE=moment)
            self.lotuspod("render", "--name", "notes", "--title", "Notes",
                          "--date", "2026-09-01", "--body", body,
                          "--out-dir", str(out), env=env)
        self.assertEqual(meta(self.page(out, "notes"), "lotuspod:updated"), "")

    def test_an_unstamped_page_in_a_repository_takes_its_newest_commit(self):
        out = self.repository("artifacts")
        self.render_twice(out)
        log = git(out, "log", "--format=%cI", "--", "notes.html")
        self.assertEqual(log.stdout.split(),
                         ["2026-09-20T10:00:00+00:00", "2026-09-01T10:00:00+00:00"])

        entry = self.manifest(out)["notes.html"]
        self.assertEqual(entry["created"], "2026-09-01")
        self.assertTrue(entry["updated"].startswith("2026-09-20"), entry["updated"])

    def test_an_unstamped_page_outside_a_repository_was_updated_when_created(self):
        out = self.tmp / "plain"
        self.render_twice(out)
        self.assertNotEqual(git(out, "rev-parse", "--show-toplevel").returncode, 0)

        entry = self.manifest(out)["notes.html"]
        self.assertEqual(entry["created"], "2026-09-01")
        self.assertEqual(entry["updated"], entry["created"])


if __name__ == "__main__":
    unittest.main()
