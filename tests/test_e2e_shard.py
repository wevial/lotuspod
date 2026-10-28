"""Test suite for `ci/e2e_shard.py`, which picks the spec files each `e2e`
shard runs.

Each test runs the script as a real subprocess, as the browser checks step
does: on this checkout's `e2e/checks` and `e2e/spec_times.json`, every spec
lands in exactly one of the four shards, nothing else is printed, no printed
path, as the regex Playwright makes of it, picks another spec, and the
slowest shard's recorded total is at most 15% above the mean. On a scratch
directory, a spec the times file does not record counts as the median of the
recorded times, and a shard that holds no spec prints nothing and exits 0.

Run from the repo root:

    python -m unittest tests.test_e2e_shard -v
"""

from __future__ import annotations

import json
import re
import statistics
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SCRIPT = REPO_ROOT / "ci" / "e2e_shard.py"
RUNNER = REPO_ROOT / "ci" / "run_modules.py"
CHECKS = REPO_ROOT / "e2e" / "checks"
TIMES = REPO_ROOT / "e2e" / "spec_times.json"
SHARDS = 4
# How far above the mean of the four the slowest shard's total may be.
SLACK = 1.15


def shard_lines(index: int, count: int, *extra: str) -> list[str]:
    done = subprocess.run(
        [sys.executable, str(SCRIPT), "--shard", f"{index}/{count}", *extra],
        cwd=REPO_ROOT, capture_output=True, text=True, timeout=60,
    )
    if done.returncode != 0:
        raise AssertionError(f"e2e_shard.py exited {done.returncode}: {done.stderr}")
    return done.stdout.splitlines()


def spec_files() -> list[str]:
    return sorted(path.relative_to(REPO_ROOT).as_posix() for path in CHECKS.rglob("*.spec.ts"))


def recorded() -> dict[str, float]:
    return {key: float(value) for key, value in json.loads(TIMES.read_text("utf-8")).items()}


def unchanged_rule(modules: list[str], times: dict[str, float], index: int,
                   count: int) -> list[str]:
    """`ci/run_modules.py`'s shard and run order as it read before the split
    moved into `ci/shard_split.py`, kept here as the reference."""
    fallback = statistics.median(times.values()) if times else 1.0
    weight = {rel: max(times.get(rel, fallback), 0.01) for rel in modules}
    order = sorted(modules, key=lambda rel: (-weight[rel], rel))
    totals = [0.0] * count
    shards: list[list[str]] = [[] for _ in range(count)]
    for rel in order:
        at = min(range(count), key=lambda i: totals[i])
        shards[at].append(rel)
        totals[at] += weight[rel]
    return sorted(shards[index - 1], key=lambda rel: (-weight[rel], rel))


class CheckedInShardsTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.shards = [shard_lines(index, SHARDS) for index in range(1, SHARDS + 1)]

    def test_every_spec_lands_in_exactly_one_shard_and_nothing_else_is_printed(self) -> None:
        printed = [line for lines in self.shards for line in lines]
        self.assertEqual(sorted(printed), spec_files())
        self.assertEqual(len(printed), len(set(printed)))
        for lines in self.shards:
            self.assertTrue(lines)

    def test_the_times_file_records_specs_under_e2e_checks(self) -> None:
        times = recorded()
        self.assertTrue(times)
        under = {path.removeprefix("e2e/checks/") for path in spec_files()}
        self.assertLessEqual(set(times), under)
        for seconds in times.values():
            self.assertGreater(seconds, 0)

    def test_the_slowest_shard_is_at_most_15_percent_above_the_mean(self) -> None:
        times = recorded()
        fallback = statistics.median(times.values())
        totals = [
            sum(times.get(line.removeprefix("e2e/checks/"), fallback) for line in lines)
            for lines in self.shards
        ]
        mean = sum(totals) / len(totals)
        self.assertLessEqual(max(totals), SLACK * mean, totals)

    def test_no_printed_path_picks_another_spec_as_a_playwright_filter(self) -> None:
        # Playwright reads each file argument as a case-insensitive regex
        # searched in the spec's absolute path.
        specs = [str(REPO_ROOT / rel) for rel in spec_files()]
        for line in (line for lines in self.shards for line in lines):
            with self.subTest(line=line):
                hits = [spec for spec in specs if re.search(line, spec, re.IGNORECASE)]
                self.assertEqual(hits, [str(REPO_ROOT / line)])

    def test_no_printed_path_holds_whitespace(self) -> None:
        # The browser checks step splits the printed list on whitespace.
        for line in (line for lines in self.shards for line in lines):
            with self.subTest(line=line):
                self.assertNotRegex(line, r"\s")


