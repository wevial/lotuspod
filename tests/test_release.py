"""Test suite for releasing Lotuspod from a pushed `vX.Y.Z` tag.

Witnesses the five pieces: `ci/release_check.py`, run on a temporary copy of
the checkout, prints the changelog section for a tag that matches the
version and refuses, naming the problem, every other tag and a changelog
without the section; `ci/pypi_readme.py`, run on a temporary copy of the
README, points every relative image and link at GitHub at the tag and leaves
the rest, code included, byte for byte; `ci/install_smoke.sh`, run on a
wheel really built from this checkout after that rewrite, passes, and fails
naming the file when a wheel is rebuilt without one theme script, and naming
the target when it is built without the rewrite;
`.github/workflows/release.yml`, read as text the
way `tests.test_ci_workflow` reads the `unit` workflow, holds its triggers,
jobs, permissions, steps and secrets to the release's; and `CHANGELOG.md`
and the "Releasing" section of `docs/development.md` say what a release
needs.

Run from the repo root (the build tests skip without `build` installed):

    python -m pip install build
    python -m unittest tests.test_release -v
"""

from __future__ import annotations

import importlib.util
import re
import shutil
import subprocess
import sys
import tempfile
import tomllib
import unittest
from pathlib import Path

from tests.test_docs_links import section

REPO_ROOT = Path(__file__).resolve().parents[1]
RELEASE_CHECK = REPO_ROOT / "ci" / "release_check.py"
INSTALL_SMOKE = REPO_ROOT / "ci" / "install_smoke.sh"
PYPI_README = REPO_ROOT / "ci" / "pypi_readme.py"
README = REPO_ROOT / "README.md"
WORKFLOW = REPO_ROOT / ".github" / "workflows" / "release.yml"
CHANGELOG = REPO_ROOT / "CHANGELOG.md"
DEVELOPMENT = REPO_ROOT / "docs" / "development.md"

VERSION_HEADING = re.compile(r"^## (\d+\.\d+\.\d+) - (\d{4}-\d{2}-\d{2})$", re.M)
FULL_SHA = re.compile(r"^[0-9a-f]{40}$")
# The theme script the broken wheel leaves out.
DROPPED_SCRIPT = "narrow.js"
IMAGES = ("loop.gif", "thread.png", "decisions.png", "passage.png")
RAW = "https://raw.githubusercontent.com/wevial/lotuspod"
BLOB = "https://github.com/wevial/lotuspod/blob"
# A `](` target with no scheme that isn't a bare anchor.
RELATIVE_TARGET = re.compile(r"\]\((?![A-Za-z][A-Za-z0-9+.-]*:|#|//)[^)]*\)")
FENCED = re.compile(r"(?ms)^```.*?^```[ \t]*$")
CODE_SPAN = re.compile(r"`[^`]*`")


def outside_code(text: str) -> str:
    """text without its fenced blocks and code spans."""
    return CODE_SPAN.sub("", FENCED.sub("", text))


def project_version() -> str:
    with (REPO_ROOT / "pyproject.toml").open("rb") as handle:
        return tomllib.load(handle)["project"]["version"]


def rewrite_readme(root: Path, tag: str) -> subprocess.CompletedProcess:
    """Run ci/pypi_readme.py as copied into root/ci, on root/README.md."""
    (root / "ci").mkdir(exist_ok=True)
    shutil.copy(PYPI_README, root / "ci" / "pypi_readme.py")
    return subprocess.run([sys.executable, str(root / "ci" / "pypi_readme.py"), tag],
                          capture_output=True, text=True, cwd=root)


def load_release_check():
    spec = importlib.util.spec_from_file_location("release_check", RELEASE_CHECK)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def set_version(pyproject: str, version: str) -> str:
    """pyproject.toml's text with its [project] version replaced."""
    text, count = re.subn(r'(?m)^version = "[^"]*"$', f'version = "{version}"', pyproject)
    assert count == 1, "pyproject.toml has no one `version = ...` line"
    return text


