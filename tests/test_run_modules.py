"""Test suite for `ci/run_modules.py`, the module-by-module unit runner.

Each test writes a scratch tests directory and runs the runner on it with
`--dir` as a real subprocess: a failing module fails the run and is named on
the summary line, a module in a subpackage runs, a module with no test, a
directory with no module, a module over the ceiling and one past the timeout
each fail the run, and `--list --shard I/N` puts every module in exactly one
non-empty shard with and without a times file.

Run from the repo root:

    python -m unittest tests.test_run_modules -v
"""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
RUNNER = REPO_ROOT / "ci" / "run_modules.py"

PASSING = """
import unittest

class Passing(unittest.TestCase):
    def test_passes(self):
        self.assertTrue(True)
"""
FAILING = """
import unittest

class Failing(unittest.TestCase):
    def test_fails(self):
        self.assertEqual(1, 2)
"""
EMPTY = """
import unittest

class Empty(unittest.TestCase):
    pass
"""
SLEEPING = """
import time
import unittest

class Sleeping(unittest.TestCase):
    def test_sleeps(self):
        time.sleep({seconds})
"""


class RunModulesTestCase(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.dir = Path(tmp.name)

    def write(self, rel: str, source: str) -> None:
        path = self.dir / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        for parent in path.relative_to(self.dir).parents:
            if parent != Path("."):
                (self.dir / parent / "__init__.py").touch()
        path.write_text(textwrap.dedent(source), encoding="utf-8")

    def run_runner(self, *args: str) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(RUNNER), "--dir", str(self.dir), *args],
            capture_output=True, text=True, timeout=120, cwd=REPO_ROOT, check=False,
        )

    def summary(self, proc: subprocess.CompletedProcess) -> str:
        lines = [line for line in proc.stdout.splitlines() if line.startswith("run_modules:")]
        self.assertEqual(len(lines), 1, proc.stdout + proc.stderr)
        return lines[0]


class RunTests(RunModulesTestCase):
    def test_a_failing_module_fails_the_run_and_is_named_alone(self) -> None:
        self.write("test_good.py", PASSING)
        self.write("test_bad.py", FAILING)
        self.write("sub/test_deep.py", PASSING)
        proc = self.run_runner("--jobs", "2")
        self.assertNotEqual(proc.returncode, 0, proc.stdout)
        summary = self.summary(proc)
        self.assertIn("test_bad.py (failed)", summary)
        self.assertNotIn("test_good.py", summary)
        self.assertNotIn("sub/test_deep.py", summary)
        lines = proc.stdout.splitlines()
        self.assertTrue(any(line.endswith("  ok  sub/test_deep.py") for line in lines),
                        proc.stdout)
        self.assertTrue(any(line.endswith("  ok  test_good.py") for line in lines),
                        proc.stdout)
        self.assertIn("AssertionError: 1 != 2", proc.stdout)

    def test_a_module_with_no_test_fails_the_run(self) -> None:
        self.write("test_empty.py", EMPTY)
        proc = self.run_runner()
        self.assertNotEqual(proc.returncode, 0, proc.stdout)
        self.assertIn("test_empty.py (ran zero tests)", self.summary(proc))

    def test_a_directory_with_no_module_fails_the_run(self) -> None:
        self.write("helpers.py", PASSING)
        proc = self.run_runner()
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("no test_*.py module", proc.stderr)

    def test_a_pattern_matching_no_module_fails_the_run(self) -> None:
        self.write("test_good.py", PASSING)
        proc = self.run_runner("tests/test_missing.py")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("no module matches 'test_missing.py'", proc.stderr)

    def test_patterns_select_modules_with_or_without_the_tests_prefix(self) -> None:
        self.write("test_good.py", PASSING)
        self.write("test_bad.py", FAILING)
        self.write("sub/test_deep.py", PASSING)
        proc = self.run_runner("--list", "tests/test_good.py", "sub/*")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(sorted(proc.stdout.split()), ["sub/test_deep.py", "test_good.py"])

    def test_a_module_over_the_ceiling_fails_the_run(self) -> None:
        self.write("test_slow.py", SLEEPING.format(seconds=1.5))
        proc = self.run_runner("--max-module-sec", "0.5")
        self.assertNotEqual(proc.returncode, 0, proc.stdout)
        self.assertIn("test_slow.py (over the 0.5s ceiling)", self.summary(proc))

    def test_a_module_past_the_timeout_is_killed_and_fails_the_run(self) -> None:
        self.write("test_hung.py", SLEEPING.format(seconds=60))
        proc = self.run_runner("--module-timeout", "1")
        self.assertNotEqual(proc.returncode, 0, proc.stdout)
        self.assertIn("test_hung.py (timed out)", self.summary(proc))

    def test_record_writes_each_module_s_seconds(self) -> None:
        self.write("test_good.py", PASSING)
        self.write("sub/test_deep.py", PASSING)
        record = self.dir / "record.json"
        proc = self.run_runner("--record", str(record))
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        self.assertIn("no module failed", self.summary(proc))
        times = json.loads(record.read_text(encoding="utf-8"))
        self.assertEqual(sorted(times), ["sub/test_deep.py", "test_good.py"])
        self.assertTrue(all(isinstance(t, float) for t in times.values()))


class ShardTests(RunModulesTestCase):
    MODULES = ("test_a.py", "test_b.py", "test_c.py", "sub/test_d.py", "sub/test_e.py")

    def setUp(self) -> None:
        super().setUp()
        for rel in self.MODULES:
            self.write(rel, PASSING)

    def listed(self, *args: str) -> list:
        proc = self.run_runner("--list", *args)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return proc.stdout.split()

    def test_shards_split_every_module_once_with_and_without_a_times_file(self) -> None:
        for times in (None, {"test_a.py": 30.0, "test_b.py": 10.0, "sub/test_d.py": 5.0}):
            if times:
                (self.dir / "module_times.json").write_text(json.dumps(times), encoding="utf-8")
            every = self.listed()
            self.assertEqual(sorted(every), sorted(self.MODULES))
            for count in (2, 3):
                with self.subTest(times=times, count=count):
                    shards = [self.listed("--shard", f"{i}/{count}") for i in range(1, count + 1)]
                    self.assertTrue(all(shards), shards)
                    flat = [rel for shard in shards for rel in shard]
                    self.assertEqual(sorted(flat), sorted(every))

    def test_the_longest_module_runs_first_and_balances_the_shards(self) -> None:
        times = {"test_a.py": 30.0, "test_b.py": 20.0, "test_c.py": 10.0,
                 "sub/test_d.py": 9.0, "sub/test_e.py": 1.0}
        (self.dir / "module_times.json").write_text(json.dumps(times), encoding="utf-8")
        self.assertEqual(self.listed()[0], "test_a.py")
        # a to 1, b and c to 2, d to 1 on the 30-30 tie, e to 2.
        self.assertEqual(self.listed("--shard", "1/2"), ["test_a.py", "sub/test_d.py"])
        self.assertEqual(self.listed("--shard", "2/2"),
                         ["test_b.py", "test_c.py", "sub/test_e.py"])

    def test_a_shard_with_no_module_fails(self) -> None:
        proc = self.run_runner("--list", "--shard", "6/6")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("shard 6/6 holds no module", proc.stderr)


if __name__ == "__main__":
    unittest.main()
