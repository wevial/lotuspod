"""Test suite for the islands-bundle ratchet: no built bundle grows past its pin.

Every slice's built islands bundle (src/lotuspod/features/*/ts/islands.js,
written by web/build.ts's islands step and committed) is read as it stands and
gzipped with gzip.compress(data, compresslevel=9, mtime=0), so the measured
size never drifts with the clock or gzip's default header. The suite runs
with neither Bun nor Node, so it reads the committed file and does not build.

Each bundle is pinned in PINNED at its gzipped size rounded up to the next
1,000 bytes, and a pin only goes down: a change that legitimately grows a
bundle raises its pin in the same commit, and a new slice's bundle is pinned
in the commit that adds it. The walk fails on:

- a bundle with no pin;
- a pinned bundle past its pin;
- a pin whose bundle is gone (a stale entry: drop it);
- a pin more than OVER bytes above its bundle (lower the pin).

Each failure line names the bundle, its gzipped size and its pin.

Run from the repo root:

    python -m unittest tests.test_bundle_size -v
"""

from __future__ import annotations

import gzip
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]

BUNDLES = "src/lotuspod/features/*/ts/islands.js"
# How far a pin may sit above its bundle before it must come down.
OVER = 1000
PINNED = {
    "src/lotuspod/features/comments/ts/islands.js": 58000,
    "src/lotuspod/features/index/ts/islands.js": 16000,
}


def gzipped(data: bytes) -> int:
    return len(gzip.compress(data, compresslevel=9, mtime=0))


def measure(root: Path) -> dict[str, int]:
    """Gzipped sizes of the islands bundles, keyed by repo-relative path."""
    return {path.relative_to(root).as_posix(): gzipped(path.read_bytes())
            for path in sorted(root.glob(BUNDLES))}


def violations(root: Path, pinned: dict[str, int]) -> list[str]:
    """One line per broken rule, sorted by path."""
    sizes = measure(root)
    found = []
    for path in sorted(set(sizes) | set(pinned)):
        size = sizes.get(path)
        pin = pinned.get(path)
        if pin is None:
            found.append(f"{path}: {size} bytes gzipped, with no pin")
        elif size is None:
            found.append(f"{path}: no such bundle; its pin of {pin} is stale")
        elif size > pin:
            found.append(f"{path}: {size} bytes gzipped, past its pin of {pin}")
        elif pin - size > OVER:
            found.append(f"{path}: {size} bytes gzipped, its pin of {pin} is"
                         f" more than {OVER} above it")
    return found


class RepositoryTest(unittest.TestCase):
    def test_no_bundle_breaks_the_ratchet(self):
        self.assertEqual(violations(REPO_ROOT, PINNED), [])

    def test_tables_are_sorted(self):
        self.assertEqual(list(PINNED), sorted(PINNED))


class WalkTest(unittest.TestCase):
    PATH = "src/lotuspod/features/demo/ts/islands.js"

    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        self.write(self.PATH, b"x")
        self.size = gzipped(b"x")

    def write(self, path: str, data: bytes) -> None:
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)

    def test_passes_a_pin_from_its_bundle_to_over_above_it(self):
        for pin in (self.size, self.size + OVER):
            with self.subTest(pin=pin):
                self.assertEqual(violations(self.root, {self.PATH: pin}), [])

    def test_reports_a_bundle_past_its_pin(self):
        pin = self.size - 1
        self.assertEqual(violations(self.root, {self.PATH: pin}), [
            f"{self.PATH}: {self.size} bytes gzipped, past its pin of {pin}",
        ])

    def test_reports_a_bundle_with_no_pin(self):
        other = "src/lotuspod/features/other/ts/islands.js"
        self.write(other, b"x")
        self.assertEqual(violations(self.root, {self.PATH: self.size}), [
            f"{other}: {gzipped(b'x')} bytes gzipped, with no pin",
        ])

    def test_reports_a_stale_pin(self):
        gone = "src/lotuspod/features/gone/ts/islands.js"
        self.assertEqual(
            violations(self.root, {gone: 5000, self.PATH: self.size}),
            [f"{gone}: no such bundle; its pin of 5000 is stale"])

    def test_reports_a_pin_far_above_its_bundle(self):
        pin = self.size + OVER + 1
        self.assertEqual(violations(self.root, {self.PATH: pin}), [
            f"{self.PATH}: {self.size} bytes gzipped, its pin of {pin} is"
            f" more than {OVER} above it",
        ])

    def test_skips_a_file_outside_the_glob(self):
        self.write("src/lotuspod/features/demo/ts/other.js", b"x")
        self.write("web/islands.js", b"x")
        self.assertEqual(violations(self.root, {self.PATH: self.size}), [])


if __name__ == "__main__":
    unittest.main()