class ReleaseCheckTests(unittest.TestCase):
    """The script, run on a copy of the checkout whose version is 0.1.0."""

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)
        (self.root / "ci").mkdir()
        shutil.copy(RELEASE_CHECK, self.root / "ci" / "release_check.py")
        pyproject = (REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8")
        (self.root / "pyproject.toml").write_text(set_version(pyproject, "0.1.0"),
                                                  encoding="utf-8")
        shutil.copy(CHANGELOG, self.root / "CHANGELOG.md")

    def run_check(self, *args: str, no_tomllib: bool = False) -> subprocess.CompletedProcess:
        script = str(self.root / "ci" / "release_check.py")
        if no_tomllib:
            # Python 3.9 has no tomllib: an import of it fails as it would there.
            code = ("import runpy, sys; sys.modules['tomllib'] = None; "
                    "sys.argv = sys.argv[1:]; runpy.run_path(sys.argv[0], run_name='__main__')")
            command = [sys.executable, "-c", code, script, *args]
        else:
            command = [sys.executable, script, *args]
        return subprocess.run(command, capture_output=True, text=True, cwd=self.root)

    def expected_notes(self) -> str:
        text = (self.root / "CHANGELOG.md").read_text(encoding="utf-8")
        start = re.search(r"(?m)^## 0\.1\.0 - .*\n", text)
        self.assertIsNotNone(start, "the copied changelog has no 0.1.0 section")
        rest = text[start.end():]
        end = re.search(r"(?m)^#{1,2} ", rest)
        return (rest[:end.start()] if end else rest).strip()

    def test_the_matching_tag_prints_the_section_body_without_its_heading(self):
        proc = self.run_check("v0.1.0")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.strip(), self.expected_notes())
        self.assertTrue(proc.stdout.strip())
        self.assertNotIn("## 0.1.0", proc.stdout)
        self.assertEqual(proc.stderr, "")

    def test_without_tomllib_the_version_is_read_by_line(self):
        proc = self.run_check("v0.1.0", no_tomllib=True)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual(proc.stdout.strip(), self.expected_notes())
        refused = self.run_check("v0.2.0", no_tomllib=True)
        self.assertNotEqual(refused.returncode, 0)
        self.assertIn("0.1.0", refused.stderr)

    def test_a_tag_other_than_v_plus_the_version_is_refused(self):
        for tag in ("v0.2.0", "0.1.0", "v0.1"):
            with self.subTest(tag=tag):
                proc = self.run_check(tag)
                self.assertNotEqual(proc.returncode, 0)
                self.assertEqual(proc.stdout, "")
                self.assertIn(f"'{tag}'", proc.stderr)
                self.assertIn("version 0.1.0", proc.stderr)

    def test_a_changelog_without_the_section_is_refused(self):
        changelog = self.root / "CHANGELOG.md"
        text = changelog.read_text(encoding="utf-8")
        changelog.write_text(text.replace("## 0.1.0 - ", "## 0.0.9 - "), encoding="utf-8")
        proc = self.run_check("v0.1.0")
        self.assertNotEqual(proc.returncode, 0)
        self.assertEqual(proc.stdout, "")
        self.assertIn("CHANGELOG.md has no '## 0.1.0' section", proc.stderr)

    def test_a_missing_changelog_is_refused(self):
        (self.root / "CHANGELOG.md").unlink()
        proc = self.run_check("v0.1.0")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("CHANGELOG.md", proc.stderr)

    def test_an_empty_section_is_refused(self):
        (self.root / "CHANGELOG.md").write_text(
            "# Changelog\n\n## 0.1.0 - 2026-01-01\n\n## 0.0.1 - 2025-01-01\n\nOld.\n",
            encoding="utf-8")
        proc = self.run_check("v0.1.0")
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("'## 0.1.0' section is empty", proc.stderr)

    def test_the_tag_is_required(self):
        proc = self.run_check()
        self.assertEqual(proc.returncode, 2)
        self.assertIn("usage:", proc.stderr)


