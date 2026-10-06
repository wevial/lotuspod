"""Test suite for the `unit` GitHub Actions workflow: the pull request check
runs the leak guard on the diff, then the whole unit suite.

Reads `.github/workflows/unit.yml` as text, since the package has no YAML
parser, and pins the triggers, the job name, the full-history checkout, the
Python version, the leak guard step and the ranges it scans, the install step
and the test command.

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

    def steps(self) -> list[str]:
        """The `unit` job's steps, each as its text, in order."""
        steps = self.block("steps", indent="    ")
        return [step for step in re.split(r"(?m)^(?=      - )", steps) if step.strip()]

    def guard_step(self) -> str:
        guards = [step for step in self.steps() if "ci/leak_guard.py" in step]
        self.assertEqual(len(guards), 1, guards)
        return guards[0]

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

    def test_checks_out_the_full_history(self) -> None:
        checkout = self.steps()[0]
        self.assertIn("uses: actions/checkout@v4", checkout)
        self.assertRegex(checkout, r"(?m)^          fetch-depth: 0$")

    def test_the_leak_guard_runs_before_the_install_and_the_suite(self) -> None:
        steps = self.steps()
        guard = steps.index(self.guard_step())
        install = steps.index("      - run: pip install -e .\n")
        suite = steps.index("      - run: python -m unittest discover -s tests\n")
        self.assertLess(guard, install)
        self.assertLess(install, suite)

    def test_the_guard_scans_the_pull_request_and_the_push(self) -> None:
        guard = self.guard_step()
        for line in (
            "EVENT_NAME: ${{ github.event_name }}",
            "PR_BASE_SHA: ${{ github.event.pull_request.base.sha }}",
            "PUSH_BEFORE: ${{ github.event.before }}",
            "PUSH_SHA: ${{ github.sha }}",
        ):
            with self.subTest(line=line):
                self.assertRegex(guard, rf"(?m)^          {re.escape(line)}$")
        script = guard.split("run: |\n", 1)[1]
        self.assertNotIn("${{", script)
        self.assertIn('if [ "$EVENT_NAME" = "pull_request" ]; then', script)
        self.assertIn('python ci/leak_guard.py "$PR_BASE_SHA" HEAD', script)
        self.assertIn('base="$PUSH_BEFORE"', script)
        self.assertIn('[ -z "${base//0/}" ]', script)
        self.assertIn('! git cat-file -e "${base}^{commit}"', script)
        self.assertIn('base="HEAD^"', script)
        self.assertIn('python ci/leak_guard.py "$base" "$PUSH_SHA"', script)

    def test_the_leak_patterns_secret_reaches_the_guard_step_only(self) -> None:
        self.assertEqual(self.text.count("secrets.LEAK_PATTERNS"), 1)
        outside = self.text.replace(self.guard_step(), "")
        self.assertNotIn("LEAK_PATTERNS", outside)
        self.assertRegex(
            self.guard_step(),
            r"(?m)^          LEAK_PATTERNS: \$\{\{ secrets\.LEAK_PATTERNS \}\}$",
        )

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
