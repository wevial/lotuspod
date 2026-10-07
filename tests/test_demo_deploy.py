"""Test suite for the demo site's deploy to Cloudflare Workers static assets.

Witnesses `demo/wrangler.json` (an assets-only Worker on the custom domain,
with no workers.dev or preview URLs and no account or zone id), the `demo`
workflow (pushes to main touching the docs, the package or demo/, and manual
dispatch, never a pull request; the build, a pinned `wrangler deploy`, and the
Cloudflare secrets in the deploy step only), a real build into the directory
the config uploads, and the README's "Try the demo" line.

Reads `.github/workflows/demo.yml` as text, as tests.test_ci_workflow does,
since the package has no YAML parser.

Run from the repo root:

    python -m unittest tests.test_demo_deploy -v
"""

from __future__ import annotations

import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
CONFIG = REPO_ROOT / "demo" / "wrangler.json"
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "demo.yml"
DOMAIN = "lotuspod.kovial.co"
DEMO_URL = f"https://{DOMAIN}/"
PATHS = ["README.md", "docs/**", "src/lotuspod/**", "demo/**"]
SECRETS = ("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID")
BUILD = "python -m demo.build --out demo/dist"
DEPLOY = re.compile(r"^npx --yes wrangler@(\d+\.\d+\.\d+) deploy$")
# The Workers free plan's limits on one version's assets.
MAX_FILES = 20_000
MAX_FILE_BYTES = 25 * 1024 * 1024


def config() -> dict:
    return json.loads(CONFIG.read_text(encoding="utf-8"))


class ConfigTests(unittest.TestCase):
    def setUp(self) -> None:
        self.config = config()

    def test_names_the_worker_and_a_fixed_compatibility_date(self):
        self.assertEqual(self.config["name"], "lotuspod-demo")
        self.assertRegex(self.config["compatibility_date"], r"^\d{4}-\d{2}-\d{2}$")

    def test_uploads_dist_and_keeps_html_in_urls(self):
        self.assertEqual(self.config["assets"], {"directory": "./dist", "html_handling": "none"})

    def test_workers_dev_and_preview_urls_are_off(self):
        self.assertIs(self.config["workers_dev"], False)
        self.assertIs(self.config["preview_urls"], False)

    def test_its_one_route_is_the_custom_domain(self):
        self.assertEqual(self.config["routes"], [{"pattern": DOMAIN, "custom_domain": True}])

    def test_has_no_script_ids_or_bindings(self):
        for key in ("main", "account_id", "zone_id"):
            with self.subTest(key=key):
                self.assertNotIn(key, self.config)
        self.assertEqual(
            sorted(self.config),
            sorted(["name", "compatibility_date", "assets", "workers_dev",
                    "preview_urls", "routes"]),
        )


class WorkflowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue(WORKFLOW.is_file(), f"{WORKFLOW} does not exist")
        self.text = WORKFLOW.read_text(encoding="utf-8")

    def block(self, key: str, indent: str = "", text: str | None = None) -> str:
        """The lines nested under `key:` at the given indent."""
        match = re.search(
            rf"^{indent}{re.escape(key)}:[ \t]*\n((?:{indent}[ \t]+.*\n|[ \t]*\n)*)",
            self.text if text is None else text,
            re.MULTILINE,
        )
        self.assertIsNotNone(match, f"no `{key}:` block")
        return match.group(1)

    def steps(self) -> list[str]:
        """The `deploy` job's steps, each as its text, in order."""
        steps = self.block("steps", indent="    ")
        return [step for step in re.split(r"(?m)^(?=      - )", steps) if step.strip()]

    def step(self, name: str) -> str:
        found = [step for step in self.steps()
                 if re.search(rf"(?m)^      - name: {re.escape(name)}$", step)]
        self.assertEqual(len(found), 1, self.steps())
        return found[0]

    def test_triggers_on_push_and_manual_dispatch_only(self):
        triggers = re.findall(r"(?m)^  (\S+):\s*$", self.block("on"))
        self.assertEqual(triggers, ["push", "workflow_dispatch"])
        self.assertNotIn("pull_request", self.text)

    def test_push_is_to_main_with_exactly_the_four_paths(self):
        push = self.block("push", indent="  ")
        branches = re.findall(r"(?m)^\s+- (\S+)\s*$", self.block("branches", "    ", push))
        paths = re.findall(r"(?m)^\s+- (\S+)\s*$", self.block("paths", "    ", push))
        self.assertEqual(branches, ["main"])
        self.assertEqual(paths, PATHS)

    def test_permissions_are_contents_read(self):
        self.assertEqual(self.block("permissions").strip(), "contents: read")

    def test_deploys_never_overlap_or_cancel(self):
        concurrency = self.block("concurrency")
        self.assertRegex(concurrency, r"(?m)^  group: demo-deploy$")
        self.assertRegex(concurrency, r"(?m)^  cancel-in-progress: false$")

    def test_has_one_job_named_deploy(self):
        jobs = re.findall(r"(?m)^  (\S+):\s*$", self.block("jobs"))
        self.assertEqual(jobs, ["deploy"])

    def test_steps_check_out_set_up_build_and_deploy_in_order(self):
        steps = self.steps()
        self.assertEqual(len(steps), 5, steps)
        self.assertIn("uses: actions/checkout@", steps[0])
        self.assertIn("uses: actions/setup-python@", steps[1])
        self.assertRegex(steps[1], r"""(?m)^\s+python-version: ["']3\.11["']$""")
        self.assertIn("uses: actions/setup-node@", steps[2])
        self.assertEqual(steps[3], self.step("build"))
        self.assertEqual(steps[4], self.step("deploy"))

    def test_the_build_step_builds_into_demo_dist(self):
        self.assertRegex(self.step("build"), rf"(?m)^        run: {re.escape(BUILD)}$")

    def test_the_deploy_step_runs_an_exact_wrangler_in_demo(self):
        deploy = self.step("deploy")
        self.assertRegex(deploy, r"(?m)^        working-directory: demo$")
        run = re.search(r"(?m)^        run: (.+)$", deploy)
        self.assertIsNotNone(run, deploy)
        self.assertRegex(run.group(1), DEPLOY)
        self.assertEqual(len(re.findall(r"wrangler@", self.text)), 1)

    def test_the_cloudflare_secrets_reach_the_deploy_step_env_only(self):
        deploy = self.step("deploy")
        env = self.block("env", "        ", deploy)
        for secret in SECRETS:
            with self.subTest(secret=secret):
                self.assertRegex(
                    env, rf"(?m)^          {secret}: \$\{{\{{ secrets\.{secret} \}}\}}$"
                )
                self.assertNotIn(secret, self.text.replace(env, ""))
        self.assertEqual(self.text.count("secrets."), len(SECRETS))


