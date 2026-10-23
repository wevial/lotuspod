"""Test suite for `ci/move_witness.py`'s reading of Playwright's test names.

Each test lists a scratch tree's e2e configs through a stand-in for
Playwright that answers `--list` and its JSON report as Playwright does, and
compares the titles with a merge base's files.

Run from the repo root:

    python -m unittest tests.test_move_witness -v
"""

from __future__ import annotations

import json
import subprocess
import tempfile
import unittest
from pathlib import Path

from ci import move_witness


class SpecPathsTest(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        (self.root / "src" / "lotuspod" / "_theme").mkdir(parents=True)
        # Two configs whose testDirs each hold a spec named theme.spec.ts.
        self.test_dirs = {"checks.config.ts": "checks", "demo.config.ts": "demo"}
        for config in self.test_dirs:
            (self.root / "e2e" / config).parent.mkdir(exist_ok=True)
            (self.root / "e2e" / config).write_text("export default {};\n")

    def titles(self):
        tree = move_witness.Tree("working tree", self.root, self.root / "missing.ini")

        def run(*argv, cwd=None):
            test_dir = self.test_dirs[Path(argv[argv.index("--config") + 1]).name]
            if "--reporter=json" in argv:
                report = {"config": {"rootDir": str(self.root / "e2e" / test_dir)}}
                out = json.dumps(report)
            else:
                out = f"Listing tests:\n  [chromium] › theme.spec.ts:3:1 › {test_dir} theme\n"
            return subprocess.CompletedProcess(argv, 0, out, "")

        tree.run = run
        return tree.playwright_titles(Path("playwright"), b"")

    def test_each_spec_path_is_taken_from_the_root_through_its_test_dir(self):
        self.assertEqual(sorted(path for path, _ in self.titles()),
                         ["e2e/checks/theme.spec.ts", "e2e/demo/theme.spec.ts"])

    def test_a_new_spec_sharing_a_file_name_with_one_in_another_test_dir_is_added(self):
        after = self.titles()
        before = {key: count for key, count in after.items()
                  if key[0] == "e2e/checks/theme.spec.ts"}
        lines, allowed = move_witness.multiset_differences(
            "playwright", before, after, {"e2e/checks/theme.spec.ts"})
        self.assertEqual(lines, [])
        self.assertEqual(allowed, ["playwright: 'demo.config.ts [chromium] › demo theme' "
                                   "is added by e2e/demo/theme.spec.ts"])


if __name__ == "__main__":
    unittest.main()
