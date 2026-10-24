"""Test suite for the entry point's command discovery: each slice's
commands.py registers its subcommands in a COMMANDS tuple of (slot, register)
pairs, and lotuspod.cli finds them by walking src/lotuspod/features/, so a new
slice's command is a new file and nothing else.

Run from the repo root:

    python -m unittest tests.test_cli_commands -v
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
PACKAGE_DIR = REPO_ROOT / "src" / "lotuspod"
sys.path.insert(0, str(REPO_ROOT / "src"))

from lotuspod import cli  # noqa: E402

HELLO = textwrap.dedent('''\
    """The hello slice's one command."""

    import argparse


    def add_parser(sub: argparse._SubParsersAction) -> None:
        hello = sub.add_parser("hello", help="say hello")
        hello.set_defaults(func=lambda args: print("hello") or 0)


    COMMANDS = ((95, add_parser),)
''')


def files(root: Path) -> dict[str, bytes]:
    """Each file under root, by its path there, with its bytes."""
    return {path.relative_to(root).as_posix(): path.read_bytes()
            for path in root.rglob("*") if path.is_file() and "__pycache__" not in path.parts}


class DiscoveryTests(unittest.TestCase):
    def test_the_commands_are_registered_in_slot_order(self):
        slots = [slot for slot, _ in cli.registrations()]
        self.assertEqual(slots, sorted(slots))
        self.assertEqual(len(slots), len(set(slots)))
        found = {path.parent.name for path in cli.FEATURES_DIR.glob("*/commands.py")}
        self.assertIn("publish", found)
        self.assertIn("serve", found)

    def test_a_new_slices_commands_module_adds_its_command(self):
        """A copy of the package with a new slice folder holding only its
        commands module: the copy's `lotuspod --help` lists the command, and
        `lotuspod hello` runs it."""
        scratch = Path(self.enterContext(tempfile.TemporaryDirectory()))
        copy = scratch / "src" / "lotuspod"
        shutil.copytree(PACKAGE_DIR, copy, ignore=shutil.ignore_patterns("__pycache__"))
        (copy / "features" / "hello").mkdir()
        (copy / "features" / "hello" / "commands.py").write_text(HELLO, encoding="utf-8")
        added = files(copy)
        self.assertEqual(sorted(set(added) - set(files(PACKAGE_DIR))), ["features/hello/commands.py"])
        self.assertEqual({name: data for name, data in added.items()
                          if name != "features/hello/commands.py"}, files(PACKAGE_DIR))

        env = dict(os.environ, PYTHONPATH=str(scratch / "src"),
                   LOTUSPOD_CONFIG=str(scratch / "no-such-config.ini"))
        shown = subprocess.run([sys.executable, "-m", "lotuspod", "--help"], cwd=scratch,
                               env=env, capture_output=True, text=True)
        self.assertEqual(shown.returncode, 0, shown.stderr)
        self.assertRegex(shown.stdout, r"(?m)^    hello +say hello$")
        self.assertIn(",unarchive,hello}", shown.stdout)
        ran = subprocess.run([sys.executable, "-m", "lotuspod", "hello"], cwd=scratch, env=env,
                             capture_output=True, text=True)
        self.assertEqual((ran.returncode, ran.stdout), (0, "hello\n"), ran.stderr)

    def test_two_commands_at_one_slot_are_refused(self):
        scratch = Path(self.enterContext(tempfile.TemporaryDirectory()))
        copy = scratch / "src" / "lotuspod"
        shutil.copytree(PACKAGE_DIR, copy, ignore=shutil.ignore_patterns("__pycache__"))
        (copy / "features" / "hello").mkdir()
        (copy / "features" / "hello" / "commands.py").write_text(
            HELLO.replace("(95, add_parser)", "(10, add_parser)"), encoding="utf-8")
        env = dict(os.environ, PYTHONPATH=str(scratch / "src"),
                   LOTUSPOD_CONFIG=str(scratch / "no-such-config.ini"))
        shown = subprocess.run([sys.executable, "-m", "lotuspod", "--help"], cwd=scratch,
                               env=env, capture_output=True, text=True)
        self.assertNotEqual(shown.returncode, 0)
        self.assertIn("registers a command at slot 10", shown.stderr)


if __name__ == "__main__":
    unittest.main()
