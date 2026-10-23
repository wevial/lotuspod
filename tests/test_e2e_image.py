"""Test suite for the `e2e-shard` job's container image: the shards run in
Microsoft's Playwright image at the exact `@playwright/test` version
`e2e/package.json` pins, so a version bump that misses one of the two fails.

Reads `.github/workflows/e2e.yml` as text, since the package has no YAML
parser. The mismatch tests write their own `e2e/package.json` and workflow
into a temporary directory.

Run from the repo root:

    python -m unittest tests.test_e2e_image -v
"""

from __future__ import annotations

import json
import re
import tempfile
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
IMAGE_PREFIX = "mcr.microsoft.com/playwright:v"


def pinned_version(root: Path) -> str:
    """`@playwright/test`'s version in `e2e/package.json` under root."""
    package = json.loads((root / "e2e" / "package.json").read_text(encoding="utf-8"))
    for key in ("devDependencies", "dependencies"):
        version = package.get(key, {}).get("@playwright/test")
        if version:
            return version
    raise AssertionError("e2e/package.json does not pin @playwright/test")


def shard_image(root: Path) -> str:
    """The `e2e-shard` job's container image in the e2e workflow under root."""
    text = (root / ".github" / "workflows" / "e2e.yml").read_text(encoding="utf-8")
    # Drop comment lines and trailing comments, so a commented-out image is not read.
    text = re.sub(r"^[ \t]*#.*\n", "", text, flags=re.MULTILINE)
    text = re.sub(r"[ \t]+#.*$", "", text, flags=re.MULTILINE)
    job = re.search(r"^  e2e-shard:[ \t]*\n((?:    .*\n|[ \t]*\n)*)", text, re.MULTILINE)
    if job is None:
        raise AssertionError("no `e2e-shard` job in the e2e workflow")
    container = re.search(
        r"^    container:[ \t]*(.*)\n((?:      .*\n)*)", job.group(1), re.MULTILINE)
    if container is None:
        raise AssertionError("the `e2e-shard` job has no `container:`")
    inline, nested = container.group(1).strip(), container.group(2)
    image = (re.search(r"image:\s*[\"']?([^\"'\s,}]+)", inline + "\n" + nested)
             or re.fullmatch(r"[\"']?([^\"'\s{]+)[\"']?", inline))
    if image is None:
        raise AssertionError("the `e2e-shard` container names no image")
    return image.group(1)


def image_mismatch(root: Path) -> str | None:
    """Why the shard image does not match the pinned version, or None."""
    version, image = pinned_version(root), shard_image(root)
    match = re.fullmatch(re.escape(IMAGE_PREFIX) + r"([^-]+)-([a-z]+)", image)
    if match is None:
        return f"the e2e-shard image {image} is not {IMAGE_PREFIX}<version>-<release>"
    if match.group(1) != version:
        return (f"the e2e-shard image is Playwright {match.group(1)} but "
                f"e2e/package.json pins @playwright/test {version}")
    return None


WORKFLOW = """\
jobs:
  scope:
    runs-on: ubuntu-latest
  e2e-shard:
    runs-on: ubuntu-latest
    container:
      image: mcr.microsoft.com/playwright:v{image}-noble
    steps:
      - uses: actions/checkout@v4
  e2e:
    runs-on: ubuntu-latest
"""


class E2eImageTestCase(unittest.TestCase):
    def scratch(self, pinned: str, image: str, workflow: str = WORKFLOW) -> Path:
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        root = Path(directory.name)
        (root / "e2e").mkdir()
        (root / "e2e" / "package.json").write_text(
            json.dumps({"dependencies": {"@playwright/test": pinned}}), encoding="utf-8")
        (root / ".github" / "workflows").mkdir(parents=True)
        (root / ".github" / "workflows" / "e2e.yml").write_text(
            workflow.format(image=image), encoding="utf-8")
        return root

    def test_repository_image_matches_pinned_version(self) -> None:
        self.assertIsNone(image_mismatch(REPO_ROOT))
        self.assertTrue(shard_image(REPO_ROOT).startswith(
            IMAGE_PREFIX + pinned_version(REPO_ROOT) + "-"))

    def test_matching_scratch_copy_passes(self) -> None:
        self.assertIsNone(image_mismatch(self.scratch("1.62.1", "1.62.1")))

    def test_different_pinned_version_fails_naming_both(self) -> None:
        reason = image_mismatch(self.scratch("1.63.0", "1.62.1"))
        self.assertIsNotNone(reason)
        self.assertIn("1.63.0", reason)
        self.assertIn("1.62.1", reason)

    def test_inline_container_image_is_read(self) -> None:
        workflow = WORKFLOW.replace(
            "    container:\n      image: mcr.microsoft.com/playwright:v{image}-noble\n",
            '    container: {{image: "mcr.microsoft.com/playwright:v{image}-jammy"}}\n')
        root = self.scratch("1.62.1", "1.62.0", workflow)
        self.assertEqual(shard_image(root), "mcr.microsoft.com/playwright:v1.62.0-jammy")
        self.assertIn("1.62.0", image_mismatch(root))

    def test_commented_out_image_is_ignored(self) -> None:
        workflow = WORKFLOW.replace(
            "    container:\n",
            "    container:\n      # image: mcr.microsoft.com/playwright:v1.62.1-noble\n")
        root = self.scratch("1.62.1", "1.62.0", workflow)
        self.assertEqual(shard_image(root), "mcr.microsoft.com/playwright:v1.62.0-noble")
        self.assertIn("1.62.0", image_mismatch(root))

    def test_missing_container_fails(self) -> None:
        workflow = WORKFLOW.replace(
            "    container:\n      image: mcr.microsoft.com/playwright:v{image}-noble\n", "")
        with self.assertRaisesRegex(AssertionError, "no `container:`"):
            image_mismatch(self.scratch("1.62.1", "1.62.1", workflow))


if __name__ == "__main__":
    unittest.main()
