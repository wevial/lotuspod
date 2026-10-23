"""Test suite for the file-size ratchet: no tracked file grows past its cap.

Every tracked .py, .ts, .tsx, .js and .css file (git ls-files) is measured
with one `wc -l`. A file under tests/ or e2e/, or named *.test.ts, is a test
file and may hold CEILING["test"] lines; every other is a source file and may
hold CEILING["source"]. A file whose first line is web/build.ts's marker
("// Built from ... by web/build.ts. Edit that file, not this one.") is built,
not written, and is not counted.

A file over its cap on main is pinned in PINNED at its count, and a pin only
goes down. The walk fails on:

- a pinned file past its pin;
- an unpinned file past its cap;
- a pinned file at or under its cap (a stale entry: drop it);
- a pin more than OVER lines above its file (lower the pin to the count).

Each failure line names the file, its count and its cap or pin.

Run from the repo root:

    python -m unittest tests.test_file_sizes -v
"""

from __future__ import annotations

import subprocess
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

PATTERNS = ("*.py", "*.ts", "*.tsx", "*.js", "*.css")
CEILING = {
    "source": 1000,
    "test": 1500,
}
# How far a pin may sit above its file before it must come down.
OVER = 150
PINNED = {
    "e2e/checks/live-page.spec.ts": 2849,
    "src/lotuspod/_theme/css/comments.css": 1773,
    "src/lotuspod/api.py": 1168,
    "src/lotuspod/cli.py": 3493,
    "src/lotuspod/db.py": 1562,
    "src/lotuspod/machine.py": 1144,
    "src/lotuspod/responder.py": 1029,
    "tests/test_agent_pull.py": 1688,
    "tests/test_api.py": 1552,
    "tests/test_manifest_v2.py": 2018,
}


def kind(path: str) -> str:
    if path.split("/", 1)[0] in ("tests", "e2e") or path.endswith(".test.ts"):
        return "test"
    return "source"


def is_built(root: Path, path: str) -> bool:
    with open(root / path, encoding="utf-8", errors="replace") as handle:
        first = handle.readline()
    return first.startswith("// Built from ") and " by web/build.ts." in first


def tracked(root: Path) -> list[str]:
    out = subprocess.run(["git", "ls-files", "-z", "--", *PATTERNS], cwd=root,
                         check=True, capture_output=True, text=True).stdout
    return sorted(path for path in out.split("\0") if path)


def measure(root: Path) -> dict[str, int]:
    """Line counts of the tracked files that are written, not built."""
    paths = [path for path in tracked(root) if not is_built(root, path)]
    if not paths:
        return {}
    out = subprocess.run(["wc", "-l", "--", *paths], cwd=root, check=True,
                         capture_output=True, text=True).stdout
    counts = {}
    for line in out.splitlines():
        count, name = line.strip().split(None, 1)
        if name in paths:
            counts[name] = int(count)
    return counts


def violations(root: Path, pinned: dict[str, int]) -> list[str]:
    """One line per broken rule, sorted by path."""
    counts = measure(root)
    found = []
    for path in sorted(set(counts) | set(pinned)):
        count = counts.get(path, 0)
        cap = CEILING[kind(path)]
        pin = pinned.get(path)
        if pin is None:
            if count > cap:
                found.append(f"{path}: {count} lines, past its cap of {cap}")
        elif count > pin:
            found.append(f"{path}: {count} lines, past its pin of {pin}")
        elif count <= cap:
            found.append(f"{path}: {count} lines, at or under its cap of {cap};"
                         f" its pin of {pin} is stale")
        elif pin - count > OVER:
            found.append(f"{path}: {count} lines, its pin of {pin} is more than"
                         f" {OVER} above it")
    return found


class RepositoryTest(unittest.TestCase):
    def test_no_file_breaks_the_ratchet(self):
        self.assertEqual(violations(REPO_ROOT, PINNED), [])

    def test_pins_are_the_files_over_their_cap(self):
        counts = measure(REPO_ROOT)
        over = {path: count for path, count in counts.items()
                if count > CEILING[kind(path)]}
        self.assertEqual(PINNED, over)

    def test_tables_are_sorted(self):
        self.assertEqual(list(PINNED), sorted(PINNED))


class WalkTest(unittest.TestCase):
    PINS = {"src/big.py": 1001, "tests/test_big.py": 1501}

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.git("init", "-q")
        self.write("src/big.py", 1001)
        self.write("src/style.css", 1000)
        self.write("tests/test_big.py", 1501)
        self.write("e2e/checks/big.spec.ts", 1500)
        self.write("web/src/big.test.ts", 1500)

    def git(self, *args: str) -> None:
        subprocess.run(["git", *args], cwd=self.root, check=True,
                       capture_output=True)

    def write(self, path: str, lines: int, first: str = "x") -> None:
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("".join([first + "\n"] + ["x\n"] * (lines - 1)),
                          encoding="utf-8")
        self.git("add", "--", path)

    def test_reports_the_files_past_their_cap(self):
        self.assertEqual(violations(self.root, {}), [
            "src/big.py: 1001 lines, past its cap of 1000",
            "tests/test_big.py: 1501 lines, past its cap of 1500",
        ])

    def test_reports_a_file_past_its_pin(self):
        self.write("src/big.py", 1002)
        self.assertEqual(violations(self.root, self.PINS),
                         ["src/big.py: 1002 lines, past its pin of 1001"])

    def test_reports_a_pin_far_above_its_file(self):
        pinned = {**self.PINS, "src/big.py": 1200}
        self.assertEqual(violations(self.root, pinned), [
            "src/big.py: 1001 lines, its pin of 1200 is more than 150 above it",
        ])

    def test_reports_a_stale_pin(self):
        self.write("src/big.py", 990)
        self.assertEqual(violations(self.root, self.PINS), [
            "src/big.py: 990 lines, at or under its cap of 1000;"
            " its pin of 1001 is stale",
        ])

    def test_skips_a_built_file(self):
        self.write("src/js/built.js", 1400, first="// Built from slices/x/built.ts"
                   " by web/build.ts. Edit that file, not this one.")
        self.write("src/js/written.js", 1400)
        self.assertEqual(violations(self.root, self.PINS),
                         ["src/js/written.js: 1400 lines, past its cap of 1000"])



if __name__ == "__main__":
    unittest.main()