class ReleaseCheckParsingTests(unittest.TestCase):
    def setUp(self) -> None:
        self.module = load_release_check()

    def test_the_line_match_reads_the_project_version_only(self):
        text = ('[tool.other]\nversion = "9.9.9"\n\n[project]\nname = "x"\n'
                'version = "1.2.3"  # bumped\n\n[tool.setuptools]\nversion = "8.8.8"\n')
        self.assertEqual(self.module.version_from_lines(text), "1.2.3")
        self.assertIsNone(self.module.version_from_lines('[tool.x]\nversion = "1.0.0"\n'))

    def test_the_line_match_agrees_with_tomllib_on_pyproject(self):
        text = (REPO_ROOT / "pyproject.toml").read_text(encoding="utf-8")
        self.assertEqual(self.module.version_from_lines(text),
                         tomllib.loads(text)["project"]["version"])

    def test_a_section_ends_at_the_next_heading_and_needs_an_exact_version(self):
        text = ("# Changelog\n\n## [1.0.10] - 2026-02-01\n\nTen.\n\n"
                "## 1.0.1 - 2026-01-01\n\nOne.\n\n### Fixed\n\n- A fix.\n\n"
                "## 1.0.0 - 2025-12-01\n\nZero.\n")
        self.assertEqual(self.module.changelog_section(text, "1.0.1"),
                         "One.\n\n### Fixed\n\n- A fix.")
        self.assertEqual(self.module.changelog_section(text, "1.0.10"), "Ten.")
        self.assertIsNone(self.module.changelog_section(text, "1.0"))
        self.assertIsNone(self.module.changelog_section(text, "0.1.0"))

    def test_this_checkout_is_releasable_at_its_version(self):
        with (REPO_ROOT / "pyproject.toml").open("rb") as handle:
            version = tomllib.load(handle)["project"]["version"]
        self.assertTrue(self.module.check(f"v{version}", REPO_ROOT))


