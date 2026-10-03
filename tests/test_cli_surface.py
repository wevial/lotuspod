"""Test suite for the CLI's surface after the Cloudflare Worker's removal.

The Worker, its deploy script, `lotuspod export` (which built its upload) and
`lotuspod responses pull` (which read its database) are gone. This file
witnesses that from the outside: git's own file list, the installed command's
help and usage errors, and the README, docs pages and .gitignore a reader
sees.

Run from the repo root:

    python -m unittest tests.test_cli_surface -v
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SRC_DIR = REPO_ROOT / "src"

REMOVED_PATHS = (
    "worker",
    "deploy/publish.sh",
    "tests/test_publish_script.py",
    "tests/test_export.py",
    "tests/test_responses_pull.py",
    "src/lotuspod/_theme/lotuspod-form.js",
)
COMMANDS = ("render", "manifest", "index", "serve", "publish", "credential", "answers",
            "comments", "audit", "respond", "backup", "restore")
REMOVED_COMMANDS = ("export", "responses")


def run_lotuspod(*argv: str) -> subprocess.CompletedProcess:
    """`python -m lotuspod` from this checkout's src/, never an ambient install."""
    env = dict(os.environ)
    env["PYTHONPATH"] = os.pathsep.join(
        [str(SRC_DIR), *filter(None, [env.get("PYTHONPATH")])]
    )
    return subprocess.run(
        [sys.executable, "-m", "lotuspod", *argv],
        cwd=REPO_ROOT, env=env, capture_output=True, text=True, encoding="utf-8",
    )


class RemovedFilesTests(unittest.TestCase):
    def test_git_tracks_none_of_the_removed_paths(self):
        proc = subprocess.run(
            ["git", "ls-files", "--", *REMOVED_PATHS],
            cwd=REPO_ROOT, capture_output=True, text=True, encoding="utf-8",
        )
        if proc.returncode != 0:
            self.skipTest(f"git unavailable: {proc.stderr.strip()}")
        self.assertEqual(proc.stdout, "")

    def test_git_still_tracks_the_tunnel_files(self):
        proc = subprocess.run(
            ["git", "ls-files", "--", "deploy"],
            cwd=REPO_ROOT, capture_output=True, text=True, encoding="utf-8",
        )
        if proc.returncode != 0:
            self.skipTest(f"git unavailable: {proc.stderr.strip()}")
        self.assertEqual(
            proc.stdout.split(),
            ["deploy/README.md", "deploy/cloudflared.yml", "deploy/lotuspod-backup.service",
             "deploy/lotuspod-backup.timer", "deploy/lotuspod-deploy.py",
             "deploy/lotuspod-health.py", "deploy/lotuspod-respond.service",
             "deploy/lotuspod.service", "deploy/systemd/deploy.env.example",
             "deploy/systemd/lotuspod-deploy.service", "deploy/systemd/lotuspod-deploy.timer"],
        )


class CommandSurfaceTests(unittest.TestCase):
    def test_help_lists_the_commands_and_not_the_removed_ones(self):
        proc = run_lotuspod("--help")
        self.assertEqual(proc.returncode, 0, proc.stderr)
        choices = re.search(r"\{([a-z,]+)\}", proc.stdout)
        self.assertIsNotNone(choices, proc.stdout)
        listed = choices.group(1).split(",")
        self.assertEqual(sorted(listed), sorted(COMMANDS))
        for word in REMOVED_COMMANDS:
            self.assertNotRegex(proc.stdout, rf"\b{word}\b")

    def test_export_is_a_usage_error(self):
        proc = run_lotuspod("export", "--dest", "D")
        self.assertEqual(proc.returncode, 2)
        self.assertIn("usage: lotuspod", proc.stderr)
        self.assertIn("invalid choice: 'export'", proc.stderr)
        self.assertFalse((REPO_ROOT / "D").exists())

    def test_responses_pull_is_a_usage_error(self):
        proc = run_lotuspod("responses", "pull")
        self.assertEqual(proc.returncode, 2)
        self.assertIn("invalid choice: 'responses'", proc.stderr)


class DocumentationTests(unittest.TestCase):
    REMOVED_WORDS = ("export", "responses pull", "wrangler", "worker")
    DOCS = ("README.md", "docs/publishing.md", "docs/comments.md", "docs/agents.md",
            "docs/operating.md", "docs/development.md")

    def read(self, name: str) -> str:
        return (REPO_ROOT / name).read_text(encoding="utf-8")

    def test_readme_docs_and_gitignore_name_nothing_removed(self):
        for name in (*self.DOCS, ".gitignore"):
            text = self.read(name).lower()
            for word in self.REMOVED_WORDS:
                with self.subTest(file=name, word=word):
                    self.assertNotIn(word, text)

    def test_readme_and_docs_document_the_commands(self):
        docs = "\n".join(self.read(name) for name in self.DOCS)
        for command in COMMANDS:
            with self.subTest(command=command):
                self.assertIn(f"lotuspod {command}", docs)

    def test_operating_page_documents_the_tunnel(self):
        operating = self.read("docs/operating.md")
        self.assertIn("## Publish\n", operating)
        self.assertIn("Cloudflare Tunnel", operating)
        self.assertIn("cloudflared tunnel --config deploy/cloudflared.yml run lotuspod", operating)

if __name__ == "__main__":
    unittest.main()
