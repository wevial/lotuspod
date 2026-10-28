"""Test suite for the `unit` and `e2e` GitHub Actions workflows.

The `unit` pull request check runs the leak guard on the diff in one job, the
unit suite in two shards in another, and a gate job named `unit` passes only
when both pass. Reads `.github/workflows/unit.yml` as text, since the package
has no YAML parser, and pins the triggers, the three jobs and the gate's name,
the full-history checkout, the Python version, the leak guard step and the
ranges it scans, the install step, the shard matrix and the runner command,
and the gate's needs and results.

Reads `.github/workflows/e2e.yml` the same way and pins its browser checks
step: it runs the spec files `ci/e2e_shard.py` prints for its matrix shard,
skips Playwright on a shard that holds none, and passes no `--shard` to
Playwright. The step's script runs under bash with `python` stubbed to record
the command it would serve the site around.

Run from the repo root:

    python -m unittest tests.test_ci_workflow -v
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "unit.yml"
E2E_WORKFLOW = REPO_ROOT / ".github" / "workflows" / "e2e.yml"
RUNNER = "python ci/run_modules.py --jobs 4 --shard ${{ matrix.shard }}/2 --max-module-sec 150"


class WorkflowTestCase(unittest.TestCase):
    workflow = WORKFLOW

    def setUp(self) -> None:
        self.assertTrue(self.workflow.is_file(), f"{self.workflow} does not exist")
        self.text = self.workflow.read_text(encoding="utf-8")

    def block(self, key: str, indent: str = "", text: str | None = None) -> str:
        """The lines nested under `key:` at the given indent."""
        match = re.search(
            rf"^{indent}{re.escape(key)}:[ \t]*\n((?:{indent}[ \t]+.*\n|[ \t]*\n)*)",
            self.text if text is None else text,
            re.MULTILINE,
        )
        self.assertIsNotNone(match, f"no `{key}:` block in the workflow")
        return match.group(1)

    def job(self, name: str) -> str:
        return self.block(name, indent="  ", text=self.block("jobs"))

    def steps(self, job: str) -> list[str]:
        """The job's steps, each as its text, in order."""
        steps = self.block("steps", indent="    ", text=self.job(job))
        return [step for step in re.split(r"(?m)^(?=      - )", steps) if step.strip()]

    def runs(self, job: str) -> list[str]:
        return re.findall(r"(?m)^\s+- run: (.+)$", "".join(self.steps(job)))



class UnitWorkflowTestCase(WorkflowTestCase):
    def guard_step(self) -> str:
        guards = [step for step in self.steps("leak-guard") if "ci/leak_guard.py" in step]
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

    def test_has_the_leak_guard_the_suite_and_the_unit_gate(self) -> None:
        jobs = re.findall(r"(?m)^  (\S+):\s*$", self.block("jobs"))
        self.assertEqual(jobs, ["leak-guard", "suite", "unit"])
        names = re.findall(r"(?m)^    name: (.+)$", self.block("jobs"))
        self.assertEqual(names, ["unit"])
        self.assertRegex(self.job("unit"), r"(?m)^    name: unit$")

    def test_every_job_runs_on_ubuntu_latest(self) -> None:
        for job in ("leak-guard", "suite", "unit"):
            with self.subTest(job=job):
                self.assertRegex(self.job(job), r"(?m)^    runs-on: ubuntu-latest$")

    def test_guard_and_suite_check_out_the_full_history_and_set_up_python_3_11(self) -> None:
        for job in ("leak-guard", "suite"):
            with self.subTest(job=job):
                checkout, python = self.steps(job)[:2]
                self.assertIn("uses: actions/checkout@v4", checkout)
                self.assertRegex(checkout, r"(?m)^          fetch-depth: 0$")
                self.assertIn("uses: actions/setup-python@v5", python)
                self.assertRegex(python, r"""(?m)^\s+python-version: ["']3\.11["']$""")

    def test_the_leak_guard_job_runs_the_guard_only(self) -> None:
        self.assertEqual(len(self.steps("leak-guard")), 3)
        self.assertEqual(self.runs("leak-guard"), [])
        self.assertIn(self.guard_step(), self.steps("leak-guard"))

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
        for job in ("suite", "unit"):
            with self.subTest(job=job):
                self.assertNotIn("ci/leak_guard.py", self.job(job))

    def test_the_leak_patterns_secret_reaches_the_guard_step_only(self) -> None:
        self.assertEqual(self.text.count("secrets.LEAK_PATTERNS"), 1)
        outside = self.text.replace(self.guard_step(), "")
        self.assertNotIn("LEAK_PATTERNS", outside)
        self.assertRegex(
            self.guard_step(),
            r"(?m)^          LEAK_PATTERNS: \$\{\{ secrets\.LEAK_PATTERNS \}\}$",
        )

    def test_the_suite_runs_two_shards_that_do_not_cancel_each_other(self) -> None:
        suite = self.job("suite")
        strategy = self.block("strategy", indent="    ", text=suite)
        self.assertRegex(strategy, r"(?m)^      fail-fast: false$")
        self.assertRegex(strategy, r"(?m)^        shard: \[1, 2\]$")
        self.assertRegex(suite, r"(?m)^    timeout-minutes: 15$")

    def test_the_suite_installs_the_package_then_runs_its_shard_four_at_a_time(self) -> None:
        self.assertEqual(self.runs("suite"), ["pip install -e .", RUNNER])
        self.assertNotIn("unittest discover", self.text)

    def test_the_unit_gate_passes_only_when_the_guard_and_both_shards_pass(self) -> None:
        unit = self.job("unit")
        self.assertRegex(unit, r"(?m)^    needs: \[leak-guard, suite\]$")
        self.assertRegex(unit, r"(?m)^    if: always\(\)$")
        self.assertRegex(unit, r"(?m)^    timeout-minutes: 5$")
        (step,) = self.steps("unit")
        self.assertRegex(step, r"(?m)^          LEAK_GUARD: \$\{\{ needs\.leak-guard\.result \}\}$")
        self.assertRegex(step, r"(?m)^          SUITE: \$\{\{ needs\.suite\.result \}\}$")
        script = step.split("run: |\n", 1)[1]
        self.assertNotIn("${{", script)
        self.assertIn('if [ "$LEAK_GUARD" != "success" ]; then', script)
        self.assertIn('echo "leak-guard: $LEAK_GUARD"', script)
        self.assertIn('if [ "$SUITE" != "success" ]; then', script)
        self.assertIn('echo "suite: $SUITE"', script)
        self.assertIn('exit "$status"', script)

    def test_has_no_node_or_browser_step(self) -> None:
        for word in ("setup-node", "npm", "npx", "playwright"):
            self.assertNotIn(word, self.text.lower())