class PypiReadmeTests(unittest.TestCase):
    """The rewrite, run on a temporary copy of a README."""

    SAMPLE = (
        "# Sample\n\n"
        "![A picture](docs/images/a.png) and ![a titled one](./docs/b.png \"B\")\n\n"
        "See [the guide](docs/guide.md#setup), [security](SECURITY.md) and\n"
        "[a linked picture ![c](docs/c.png)](docs/c.md).\n\n"
        "Read [`guide` and ``a`b``](docs/guide.md#setup), not `[x](docs/y.md)`.\n\n"
        "Leave [the site](https://example.com/x), [mail](mailto:someone@example.com),\n"
        "[an anchor](#sample), [a host](//example.com/y) and `[code](docs/span.md)`.\n\n"
        "```md\n[in a fence](docs/x.md)\n![fenced](docs/x.png)\n```\n\n"
        "~~~~\n```\n[still fenced](docs/y.md)\n~~~~\n"
    )
    EXPECTED = (
        "# Sample\n\n"
        f"![A picture]({RAW}/v0.1.1/docs/images/a.png) and "
        f"![a titled one]({RAW}/v0.1.1/docs/b.png \"B\")\n\n"
        f"See [the guide]({BLOB}/v0.1.1/docs/guide.md#setup), "
        f"[security]({BLOB}/v0.1.1/SECURITY.md) and\n"
        f"[a linked picture ![c]({RAW}/v0.1.1/docs/c.png)]({BLOB}/v0.1.1/docs/c.md).\n\n"
        f"Read [`guide` and ``a`b``]({BLOB}/v0.1.1/docs/guide.md#setup), "
        "not `[x](docs/y.md)`.\n\n"
        "Leave [the site](https://example.com/x), [mail](mailto:someone@example.com),\n"
        "[an anchor](#sample), [a host](//example.com/y) and `[code](docs/span.md)`.\n\n"
        "```md\n[in a fence](docs/x.md)\n![fenced](docs/x.png)\n```\n\n"
        "~~~~\n```\n[still fenced](docs/y.md)\n~~~~\n"
    )

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)

    def rewrite(self, text: str, tag: str = "v0.1.1") -> str:
        readme = self.root / "README.md"
        readme.write_text(text, encoding="utf-8")
        proc = rewrite_readme(self.root, tag)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        return readme.read_text(encoding="utf-8")

    def test_the_sample_points_relative_targets_at_the_tag_and_keeps_the_rest(self):
        self.assertEqual(self.rewrite(self.SAMPLE), self.EXPECTED)

    def test_the_readme_points_its_images_and_links_at_the_tag(self):
        original = README.read_text(encoding="utf-8")
        self.assertRegex(outside_code(original), RELATIVE_TARGET)
        text = self.rewrite(original)
        for name in IMAGES:
            with self.subTest(image=name):
                self.assertIn(f"]({RAW}/v0.1.1/docs/images/{name})", text)
        self.assertIn(f"]({BLOB}/v0.1.1/docs/development.md#captures)", text)
        self.assertEqual(RELATIVE_TARGET.findall(outside_code(text)), [])
        # Only the targets changed: taking the prefixes back out restores it.
        restored = text.replace(f"{RAW}/v0.1.1/", "").replace(f"{BLOB}/v0.1.1/", "")
        self.assertEqual(restored, original)

    def test_a_second_run_changes_nothing(self):
        once = self.rewrite(self.SAMPLE)
        self.assertEqual(self.rewrite(once), once)

    def test_the_tag_is_required_and_must_be_a_tag_name(self):
        (self.root / "README.md").write_text(self.SAMPLE, encoding="utf-8")
        proc = rewrite_readme(self.root, "v0.1.1")
        usage = subprocess.run([sys.executable, str(self.root / "ci" / "pypi_readme.py")],
                               capture_output=True, text=True, cwd=self.root)
        self.assertEqual(usage.returncode, 2)
        self.assertIn("usage:", usage.stderr)
        before = (self.root / "README.md").read_text(encoding="utf-8")
        for tag in ("", "v0.1.1/x", "v 1"):
            with self.subTest(tag=tag):
                bad = rewrite_readme(self.root, tag)
                self.assertEqual(bad.returncode, 1)
                self.assertIn("not a tag name", bad.stderr)
        self.assertEqual(proc.returncode, 0, proc.stderr)
        self.assertEqual((self.root / "README.md").read_text(encoding="utf-8"), before)


@unittest.skipIf(importlib.util.find_spec("build") is None,
                 "the build module isn't installed (python -m pip install build)")
