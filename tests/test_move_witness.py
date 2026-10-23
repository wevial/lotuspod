"""Test suite for `ci/move_witness.py`'s reading of discovered test names.

The Playwright tests list a scratch tree's e2e configs through a stand-in
for Playwright that answers `--list` and its JSON report as Playwright does,
and compare the titles with a merge base's files. The unittest tests run
discovery over a scratch tree's tests/.

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

    def test_a_new_spec_sharing_a_file_name_with_one_in_another_test_dir_is_added(self):
        after = self.titles()
        before = {key: count for key, count in after.items()
                  if key[0] == "e2e/checks/theme.spec.ts"}
        lines, allowed = move_witness.multiset_differences(
            "playwright", before, after, {"e2e/checks/theme.spec.ts"})
        self.assertEqual(lines, [])
        self.assertEqual(allowed, ["playwright: 'demo.config.ts [chromium] › demo theme' "
                                   "is added by e2e/demo/theme.spec.ts"])


class UnittestNamesTest(unittest.TestCase):
    def setUp(self):
        scratch = tempfile.TemporaryDirectory()
        self.addCleanup(scratch.cleanup)
        self.root = Path(scratch.name)
        (self.root / "tests").mkdir()
        (self.root / "tests" / "__init__.py").write_text("")
        (self.root / "tests" / "test_fine.py").write_text(
            "import unittest\n\nclass Fine(unittest.TestCase):\n"
            "    def test_it(self):\n        pass\n")
        self.tree = move_witness.Tree("working tree", self.root, self.root / "missing.ini")

    def test_each_discovered_test_is_named_with_its_file(self):
        self.assertEqual(self.tree.unittest_names(),
                         {("tests/test_fine.py", "Fine.test_it"): 1})

    def test_a_test_module_that_fails_to_import_fails_discovery(self):
        (self.root / "tests" / "test_broken.py").write_text(
            'raise RuntimeError("discovery failed")\n')
        with self.assertRaisesRegex(RuntimeError, "unittest discovery failed.*test_broken"):
            self.tree.unittest_names()


if __name__ == "__main__":
    unittest.main()
