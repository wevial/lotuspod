"""Test suite for tests/history.py, against temporary repositories.

A pinned commit in HEAD's history reads; one on a side branch, whose object
is in the pack but not in HEAD's history, fails the test naming it; a shallow
clone skips, saying so.

Run from the repo root:

    python -m unittest tests.test_history -v
"""

from __future__ import annotations

import os
import subprocess
import tempfile
import unittest
from pathlib import Path

from tests import history

GIT_ENV = {
    **os.environ,
    "GIT_AUTHOR_NAME": "Test", "GIT_AUTHOR_EMAIL": "test@example.com",
    "GIT_COMMITTER_NAME": "Test", "GIT_COMMITTER_EMAIL": "test@example.com",
    "GIT_CONFIG_NOSYSTEM": "1", "GIT_CONFIG_GLOBAL": os.devnull,
}


def git(repo: Path, *args: str) -> str:
    proc = subprocess.run(["git", *args], cwd=repo, env=GIT_ENV, check=True,
                          capture_output=True, text=True, encoding="utf-8")
    return proc.stdout.strip()


def commit(repo: Path, text: str) -> str:
    (repo / "file.txt").write_text(text, encoding="utf-8")
    git(repo, "add", "file.txt")
    git(repo, "commit", "-q", "-m", text)
    return git(repo, "rev-parse", "HEAD")


class ShowTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.repo = self.root / "repo"
        self.repo.mkdir()
        git(self.repo, "init", "-q", "-b", "main")
        self.first = commit(self.repo, "first\n")
        git(self.repo, "checkout", "-q", "-b", "side")
        self.orphan = commit(self.repo, "side\n")
        git(self.repo, "checkout", "-q", "main")
        commit(self.repo, "second\n")
        git(self.repo, "gc", "-q")

    def test_a_commit_in_heads_history_reads(self):
        self.assertEqual(history.show(self.first, "file.txt", repo=self.repo), "first\n")

    def test_a_commit_outside_heads_history_fails_naming_it(self):
        # The side commit's object is in the pack, and git show reads it.
        self.assertEqual(git(self.repo, "show", f"{self.orphan}:file.txt"), "side")
        with self.assertRaises(AssertionError) as caught:
            history.show(self.orphan, "file.txt", repo=self.repo)
        self.assertIn(self.orphan, str(caught.exception))
        self.assertIn("not an ancestor of HEAD", str(caught.exception))

    def test_an_unknown_commit_fails_naming_it(self):
        with self.assertRaises(AssertionError) as caught:
            history.show("0123456", "file.txt", repo=self.repo)
        self.assertIn("0123456", str(caught.exception))

    def test_a_missing_path_fails(self):
        with self.assertRaises(AssertionError) as caught:
            history.show(self.first, "absent.txt", repo=self.repo)
        self.assertIn(f"{self.first}:absent.txt", str(caught.exception))

    def test_a_shallow_clone_skips_saying_so(self):
        clone = self.root / "clone"
        git(self.root, "clone", "-q", "--depth", "1", self.repo.as_uri(), str(clone))
        self.assertEqual(git(clone, "rev-parse", "--is-shallow-repository"), "true")
        with self.assertRaises(unittest.SkipTest) as caught:
            history.show(self.first, "file.txt", repo=clone)
        self.assertIn("shallow", str(caught.exception))


if __name__ == "__main__":
    unittest.main()