class InstallSmokeTests(unittest.TestCase):
    """The real build of a copy of this checkout, and the real smoke script."""

    @staticmethod
    def copy_checkout(root: Path, rewrite: bool = True) -> Path:
        """A copy of what the build reads, its README rewritten for the
        version's tag as the release job does, unless rewrite is false."""
        source = root / "source"
        source.mkdir()
        for name in ("pyproject.toml", "README.md", "LICENSE"):
            shutil.copy(REPO_ROOT / name, source / name)
        shutil.copytree(REPO_ROOT / "src", source / "src",
                        ignore=shutil.ignore_patterns("__pycache__", "*.pyc", "*.egg-info"))
        if rewrite:
            proc = rewrite_readme(source, f"v{project_version()}")
            if proc.returncode != 0:
                raise AssertionError(f"ci/pypi_readme.py failed:\n{proc.stderr}")
        return source

    @staticmethod
    def build(source: Path, dist: Path) -> None:
        proc = subprocess.run(
            [sys.executable, "-m", "build", "--outdir", str(dist), str(source)],
            capture_output=True, text=True,
        )
        if proc.returncode != 0:
            raise AssertionError(f"python -m build failed:\n{proc.stdout}\n{proc.stderr}")

    @staticmethod
    def smoke(dist: Path) -> subprocess.CompletedProcess:
        return subprocess.run(
            [shutil.which("bash") or "bash", str(INSTALL_SMOKE), str(dist)],
            capture_output=True, text=True,
            env={"PATH": "/usr/bin:/bin", "PYTHON": sys.executable},
        )

    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.root = Path(tmp.name)

    def test_the_built_wheel_installs_and_publishes_a_page(self):
        dist = self.root / "dist"
        self.build(self.copy_checkout(self.root), dist)
        self.assertEqual(sorted(p.suffix for p in dist.iterdir()), [".gz", ".whl"])
        proc = self.smoke(dist)
        self.assertEqual(proc.returncode, 0, proc.stdout + proc.stderr)
        last = proc.stdout.strip().splitlines()[-1]
        self.assertIn("lotuspod.css", last)
        self.assertIn("lotuspod-page.js", last)

    def test_a_wheel_without_one_theme_script_fails_naming_it(self):
        source = self.copy_checkout(self.root)
        scripts = sorted(p.name for p in (source / "src/lotuspod/_theme/js").glob("*.js"))
        self.assertIn(DROPPED_SCRIPT, scripts)
        kept = ", ".join(f'"_theme/js/{name}"' for name in scripts if name != DROPPED_SCRIPT)
        pyproject = source / "pyproject.toml"
        text = pyproject.read_text(encoding="utf-8")
        self.assertIn('"_theme/js/*.js"', text)
        pyproject.write_text(text.replace('"_theme/js/*.js"', kept), encoding="utf-8")
        dist = self.root / "dist"
        self.build(source, dist)
        proc = self.smoke(dist)
        self.assertNotEqual(proc.returncode, 0, proc.stdout)
        self.assertIn(f"js/{DROPPED_SCRIPT}", proc.stderr)

    def test_a_wheel_built_without_the_rewrite_fails_naming_a_relative_target(self):
        dist = self.root / "dist"
        self.build(self.copy_checkout(self.root, rewrite=False), dist)
        proc = self.smoke(dist)
        self.assertNotEqual(proc.returncode, 0, proc.stdout)
        self.assertIn("the description links docs/images/loop.gif, which is relative",
                      proc.stderr)
        self.assertIn("SECURITY.md, which is relative", proc.stderr)

    def test_a_dist_without_one_wheel_is_refused(self):
        dist = self.root / "dist"
        dist.mkdir()
        proc = self.smoke(dist)
        self.assertNotEqual(proc.returncode, 0)
        self.assertIn("expected one wheel", proc.stderr)


def block(text: str, key: str, indent: str = "") -> str:
    """The lines nested under `key:` at the given indent."""
    match = re.search(
        rf"^{indent}{re.escape(key)}:[ \t]*\n((?:{indent}[ \t]+.*\n|[ \t]*\n)*)",
        text, re.MULTILINE,
    )
    if match is None:
        raise AssertionError(f"no `{key}:` block at indent {len(indent)}")
    return match.group(1)


def entries(text: str) -> dict[str, str]:
    """The `key: value` lines of a block one level deep, by key."""
    return dict(re.findall(r"(?m)^\s+([\w-]+):[ \t]*(.*?)\s*$", text))


