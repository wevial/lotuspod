"""Test suite for `ci/leak_guard.py`, the diff scanner in the `unit` check.

Each test builds a scratch repository with real `git`, commits a change and
runs the guard on it as CI does. Every value that breaks a rule is put
together at run time, so this file holds none: the guard scans its own pull
request, and `tests/test_public_ready.py` scans every tracked file.

Run from the repo root:

    python -m unittest tests.test_leak_guard -v
"""

from __future__ import annotations

import os
import secrets
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
GUARD = REPO_ROOT / "ci" / "leak_guard.py"

BASE_LINES = ["one", "two", "three", "four", "five"]

# One value per generic rule, by rule id.
VIOLATIONS = {
    "email": "alice" + "@" + "acme-mail.test",
    "home-macos": "/" + "Users/alice/projects",
    "home-linux": "/" + "home/alice/projects",
    "tailnet-ip": "100." + "101.7.42",
    "tailnet-name": "build-box.tail" + "c0ffee" + ".ts" + ".net",
    "private-key": "-----BEGIN " + "OPENSSH PRIVATE" + " KEY-----",
}

ALLOWED = [
    "reader" + "@" + "example.com",
    "someone" + "@" + "example.org",
    "12345+octocat" + "@" + "users.noreply.github.com",
    "/" + "home/" + "writer/lotuspod",
    "/" + "home/<user>/lotuspod/lotuspod.sock",
    "~/lotuspod",
    "100.64.0.0",
    "100.64.0.1",
]


class LeakGuardTestCase(unittest.TestCase):
    def setUp(self) -> None:
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.repo = Path(scratch.name)
        self.env = {key: value for key, value in os.environ.items()
                    if not key.startswith("GIT_") and key != "LEAK_PATTERNS"}
        self.env.update({
            "GIT_CONFIG_GLOBAL": os.devnull,
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_AUTHOR_NAME": "Tester",
            "GIT_AUTHOR_EMAIL": "tester" + "@" + "example.com",
            "GIT_COMMITTER_NAME": "Tester",
            "GIT_COMMITTER_EMAIL": "tester" + "@" + "example.com",
        })
        self.git("init", "-q", "-b", "main")
        self.commit({"notes.txt": BASE_LINES})

    def git(self, *args: str) -> str:
        proc = subprocess.run(["git", *args], cwd=self.repo, env=self.env,
                              capture_output=True, text=True, check=True)
        return proc.stdout.strip()

    def commit(self, files: dict[str, list[str] | bytes]) -> str:
        """Write `files` (lines, or raw bytes), commit them and return the new SHA."""
        for name, content in files.items():
            path = self.repo / name
            path.parent.mkdir(parents=True, exist_ok=True)
            if isinstance(content, bytes):
                path.write_bytes(content)
            else:
                path.write_text("".join(f"{line}\n" for line in content), encoding="utf-8")
        self.git("add", "-A")
        self.git("commit", "-q", "--allow-empty", "-m", "change")
        return self.git("rev-parse", "HEAD")

    def guard(self, patterns: str | None = None) -> subprocess.CompletedProcess:
        """Run the guard on the last commit, as CI runs it."""
        env = dict(self.env)
        if patterns is not None:
            env["LEAK_PATTERNS"] = patterns
        base = self.git("rev-parse", "HEAD^")
        head = self.git("rev-parse", "HEAD")
        self.range = f"{base}..{head}"
        return subprocess.run([sys.executable, str(GUARD), base, head], cwd=self.repo,
                              env=env, capture_output=True, text=True)

    def insert(self, line: str) -> list[str]:
        """The base file with `line` as its third line and a clean line appended."""
        return BASE_LINES[:2] + [line] + BASE_LINES[2:] + ["six"]


class CleanDiffTests(LeakGuardTestCase):
    def test_a_clean_commit_passes_and_names_the_range(self):
        self.commit({"notes.txt": self.insert("nothing personal here"),
                     "docs/new.md": ["# New", "", "A plain page."]})
        proc = self.guard()
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        summary = proc.stdout.strip().splitlines()[-1]
        self.assertIn(self.range, summary)
        self.assertIn("0 private patterns", summary)
        self.assertIn("0 hits", summary)
        self.assertEqual(proc.stdout.strip().splitlines(), [summary])

    def test_allowed_values_pass(self):
        self.commit({"notes.txt": BASE_LINES + ALLOWED,
                     "one-line.txt": [" ".join(ALLOWED)]})
        proc = self.guard()
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_a_deleted_violation_passes(self):
        self.commit({"notes.txt": self.insert(VIOLATIONS["home-linux"])})
        self.commit({"notes.txt": BASE_LINES})
        proc = self.guard()
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)

    def test_a_binary_file_is_skipped(self):
        self.commit({"blob.bin": b"\0\1\2" + VIOLATIONS["email"].encode() + b"\0"})
        proc = self.guard()
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)


class GenericRuleTests(LeakGuardTestCase):
    def test_each_generic_rule_fails_with_its_id_and_line(self):
        for rule, value in VIOLATIONS.items():
            with self.subTest(rule=rule):
                self.commit({"notes.txt": BASE_LINES})
                line = f"see {value} for details"
                self.commit({"notes.txt": self.insert(line)})
                proc = self.guard()
                self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
                lines = proc.stdout.strip().splitlines()
                self.assertEqual(lines[:-1], [f"notes.txt:3: {rule}"])
                self.assertIn(self.range, lines[-1])
                self.assertIn("1 hit", lines[-1])
                for output in (proc.stdout, proc.stderr):
                    self.assertNotIn(value, output)
                    self.assertNotIn(line, output)
                    self.assertNotIn("alice", output)

    def test_a_hit_in_a_new_file_names_its_line(self):
        self.commit({"sub/dir/new.txt": ["a", "b", "c", VIOLATIONS["tailnet-ip"]]})
        proc = self.guard()
        self.assertEqual(proc.returncode, 1)
        self.assertIn("sub/dir/new.txt:4: tailnet-ip\n", proc.stdout)


class PrivatePatternTests(LeakGuardTestCase):
    def test_a_private_pattern_matches_in_any_case_and_is_never_printed(self):
        first = "first-" + secrets.token_hex(6)
        second = "second-" + secrets.token_hex(6)
        line = f"host is {second.upper()} today"
        self.commit({"notes.txt": self.insert(line)})
        proc = self.guard(patterns=f"  {first}  \n\n{second}\n   \n")
        self.assertEqual(proc.returncode, 1, proc.stdout + proc.stderr)
        lines = proc.stdout.strip().splitlines()
        self.assertEqual(lines[:-1], ["notes.txt:3: private-2"])
        self.assertIn("2 private patterns", lines[-1])
        for output in (proc.stdout, proc.stderr):
            for text in (first, second, second.upper(), line):
                self.assertNotIn(text.lower(), output.lower())

    def test_an_empty_variable_loads_no_patterns(self):
        self.commit({"notes.txt": self.insert("plain")})
        proc = self.guard(patterns="\n  \n")
        self.assertEqual(proc.returncode, 0)
        self.assertIn("0 private patterns", proc.stdout)


if __name__ == "__main__":
    unittest.main()
