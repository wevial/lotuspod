"""Decide whether the `e2e` check runs its shards on a diff.

Lists the paths `git diff --name-only --no-renames BASE HEAD` changes, so a
file moved out of `src/` counts its old path too, and prints `run=false` when
there is at least one path and every one is docs-only, and `run=true`
otherwise. When the checks run because of a path, the first such path is
named on stderr.

Docs-only means under `docs/`, a `.md` file at the repository root or under
`deploy/`, or `LICENSE`. Nothing else is: the sample site is built from
`tests/fixtures/`, and the specs read `src/`, `e2e/` and `web/` output, so
markdown anywhere else runs the checks. An empty diff runs them too.

Run from the repo root, standard library only:

    python ci/e2e_scope.py BASE HEAD
"""

from __future__ import annotations

import subprocess
import sys


def docs_only(path: str) -> bool:
    if path == "LICENSE" or path.startswith("docs/"):
        return True
    if not path.endswith(".md"):
        return False
    return "/" not in path or path.startswith("deploy/")


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: python ci/e2e_scope.py BASE HEAD", file=sys.stderr)
        return 2
    base, head = argv
    proc = subprocess.run(
        ["git", "-c", "core.quotePath=false", "diff", "--name-only", "--no-renames",
         "-z", base, head, "--"],
        capture_output=True,
    )
    if proc.returncode != 0:
        print(f"e2e scope: git diff {base} {head} failed (exit {proc.returncode})",
              file=sys.stderr)
        return 2
    paths = [raw.decode("utf-8", "replace") for raw in proc.stdout.split(b"\0") if raw]
    if not paths:
        print("e2e scope: no changed paths, running the checks", file=sys.stderr)
        print("run=true")
        return 0
    for path in paths:
        if not docs_only(path):
            print(f"e2e scope: {path} is not docs-only, running the checks",
                  file=sys.stderr)
            print("run=true")
            return 0
    print(f"e2e scope: all {len(paths)} changed paths are docs-only, skipping the checks",
          file=sys.stderr)
    print("run=false")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