class BuildTests(unittest.TestCase):
    """A real build, run as the workflow runs it, into a scratch checkout layout."""

    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = tempfile.TemporaryDirectory(prefix="lotuspod-demo-deploy-")
        cls.root = Path(cls.tmp.name)
        cls.out_arg = BUILD.split("--out ", 1)[1]
        cls.out = cls.root / cls.out_arg
        done = subprocess.run(
            [sys.executable, "-m", "demo.build", "--out", str(cls.out)],
            cwd=REPO_ROOT, capture_output=True, text=True, encoding="utf-8",
        )
        if done.returncode != 0:
            cls.tmp.cleanup()
            raise AssertionError(f"the build failed:\n{done.stderr}")
        # wrangler runs in demo/ and reads assets.directory from there.
        cls.upload = cls.root / "demo" / config()["assets"]["directory"]

    @classmethod
    def tearDownClass(cls) -> None:
        cls.tmp.cleanup()

    def files(self) -> list[Path]:
        return [path for path in self.upload.rglob("*") if not path.is_dir()]

    def test_the_uploaded_directory_is_the_build_output(self):
        self.assertEqual(self.upload.resolve(), self.out.resolve())
        self.assertEqual((REPO_ROOT / self.out_arg).resolve(),
                         (REPO_ROOT / "demo" / "dist").resolve())

    def test_every_uploaded_path_is_a_file_under_the_build_output(self):
        files = self.files()
        self.assertTrue(files)
        for path in files:
            with self.subTest(path=str(path.relative_to(self.upload))):
                self.assertFalse(path.is_symlink())
                self.assertTrue(path.resolve().is_relative_to(self.out.resolve()))

    def test_holds_the_headers_and_redirects_files(self):
        for name in ("_headers", "_redirects"):
            with self.subTest(name=name):
                self.assertTrue((self.out / name).is_file())

    def test_no_file_says_noindex(self):
        for path in self.files():
            with self.subTest(path=str(path.relative_to(self.out))):
                self.assertNotIn(b"noindex", path.read_bytes().lower())

    def test_fits_the_free_plan_limits(self):
        files = self.files()
        self.assertLessEqual(len(files), MAX_FILES)
        for path in files:
            with self.subTest(path=str(path.relative_to(self.out))):
                self.assertLessEqual(path.stat().st_size, MAX_FILE_BYTES)


class ReadmeTests(unittest.TestCase):
    def setUp(self) -> None:
        self.text = (REPO_ROOT / "README.md").read_text(encoding="utf-8")

    def test_links_the_demo_with_the_try_the_demo_wording(self):
        line = ("Try the demo: [https://lotuspod.kovial.co/](https://lotuspod.kovial.co/) "
                "(your comments stay in your browser; replies are scripted)")
        self.assertIn(f"\n{line}\n", self.text)
        self.assertIn(f"]({DEMO_URL})", self.text)

    def test_the_link_is_near_the_top(self):
        lines = self.text.splitlines()
        first = next(i for i, line in enumerate(lines) if line.startswith("Try the demo:"))
        self.assertLess(first, 20)

    def test_stays_at_most_200_lines(self):
        self.assertLessEqual(len(self.text.splitlines()), 200)


if __name__ == "__main__":
    unittest.main()