# Stands in for `python` in the browser checks step: runs the shard script for
# real and records the arguments of any other command, one per line.
PYTHON_STUB = """#!/bin/sh
if [ "$1" = "ci/e2e_shard.py" ]; then
  exec "$REAL_PYTHON" "$@"
fi
printf '%s\\n' "$@" > "$RECORD"
"""
PLAYWRIGHT = ("python -m tests.capture_site npm --prefix e2e exec --no -- playwright test"
              " --config e2e/checks.config.ts --reporter=github,list"
              " --trace=retain-on-failure --forbid-only $files")


class E2eWorkflowTestCase(WorkflowTestCase):
    workflow = E2E_WORKFLOW

    def browser_checks(self) -> str:
        steps = [step for step in self.steps("e2e-shard") if "name: browser checks" in step]
        self.assertEqual(len(steps), 1, steps)
        return steps[0]

    def run_step(self, shard: int) -> list[str] | None:
        """The arguments the step passes to `python`, besides the shard script,
        for matrix shard N; None when it runs nothing else."""
        script = self.browser_checks().split("run: |\n", 1)[1]
        script = script.replace("${{ matrix.shard }}", str(shard))
        with tempfile.TemporaryDirectory() as scratch:
            stub = Path(scratch) / "python"
            stub.write_text(PYTHON_STUB, encoding="utf-8")
            stub.chmod(0o755)
            record = Path(scratch) / "record"
            env = dict(os.environ, PATH=f"{scratch}{os.pathsep}{os.environ['PATH']}",
                       REAL_PYTHON=sys.executable, RECORD=str(record))
            done = subprocess.run(["bash", "-e", "-c", script], cwd=REPO_ROOT, env=env,
                                  capture_output=True, text=True, timeout=60)
            self.assertEqual(done.returncode, 0, done.stderr)
            return record.read_text(encoding="utf-8").splitlines() if record.exists() else None

    def test_the_shards_are_still_four(self) -> None:
        strategy = self.block("strategy", indent="    ", text=self.job("e2e-shard"))
        self.assertRegex(strategy, r"(?m)^        shard: \[1, 2, 3, 4\]$")

    def test_the_browser_checks_step_takes_its_files_from_the_shard_script(self) -> None:
        script = self.browser_checks().split("run: |\n", 1)[1]
        lines = [line.strip() for line in script.splitlines() if line.strip()]
        self.assertEqual(lines[0], "files=$(python ci/e2e_shard.py --shard ${{ matrix.shard }}/4)")
        self.assertEqual(lines[1], 'if [ -z "$files" ]; then')
        self.assertIn("exit 0", lines[2:4])
        self.assertEqual(lines[-1], PLAYWRIGHT)

    def test_no_shard_is_passed_to_playwright(self) -> None:
        self.assertNotIn("--shard=", self.text)
        for line in self.browser_checks().splitlines():
            if "playwright" in line:
                with self.subTest(line=line):
                    self.assertNotIn("--shard", line)

    def test_each_shard_runs_the_files_the_shard_script_prints(self) -> None:
        for shard in (1, 2, 3, 4):
            with self.subTest(shard=shard):
                printed = subprocess.run(
                    [sys.executable, "ci/e2e_shard.py", "--shard", f"{shard}/4"],
                    cwd=REPO_ROOT, capture_output=True, text=True, check=True,
                ).stdout.split()
                self.assertTrue(printed)
                args = self.run_step(shard)
                self.assertIsNotNone(args)
                self.assertEqual(args[:2], ["-m", "tests.capture_site"])
                self.assertEqual(args[args.index("--forbid-only") + 1:], printed)


if __name__ == "__main__":
    unittest.main()
