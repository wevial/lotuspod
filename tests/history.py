"""Read a file as a commit in the repository's history left it.

`show(commit, path)` is `git show COMMIT:PATH`, for tests that compare the
tree with a pinned older one. A shallow clone lacks the history, so there the
test skips. Anywhere else a pinned commit must be an ancestor of HEAD: an id
the history no longer holds fails the test, even when a clone's pack still
has the object (one repointed from a rewritten history, say).
"""

from __future__ import annotations

import subprocess
import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]


def _git(repo: Path, *args: str) -> subprocess.CompletedProcess:
    return subprocess.run(["git", *args], cwd=repo, capture_output=True,
                          text=True, encoding="utf-8")


def show(commit: str, path: str, *, repo: Path = REPO_ROOT) -> str:
    """The text of path at commit; skips in a shallow clone, else fails
    unless commit is an ancestor of HEAD and the file reads."""
    shallow = _git(repo, "rev-parse", "--is-shallow-repository")
    if shallow.stdout.strip() == "true":
        raise unittest.SkipTest(f"the clone is shallow, so {commit} may be missing from its history")
    ancestry = _git(repo, "merge-base", "--is-ancestor", commit, "HEAD")
    if ancestry.returncode != 0:
        detail = ancestry.stderr.strip()
        raise AssertionError(f"pinned commit {commit} is not an ancestor of HEAD"
                             + (f": {detail}" if detail else ""))
    proc = _git(repo, "show", f"{commit}:{path}")
    if proc.returncode != 0:
        raise AssertionError(f"cannot read {commit}:{path}: {proc.stderr.strip()}")
    return proc.stdout
