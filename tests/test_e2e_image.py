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
    package = json.loads((root / "e2e" / "package.json").read_text(encoding="utf-8"))
    for key in ("devDependencies", "dependencies"):
        version = package.get(key, {}).get("@playwright/test")
        if version:
            return version
    raise AssertionError("e2e/package.json does not pin @playwright/test")


def shard_image(root: Path) -> str:
    text = (root / ".github" / "workflows" / "e2e.yml").read_text(encoding="utf-8")
    # Drop comment lines and trailing comments, so a commented-out image is not read.
    text = re.sub(r"^[ \t]*#.*\n", "", text, flags=re.MULTILINE)
    text = re.sub(r"[ \t]+#.*$", "", text, flags=re.MULTILINE)
    job = re.search(r"^  e2e-shard:[ \t]*\n((?:    .*\n|[ \t]*\n)*)", text, re.MULTILINE)
    if job is None:
        raise AssertionError("no `e2e-shard` job in the e2e workflow")
    container = re.search(
        r"^    container:[ \t]*(.*)\n((?:      .*\n|[ \t]*\n)*)", job.group(1), re.MULTILINE)
    if container is None:
        raise AssertionError("the `e2e-shard` job has no `container:`")
    inline, nested = container.group(1).strip(), container.group(2)
    # Only `container.image` itself, not a key nested deeper such as `env.base_image`.
    image = (re.search(r"^      image:[ \t]*[\"']?([^\"'\s]+)", nested, re.MULTILINE)
             or re.fullmatch(r"[\"']?([^\"'\s{]+)[\"']?", inline))
    if image is not None:
        return image.group(1)
    if inline.startswith("{"):
        for entry in top_level_entries(inline):
            own = re.fullmatch(r"image:\s*[\"']?([^\"'\s]+?)[\"']?", entry)
            if own:
                return own.group(1)
    raise AssertionError("the `e2e-shard` container names no image")


def top_level_entries(mapping: str) -> list[str]:
    """The entries of an inline `{...}` mapping, without those of mappings nested in it."""
    entries, depth, quote, start = [], 0, "", 1
    for index, char in enumerate(mapping):
        if quote:
            quote = "" if char == quote else quote
        elif char in "\"'":
            quote = char
        elif char in "{[":
            depth += 1
        elif char in "}]":
            depth -= 1
            if depth == 0:
                entries.append(mapping[start:index].strip())
                break
        elif char == "," and depth == 1:
            entries.append(mapping[start:index].strip())
            start = index + 1
    return entries


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
        reason = image_mismatch(REPO_ROOT)
        if reason:
            self.fail(reason)

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

    def test_commented_out_image_is_ignored(self) -> None:
        workflow = WORKFLOW.replace(
            "    container:\n",
            "    container:\n      # image: mcr.microsoft.com/playwright:v1.62.1-noble\n")
        root = self.scratch("1.62.1", "1.62.0", workflow)
        self.assertEqual(shard_image(root), "mcr.microsoft.com/playwright:v1.62.0-noble")

    def test_nested_image_key_under_container_is_ignored(self) -> None:
        workflow = WORKFLOW.replace(
            "    container:\n",
            "    container:\n      env:\n"
            "        base_image: mcr.microsoft.com/playwright:v1.62.1-noble\n")
        root = self.scratch("1.62.1", "1.61.0", workflow)
        self.assertEqual(shard_image(root), "mcr.microsoft.com/playwright:v1.61.0-noble")
        self.assertIn("1.61.0", image_mismatch(root))

    def test_inline_nested_image_key_is_ignored(self) -> None:
        workflow = WORKFLOW.replace(
            "    container:\n      image: mcr.microsoft.com/playwright:v{image}-noble\n",
            "    container: {{env: {{FOO: x, image: mcr.microsoft.com/playwright:v1.62.1-noble}},"
            " image: mcr.microsoft.com/playwright:v{image}-noble}}\n")
        root = self.scratch("1.62.1", "1.61.0", workflow)
        self.assertEqual(shard_image(root), "mcr.microsoft.com/playwright:v1.61.0-noble")
        self.assertIn("1.61.0", image_mismatch(root))

    def test_blank_line_inside_container_is_allowed(self) -> None:
        workflow = WORKFLOW.replace("    container:\n", "    container:\n\n")
        root = self.scratch("1.62.1", "1.62.1", workflow)
        self.assertEqual(shard_image(root), "mcr.microsoft.com/playwright:v1.62.1-noble")

    def test_missing_container_fails(self) -> None:
        workflow = WORKFLOW.replace(
            "    container:\n      image: mcr.microsoft.com/playwright:v{image}-noble\n", "")
        with self.assertRaisesRegex(AssertionError, "no `container:`"):
            image_mismatch(self.scratch("1.62.1", "1.62.1", workflow))


if __name__ == "__main__":
    unittest.main()