class ReleaseWorkflowTests(unittest.TestCase):
    def setUp(self) -> None:
        self.assertTrue(WORKFLOW.is_file(), f"{WORKFLOW} does not exist")
        self.text = WORKFLOW.read_text(encoding="utf-8")

    def job(self, name: str) -> str:
        return block(self.text, name, indent="  ")

    def steps(self, name: str) -> list[str]:
        steps = block(self.job(name), "steps", indent="    ")
        return [step for step in re.split(r"(?m)^(?=      - )", steps) if step.strip()]

    def step(self, name: str, needle: str) -> str:
        found = [step for step in self.steps(name) if needle in step]
        self.assertEqual(len(found), 1, f"{needle!r} in {name}: {found}")
        return found[0]

    def test_triggers_on_v_tags_only(self):
        on = block(self.text, "on")
        self.assertEqual(re.findall(r"(?m)^  (\S+):", on), ["push"])
        push = block(on, "push", indent="  ")
        self.assertEqual(re.findall(r"(?m)^    (\S+):", push), ["tags"])
        self.assertEqual(re.findall(r"(?m)^\s+- (.+?)\s*$", push), ['"v*"'])

    def test_has_two_jobs_build_then_publish(self):
        jobs = re.findall(r"(?m)^  (\S+):\s*$", block(self.text, "jobs"))
        self.assertEqual(jobs, ["build", "publish"])

    def test_build_may_only_read_the_contents(self):
        self.assertEqual(entries(block(self.job("build"), "permissions", indent="    ")),
                         {"contents": "read"})
        self.assertNotRegex(self.text, r"(?m)^permissions:")

    def test_build_checks_guards_tests_builds_and_smokes_in_order(self):
        steps = self.steps("build")
        order = [
            'python ci/release_check.py "$GITHUB_REF_NAME" > notes.md',
            "python ci/leak_guard.py",
            "run: pip install -e .\n",
            "run: python -m unittest discover -s tests\n",
            "run: python -m pip install build\n",
            "python ci/pypi_readme.py",
            "run: python -m build\n",
            "run: bash ci/install_smoke.sh dist\n",
            "uses: actions/upload-artifact@",
        ]
        at = [steps.index(self.step("build", needle)) for needle in order]
        self.assertEqual(at, sorted(at))
        self.assertIn("fetch-depth: 0", steps[0])

    def test_the_readme_is_rewritten_for_the_tag_after_the_check_before_the_build(self):
        steps = self.steps("build")
        rewrite = self.step("build", "ci/pypi_readme.py")
        self.assertIn('run: python ci/pypi_readme.py "$GITHUB_REF_NAME"\n', rewrite)
        at = steps.index(rewrite)
        self.assertLess(steps.index(self.step("build", "ci/release_check.py")), at)
        self.assertLess(at, steps.index(self.step("build", "run: python -m build\n")))

    def test_the_leak_guard_scans_the_tags_parent_to_the_tag(self):
        guard = self.step("build", "ci/leak_guard.py")
        self.assertIn('python ci/leak_guard.py "$GITHUB_REF_NAME^" "$GITHUB_REF_NAME"', guard)

    def test_build_uploads_the_dist_and_the_notes(self):
        upload = self.step("build", "actions/upload-artifact@")
        self.assertRegex(upload, r"(?m)^          name: release$")
        self.assertRegex(upload, r"(?m)^            dist/$")
        self.assertRegex(upload, r"(?m)^            notes\.md$")

    def test_publish_needs_build_in_the_pypi_environment(self):
        job = self.job("publish")
        self.assertRegex(job, r"(?m)^    needs: build$")
        self.assertRegex(job, r"(?m)^    environment: pypi$")
        self.assertEqual(entries(block(job, "permissions", indent="    ")),
                         {"contents": "write", "id-token": "write"})

    def test_publish_releases_the_downloaded_files_with_the_notes(self):
        steps = self.steps("publish")
        download = steps.index(self.step("publish", "actions/download-artifact@"))
        release = self.step("publish", "gh release create")
        self.assertIn('gh release create "$GITHUB_REF_NAME" dist/* --notes-file notes.md '
                      "--verify-tag", release)
        pypi = steps.index(self.step("publish", "pypa/gh-action-pypi-publish@"))
        self.assertLess(download, steps.index(release))
        self.assertLess(steps.index(release), pypi)

    def test_the_pypi_action_is_pinned_and_given_no_credential(self):
        step = self.step("publish", "pypa/gh-action-pypi-publish@")
        ref = re.search(r"pypa/gh-action-pypi-publish@(\S+)", step).group(1)
        self.assertRegex(ref, FULL_SHA)
        inputs = entries(block(step, "with", indent="        ")) if "with:" in step else {}
        for key in inputs:
            with self.subTest(input=key):
                self.assertNotIn("password", key)
                self.assertNotIn("token", key)
        self.assertNotIn("secrets.", step)

    def test_only_the_leak_patterns_and_github_token_secrets_are_used(self):
        self.assertLessEqual(set(re.findall(r"secrets\.(\w+)", self.text)),
                             {"LEAK_PATTERNS", "GITHUB_TOKEN"})
        guard = self.step("build", "ci/leak_guard.py")
        self.assertEqual(self.text.count("LEAK_PATTERNS"), guard.count("LEAK_PATTERNS"))

    def test_no_run_script_expands_an_expression(self):
        for job in ("build", "publish"):
            for step in self.steps(job):
                run = re.search(r"(?ms)^\s+run: (.*)", step)
                if run:
                    with self.subTest(step=step.strip().splitlines()[0]):
                        self.assertNotIn("${{", run.group(1))


