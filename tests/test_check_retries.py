"""Witnesses CI's one retry of a failed browser check (e2e/checks.config.ts
sets `retries` to 1 when CI is set) against the capture fixture's site.

A group whose checks write to the served site cannot pass a retry: the
retry runs against the state the first attempt left. Such a group runs no
retry, so its failure is its own single error. A group that builds its own
state on each attempt keeps the retry, which passes.

The seam e2e/checks/fail-first-attempt.ts fails the first attempt of the
check LOTUSPOD_TEST_FAIL_FIRST names, after the check has run. Each case
runs the real fixture and Playwright with CI=1 and reads the JSON report.

The checks need e2e/node_modules, which `npm --prefix e2e ci` installs; this
test skips without it.

Run from the repo root:

    python -m unittest tests.test_check_retries -v
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path

from tests.test_browser_checks import COMMAND, PLAYWRIGHT, REPO_ROOT, TIMEOUT

MESSAGE = "failed on its first attempt by LOTUSPOD_TEST_FAIL_FIRST"

CHECKLIST_SAVES = (
    "saving folds the card to the items changed from their defaults, "
    "which a reload keeps"
)
ACTIVITY_INDEX = (
    "the index opens on Recent activity, grouped by page, newest first, "
    "and the filters span both views"
)
ACTIVITY_LINKS = (
    "each row links to its version, its thread or its decision, "
    "and the link opens it there"
)
ACTIVITY_KEPT = (
    "Recent activity, once pressed, is kept in the address, and Pages clears it"
)
CHAIN = (
    "a signed-in answer and comment reach the owner alone, "
    "and its reply and revision reach the reader"
)
ARCHIVED_DRAFT = (
    "a reply draft kept over a reload stays folded away, its toggle disabled"
)


def specs(suite: dict) -> list[dict]:
    """Every spec under a suite of the report, in file order."""
    found = list(suite.get("specs", []))
    for child in suite.get("suites", []):
        found.extend(specs(child))
    return found


def results(spec: dict) -> list[dict]:
    return [result for test in spec["tests"] for result in test["results"]]


@unittest.skipUnless(
    PLAYWRIGHT.is_dir(),
    "e2e/node_modules/@playwright/test is absent: run `npm --prefix e2e ci`",
)
class CheckRetriesTests(unittest.TestCase):
    def run_checks(self, spec: str, fail_first: str, grep: str | None = None):
        """Runs one spec file with CI set and the named check failed on its
        first attempt; returns the exit code, the report and its specs."""
        with tempfile.TemporaryDirectory() as tmp:
            report = Path(tmp) / "report.json"
            env = {
                **os.environ,
                "CI": "1",
                "LOTUSPOD_TEST_FAIL_FIRST": fail_first,
                "PLAYWRIGHT_JSON_OUTPUT_NAME": str(report),
            }
            command = [*COMMAND, "--reporter=json", spec]
            if grep is not None:
                command += ["--grep", re.escape(grep)]
            done = subprocess.run(
                command, cwd=str(REPO_ROOT), env=env, capture_output=True,
                text=True, timeout=TIMEOUT, check=False,
            )
            self.assertTrue(
                report.is_file(),
                f"no JSON report:\n{done.stdout}\n{done.stderr}",
            )
            data = json.loads(report.read_text())
        found = [one for suite in data["suites"] for one in specs(suite)]
        return done, data, found

    def named(self, found: list[dict], title: str) -> dict:
        matches = [spec for spec in found if spec["title"] == title]
        self.assertEqual(len(matches), 1, f"one check titled {title!r}")
        return matches[0]

    def assert_not_retried(self, found: list[dict], title: str):
        outcomes = [(r["retry"], r["status"]) for r in results(self.named(found, title))]
        self.assertEqual(outcomes, [(0, "failed")], f"{title!r} ran once and failed")
        retried = [
            spec["title"] for spec in found
            if any(r["retry"] >= 1 for r in results(spec))
        ]
        self.assertEqual(retried, [], "no check of the run is retried")

    def assert_retried_to_pass(self, done, data: dict, found: list[dict], title: str):
        spec_results = results(self.named(found, title))
        outcomes = [(r["retry"], r["status"]) for r in spec_results]
        self.assertEqual(
            outcomes, [(0, "failed"), (1, "passed")],
            f"{title!r} failed once, then passed on its retry",
        )
        messages = " ".join(
            error.get("message", "") for error in spec_results[0].get("errors", [])
        )
        self.assertIn(MESSAGE, messages)
        self.assertEqual(data["stats"]["flaky"], 1)
        self.assertEqual(data["stats"]["unexpected"], 0)
        self.assertEqual(done.returncode, 0, f"{done.stdout}\n{done.stderr}")

    def test_checklist_is_not_retried(self):
        _, _, found = self.run_checks("checklist.spec", CHECKLIST_SAVES)
        self.assert_not_retried(found, CHECKLIST_SAVES)
        index = found.index(self.named(found, CHECKLIST_SAVES))
        self.assertGreater(index, 0)
        self.assertEqual(
            [r["status"] for r in results(found[0])], ["passed"],
            "the checklist's first check passed once",
        )
        for spec in found[index + 1:]:
            self.assertEqual(
                [r["status"] for r in results(spec)], ["skipped"],
                f"{spec['title']!r} is skipped once",
            )

    def test_activity_index_is_not_retried(self):
        _, _, found = self.run_checks("activity.spec", ACTIVITY_INDEX, grep=ACTIVITY_INDEX)
        self.assert_not_retried(found, ACTIVITY_INDEX)

    def test_activity_links_is_not_retried(self):
        _, _, found = self.run_checks("activity.spec", ACTIVITY_LINKS, grep=ACTIVITY_LINKS)
        self.assert_not_retried(found, ACTIVITY_LINKS)

    def test_chain_is_not_retried(self):
        _, _, found = self.run_checks("chain.spec", CHAIN)
        self.assert_not_retried(found, CHAIN)

    def test_archived_page_keeps_its_retry(self):
        done, data, found = self.run_checks("archived-page.spec", ARCHIVED_DRAFT)
        self.assert_retried_to_pass(done, data, found, ARCHIVED_DRAFT)

    def test_activity_kept_view_keeps_its_retry(self):
        done, data, found = self.run_checks("activity.spec", ACTIVITY_KEPT, grep=ACTIVITY_KEPT)
        self.assert_retried_to_pass(done, data, found, ACTIVITY_KEPT)


if __name__ == "__main__":
    unittest.main()
