"""Test suite for the `unit` GitHub Actions workflow: the pull request check
runs the whole unit suite.

Reads `.github/workflows/unit.yml` as text, since the package has no YAML
parser, and pins the triggers, the job name, the Python version, the install
step and the test command.

Run from the repo root:

    python -m unittest tests.test_ci_workflow -v
"""

from __future__ import annotations

import re
import unittest
from pathlib import Path

WORKFLOW = Path(__file__).resolve().parent.parent / ".github" / "workflows" / "unit.yml"


class UnitWorkflowTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue(WORKFLOW.is_file(), f"{WORKFLOW} does not exist")
        self.text = WORKFLOW.read_text(encoding="utf-8")

    def block(self, key: str, indent: str = "") -> str:
        """The lines nested under `key:` at the given indent."""
        match = re.search(
            rf"^{indent}{re.escape(key)}:[ \t]*\n((?:{indent}[ \t]+.*\n|[ \t]*\n)*)",
            self.text,
            re.MULTILINE,
        )
        self.assertIsNotNone(match, f"no `{key}:` block in the workflow")
        return match.group(1)

    def test_workflow_is_named_unit(self) -> None:
        self.assertRegex(self.text, r"(?m)^name: unit$")

    def test_triggers_on_pull_request(self) -> None:
        self.assertRegex(self.block("on"), r"(?m)^  pull_request:\s*$")

    def test_triggers_on_push_to_main_only(self) -> None:
        push = self.block("push", indent="  ")
        branches = re.findall(r"(?m)^\s+- (\S+)\s*$", push)
        self.assertEqual(branches, ["main"])

    def test_has_one_job_named_unit(self) -> None:
        jobs = re.findall(r"(?m)^  (\S+):\s*$", self.block("jobs"))
        self.assertEqual(jobs, ["unit"])
        self.assertRegex(self.block("unit", indent="  "), r"(?m)^    name: unit$")

    def test_runs_on_ubuntu_latest(self) -> None:
        self.assertRegex(self.text, r"(?m)^    runs-on: ubuntu-latest$")

    def test_checks_out_and_sets_up_python_3_11(self) -> None:
        self.assertIn("uses: actions/checkout@v4", self.text)
        self.assertIn("uses: actions/setup-python@v5", self.text)
        self.assertRegex(self.text, r"""(?m)^\s+python-version: ["']3\.11["']$""")

    def test_installs_the_package_then_runs_the_suite(self) -> None:
        runs = re.findall(r"(?m)^\s+- run: (.+)$", self.text)
        self.assertEqual(
            runs, ["pip install -e .", "python -m unittest discover -s tests"]
        )

    def test_has_no_node_or_browser_step(self) -> None:
        for word in ("setup-node", "npm", "npx", "playwright"):
            self.assertNotIn(word, self.text.lower())


if __name__ == "__main__":
    unittest.main()