class ChangelogTests(unittest.TestCase):
    def setUp(self) -> None:
        self.text = CHANGELOG.read_text(encoding="utf-8")

    def test_every_version_heading_is_version_dash_date(self):
        headings = re.findall(r"(?m)^## .*$", self.text)
        self.assertTrue(headings)
        for heading in headings:
            with self.subTest(heading=heading):
                self.assertRegex(heading, VERSION_HEADING)

    def test_the_first_release_is_a_dozen_lines_at_most(self):
        notes = load_release_check().changelog_section(self.text, "0.1.0")
        self.assertIsNotNone(notes)
        self.assertLessEqual(len(notes.splitlines()), 12)
        self.assertIn("first public release", notes)

    def test_0_1_1_says_the_pypi_page_shows_the_readmes_images_and_links(self):
        self.assertEqual(project_version(), "0.1.1")
        notes = load_release_check().check("v0.1.1", REPO_ROOT)
        flat = " ".join(notes.split())
        self.assertIn("PyPI page now shows the README's images and links", flat)

    def test_the_changelog_names_no_host_or_address(self):
        self.assertNotRegex(self.text, r"https?://|@|\b\w+\.(?:com|co|net|org|dev|io)\b")


class ReleasingDocsTests(unittest.TestCase):
    def setUp(self) -> None:
        self.section = section(DEVELOPMENT.read_text(encoding="utf-8"), "Releasing")

    def test_names_the_three_steps(self):
        steps = re.findall(r"(?m)^(\d+)\. (.*)$", self.section)
        self.assertEqual([number for number, _ in steps], ["1", "2", "3"])
        for (_, text), needle in zip(steps, ("`CHANGELOG.md`", "`pyproject.toml`", "`vX.Y.Z`")):
            with self.subTest(step=text):
                self.assertIn(needle, text)

    def test_names_the_trusted_publisher_and_the_environment(self):
        flat = " ".join(self.section.split())
        self.assertIn("trusted publisher", flat)
        for needle in ("project `lotuspod`", "owner `wevial`", "repository `lotuspod`",
                       "workflow `release.yml`", "environment `pypi`"):
            with self.subTest(needle=needle):
                self.assertIn(needle, flat)
        self.assertIn("create the environment `pypi`", flat)

    def test_says_the_pypi_description_points_at_github_and_the_readme_stays_relative(self):
        flat = " ".join(self.section.split())
        self.assertIn("The PyPI description is the README with every relative image and "
                      "link pointed at GitHub at the tag", flat)
        self.assertIn('python ci/pypi_readme.py "$GITHUB_REF_NAME"', flat)
        self.assertIn("the README itself stays relative", flat)

    def test_says_a_failed_publish_can_be_re_run(self):
        flat = " ".join(self.section.split())
        self.assertIn("re-run", flat)
        self.assertIn("without re-tagging", flat)


if __name__ == "__main__":
    unittest.main()
