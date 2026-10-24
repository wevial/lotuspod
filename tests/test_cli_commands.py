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
from typing import Callable

REPO_ROOT = Path(__file__).resolve().parents[1]
PACKAGE_DIR = REPO_ROOT / "src" / "lotuspod"

HELLO = textwrap.dedent('''\
    """The hello slice's one command."""

    import argparse


    def add_parser(sub: argparse._SubParsersAction) -> None:
        hello = sub.add_parser("hello", help="say hello")
        hello.set_defaults(func=lambda args: print("hello") or 0)


    COMMANDS = ((95, add_parser),)
''')


class DiscoveryTests(unittest.TestCase):
    def copy_with_hello(self, commands: str) -> Callable[..., subprocess.CompletedProcess]:
        """A copy of the package with a hello slice holding only commands as
        its commands module, and a function running the copy's `lotuspod`."""
        scratch = Path(self.enterContext(tempfile.TemporaryDirectory()))
        copy = scratch / "src" / "lotuspod"
        shutil.copytree(PACKAGE_DIR, copy, ignore=shutil.ignore_patterns("__pycache__"))
        (copy / "features" / "hello").mkdir()
        (copy / "features" / "hello" / "commands.py").write_text(commands, encoding="utf-8")
        env = dict(os.environ, PYTHONPATH=str(scratch / "src"),
                   LOTUSPOD_CONFIG=str(scratch / "no-such-config.ini"))
        return lambda *argv: subprocess.run([sys.executable, "-m", "lotuspod", *argv], cwd=scratch,
                                            env=env, capture_output=True, text=True)

    def test_a_new_slices_commands_module_adds_its_command(self):
        """A copy of the package with a new slice folder holding only its
        commands module: the copy's `lotuspod --help` lists the command, and
        `lotuspod hello` runs it."""
        run = self.copy_with_hello(HELLO)
        shown = run("--help")
        self.assertEqual(shown.returncode, 0, shown.stderr)
        self.assertRegex(shown.stdout, r"(?m)^    hello +say hello$")
        self.assertIn(",unarchive,hello}", shown.stdout)
        ran = run("hello")
        self.assertEqual((ran.returncode, ran.stdout), (0, "hello\n"), ran.stderr)

    def test_two_commands_at_one_slot_are_refused(self):
        shown = self.copy_with_hello(HELLO.replace("(95, add_parser)", "(10, add_parser)"))("--help")
        self.assertNotEqual(shown.returncode, 0)
        self.assertIn("registers a command at slot 10", shown.stderr)


if __name__ == "__main__":
    unittest.main()
