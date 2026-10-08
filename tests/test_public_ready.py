"""Test suite for the repository as it is published.

The public copy is built from this HEAD, so what is here goes public. This
file witnesses that it is ready: an MIT LICENSE matching the package
metadata, no email address outside the reserved example domains and no home
directory path naming a user in any text file git tracks, a package that
describes Lotuspod as it is today, and a README quick start that installs
from PyPI and publishes on this machine.

Run from the repo root:

    python -m unittest tests.test_public_ready -v
"""

from __future__ import annotations

import re
import subprocess
import sys
import tomllib
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = REPO_ROOT / "src"
sys.path.insert(0, str(SRC_DIR))

import lotuspod  # noqa: E402

EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b")
EMAIL_DOMAINS = ("@example.com", "@example.org")
# A home directory followed by a name; `<user>` and `~` placeholders are not names.
HOME_PATH = re.compile(r"/(?:home|Users)/[A-Za-z0-9_][A-Za-z0-9._-]*")


def tracked_texts() -> dict[str, str]:
    """Every file git tracks that reads as UTF-8 text, by its path."""
    proc = subprocess.run(
        ["git", "ls-files", "-z"], cwd=REPO_ROOT, capture_output=True, check=True,
    )
    texts = {}
    for name in proc.stdout.decode("utf-8").split("\0"):
        path = REPO_ROOT / name
        if not name or not path.is_file():
            continue
        data = path.read_bytes()
        if b"\0" in data:
            continue
        try:
            texts[name] = data.decode("utf-8")
        except UnicodeDecodeError:
            continue
    return texts


def pyproject() -> dict:
    with (REPO_ROOT / "pyproject.toml").open("rb") as handle:
        return tomllib.load(handle)


class LicenseTests(unittest.TestCase):
    def test_license_file_holds_the_mit_text(self):
        text = (REPO_ROOT / "LICENSE").read_text(encoding="utf-8")
        self.assertTrue(text.startswith("MIT License\n"), text[:40])
        self.assertRegex(text, r"Copyright \(c\) \d{4} Ko Vial\n")
        for phrase in (
            "Permission is hereby granted, free of charge, to any person obtaining a copy",
            "The above copyright notice and this permission notice shall be included in all",
            'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND',
        ):
            with self.subTest(phrase=phrase):
                self.assertIn(phrase, text)

    def test_package_metadata_names_the_same_license(self):
        self.assertEqual(pyproject()["project"]["license"], {"text": "MIT"})


class TrackedFileTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.texts = tracked_texts()

    def test_the_files_are_read(self):
        self.assertIn("README.md", self.texts)
        self.assertIn("docs/design/comments-ui-mockup.html", self.texts)

    def test_every_email_address_is_an_example_one(self):
        for name, text in self.texts.items():
            for address in sorted(set(EMAIL.findall(text))):
                with self.subTest(file=name, address=address):
                    self.assertTrue(address.lower().endswith(EMAIL_DOMAINS), address)

    def test_no_home_directory_path_names_a_user(self):
        for name, text in self.texts.items():
            with self.subTest(file=name):
                self.assertEqual(HOME_PATH.findall(text), [])

    def test_the_patterns_tell_names_from_placeholders(self):
        home = "/" + "home/"
        self.assertTrue(HOME_PATH.search(home + "alice/lotuspod"))
        self.assertTrue(HOME_PATH.search("/" + "Users/alice"))
        self.assertIsNone(HOME_PATH.search(home + "<user>/lotuspod"))
        self.assertIsNone(HOME_PATH.search("~/lotuspod"))
        for address in ("reader" + "@example.com", "me" + "@mail.example.net"):
            with self.subTest(address=address):
                self.assertEqual(EMAIL.findall(f"by {address}."), [address])


class DescriptionTests(unittest.TestCase):
    def test_package_metadata_does_not_call_lotuspod_a_podcast(self):
        description = pyproject()["project"]["description"]
        self.assertNotIn("podcast", description.lower())
        self.assertIn("pages people comment on", description)

    def test_package_docstring_does_not_call_lotuspod_a_podcast(self):
        self.assertNotIn("podcast", lotuspod.__doc__.lower())
        self.assertIn("pages people comment on", lotuspod.__doc__)


class QuickStartTests(unittest.TestCase):
    def section(self) -> str:
        readme = (REPO_ROOT / "README.md").read_text(encoding="utf-8")
        start = readme.index("## Quick start\n")
        return readme[start:readme.index("\n## ", start + 1)]

    def test_the_quick_start_publishes_on_this_machine(self):
        commands = [line for line in self.section().splitlines()
                    if line.startswith("lotuspod publish ")]
        self.assertEqual(len(commands), 1, commands)
        self.assertIn(" --local", commands[0])

    def test_the_quick_start_installs_from_pypi(self):
        block = self.section().split("```sh\n", 1)[1].split("\n```", 1)[0]
        installs = [line for line in block.splitlines()
                    if line.split()[:3] == ["pip", "install", "lotuspod"]]
        self.assertEqual(len(installs), 1, block)


if __name__ == "__main__":
    unittest.main()
