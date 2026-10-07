"""Runs the demo site's browser checks (e2e/demo/, config e2e/demo.config.ts)
in a real Chromium, through the pinned Playwright, against the built demo
site that `python -m demo.build --serve -- CMD` serves on 127.0.0.1.

The checks need e2e/node_modules, which `npm --prefix e2e ci` installs. The
`unit` pull request check installs no Node, so there this test skips.

Run from the repo root:

    python -m unittest tests.test_demo_checks -v
"""

from __future__ import annotations

import subprocess
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PLAYWRIGHT = REPO_ROOT / "e2e" / "node_modules" / "@playwright" / "test"
TIMEOUT = 900

COMMAND = (
    sys.executable, "-m", "demo.build", "--serve", "--",
    "npm", "--prefix", "e2e", "exec", "--no", "--",
    "playwright", "test", "--config", "e2e/demo.config.ts",
)


class DemoChecksTests(unittest.TestCase):
    @unittest.skipUnless(
        PLAYWRIGHT.is_dir(),
        "e2e/node_modules/@playwright/test is absent: run `npm --prefix e2e ci`",
    )
    def test_demo_checks_pass(self):
        done = subprocess.run(
            COMMAND, cwd=str(REPO_ROOT), capture_output=True, text=True,
            timeout=TIMEOUT, check=False,
        )
        self.assertEqual(
            done.returncode, 0,
            f"demo checks failed:\n{done.stdout}\n{done.stderr}",
        )


if __name__ == "__main__":
    unittest.main()