class ScratchShardsTestCase(unittest.TestCase):
    def setUp(self) -> None:
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        self.checks = self.root / "checks"
        self.times = self.root / "spec_times.json"

    def write(self, specs: list[str], times: dict[str, float]) -> None:
        for rel in specs:
            path = self.checks / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("", encoding="utf-8")
        (self.checks / "helpers.ts").write_text("", encoding="utf-8")
        self.times.write_text(json.dumps(times), encoding="utf-8")

    def shard(self, index: int, count: int) -> list[str]:
        lines = shard_lines(index, count, "--checks", str(self.checks), "--times", str(self.times))
        prefix = f"{self.checks.resolve().as_posix()}/"
        for line in lines:
            self.assertTrue(line.startswith(prefix), line)
        return [line.removeprefix(prefix) for line in lines]

    def test_an_unrecorded_spec_counts_as_the_median(self) -> None:
        # The median is 4; the mean (5.2) or 1 second would split differently.
        times = {"a.spec.ts": 10, "b.spec.ts": 8, "c.spec.ts": 1, "d.spec.ts": 4, "e.spec.ts": 3}
        self.write([*times, "features/x/new.spec.ts"], times)
        first, second = self.shard(1, 2), self.shard(2, 2)
        self.assertEqual(first, ["a.spec.ts", "features/x/new.spec.ts", "c.spec.ts"])
        self.assertEqual(second, ["b.spec.ts", "d.spec.ts", "e.spec.ts"])

    def test_a_shard_that_holds_no_spec_prints_nothing_and_exits_0(self) -> None:
        self.write(["only.spec.ts"], {"only.spec.ts": 5})
        self.assertEqual(self.shard(1, 2), ["only.spec.ts"])
        self.assertEqual(self.shard(2, 2), [])

    def test_no_times_file_still_puts_every_spec_in_one_shard(self) -> None:
        specs = [f"s{n}.spec.ts" for n in range(7)]
        self.write(specs, {})
        self.times.unlink()
        printed = [line for index in (1, 2, 3) for line in self.shard(index, 3)]
        self.assertEqual(sorted(printed), specs)


class RunModulesShardsTestCase(unittest.TestCase):
    def test_run_modules_lists_the_same_modules_as_before(self) -> None:
        tests = REPO_ROOT / "tests"
        modules = sorted(
            path.relative_to(tests).as_posix()
            for path in tests.rglob("test_*.py")
            if path.is_file() and "__pycache__" not in path.parts
        )
        times = {
            key: float(value)
            for key, value in json.loads((tests / "module_times.json").read_text("utf-8")).items()
        }
        for command in ([str(RUNNER)], ["-m", "ci.run_modules"]):
            for index in (1, 2):
                with self.subTest(command=command, shard=f"{index}/2"):
                    done = subprocess.run(
                        [sys.executable, *command, "--list", "--shard", f"{index}/2"],
                        cwd=REPO_ROOT, capture_output=True, text=True, timeout=60,
                    )
                    self.assertEqual(done.returncode, 0, done.stderr)
                    self.assertEqual(done.stdout.splitlines(),
                                     unchanged_rule(modules, times, index, 2))


if __name__ == "__main__":
    unittest.main()
