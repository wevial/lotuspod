"""Test suite for `ci/e2e_scope.py`, which skips the `e2e` shards on a docs-only diff.

Each test builds a scratch repository with real `git`, commits a change and
runs the script on it from the repository's root, as the `scope` job does.

Run from the repo root:

    python -m unittest tests.test_e2e_scope -v
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SCOPE = REPO_ROOT / "ci" / "e2e_scope.py"

BASE_FILES = {
    "README.md": "# lotuspod\n",
    "CHANGELOG.md": "# Changelog\n",
    "LICENSE": "MIT\n",
    "docs/development.md": "# Development\n",
    "deploy/README.md": "# Deploy\n",
    "src/lotuspod/cli.py": "def main():\n    pass\n",
    "tests/fixtures/markdown/code.md": "# Code\n",
    ".github/workflows/e2e.yml": "name: e2e\n",
}


class E2eScopeTestCase(unittest.TestCase):
    def setUp(self) -> None:
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.repo = Path(scratch.name)
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith("GIT_")}
        self.env.update({
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_AUTHOR_NAME": "Tester",
            "GIT_AUTHOR_EMAIL": "tester" + "@" + "example.com",
            "GIT_COMMITTER_NAME": "Tester",
            "GIT_COMMITTER_EMAIL": "tester" + "@" + "example.com",
        })
        self.git("init", "-q", "-b", "main")
        self.write(BASE_FILES)
        self.commit()

    def git(self, *args: str) -> str:
        proc = subprocess.run(["git", *args], cwd=self.repo, env=self.env,
                              capture_output=True, text=True, check=True)
        return proc.stdout.strip()

    def write(self, files: dict[str, str]) -> None:
        for name, content in files.items():
            path = self.repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(content, encoding="utf-8")

    def commit(self) -> None:
        self.git("add", "-A")
        self.git("commit", "-q", "--allow-empty", "-m", "change")

    def change(self, *names: str) -> None:
        """Append a line to each of `names` and commit."""
        for name in names:
            with open(self.repo / name, "a", encoding="utf-8") as handle:
                handle.write("more\n")
        self.commit()

    def scope(self, base: str | None = None) -> subprocess.CompletedProcess:
        """Run the script on the last commit, as the `scope` job does."""
        base = base or self.git("rev-parse", "HEAD^")
        return subprocess.run([sys.executable, str(SCOPE), base, "HEAD"], cwd=self.repo,
                              env=self.env, capture_output=True, text=True)

    def assertRuns(self, proc: subprocess.CompletedProcess, blamed: str | None) -> None:
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(proc.stdout, "run=true\n")
        if blamed is not None:
            self.assertIn(blamed, proc.stderr)


class DocsOnlyTests(E2eScopeTestCase):
    def test_a_docs_only_change_skips_the_checks(self):
        self.change("docs/development.md", "README.md", "CHANGELOG.md",
                    "deploy/README.md", "LICENSE")
        proc = self.scope()
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertEqual(proc.stdout, "run=false\n")


class RunTests(E2eScopeTestCase):
    def test_a_source_change_beside_docs_runs_the_checks(self):
        self.change("docs/development.md", "src/lotuspod/cli.py")
        self.assertRuns(self.scope(), "src/lotuspod/cli.py")

    def test_markdown_under_tests_runs_the_checks(self):
        self.change("tests/fixtures/markdown/code.md")
        self.assertRuns(self.scope(), "tests/fixtures/markdown/code.md")

    def test_a_workflow_change_runs_the_checks(self):
        self.change(".github/workflows/e2e.yml")
        self.assertRuns(self.scope(), ".github/workflows/e2e.yml")

    def test_a_file_moved_into_docs_runs_the_checks(self):
        self.git("mv", "src/lotuspod/cli.py", "docs/cli.py")
        self.commit()
        # Rename detection alone would name only the new, docs-only path.
        self.assertEqual(self.git("diff", "--name-only", "-M", "HEAD^", "HEAD"), "docs/cli.py")
        self.assertRuns(self.scope(), "src/lotuspod/cli.py")

    def test_an_empty_diff_runs_the_checks(self):
        self.commit()
        self.assertRuns(self.scope(), None)


class FailureTests(E2eScopeTestCase):
    def test_an_unknown_base_fails(self):
        proc = self.scope("0" * 40)
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout, "")


if __name__ == "__main__":
    unittest.main()
