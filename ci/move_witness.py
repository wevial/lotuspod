"""Witness that a move changed nothing a reader, a command or a test sees.

Extracts the merge base with origin/main (`git merge-base HEAD origin/main`)
with `git archive` into a temporary directory and compares that tree with the
working tree, each run with its own src/ first on PYTHONPATH and
LOTUSPOD_CONFIG naming a missing file:

- the bytes of the served lotuspod.css, lotuspod-page.js and
  lotuspod-index.js after one page is rendered with each tree's own
  `lotuspod render`, each `// Built from SOURCE by web/build.ts` marker line
  read with SOURCE cut to its file name, since moving a TypeScript source
  changes only that line;
- the text of `lotuspod --help` and of each subcommand's `--help`, at any
  depth;
- the discovered test names: unittest's Class.method ids and Playwright's
  `--list` titles for each e2e/*.config.ts, each without its file path, as
  multisets. A name may be discovered more often here than at the merge base
  only by as many times as test files the merge base lacks declare it, so a
  move ticket may add a test module; those names are listed.

Prints each difference and exits 1, else prints the counts it compared and
exits 0. Every move ticket runs it from the repo root:

    python -m ci.move_witness
"""

from __future__ import annotations

import collections
import difflib
import io
import os
import re
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
SERVED = ("lotuspod.css", "lotuspod-page.js", "lotuspod-index.js")
MARKER = re.compile(rb"^(// Built from )(\S+)( by web/build\.ts\..*)$", re.M)
# The positional line argparse prints for a command's subcommands.
SUBCOMMANDS = re.compile(r"^  \{([a-z][\w-]*(?:,[a-z][\w-]*)*)\}", re.M)
# A Playwright --list line: [project] › FILE:LINE:COLUMN › titles.
LISTED = re.compile(r"^\s*(\[[^\]]+\]) › (\S+):\d+:\d+ › (.+)$")
PAGE_BODY = ('<h2>One</h2><p>A <a href="https://example.com/">link</a>.</p>'
             "<h2>Two</h2><p>The second section.</p>")
UNITTEST_NAMES = """
import unittest

def tests(suite):
    for test in suite:
        if isinstance(test, unittest.TestSuite):
            yield from tests(test)
        else:
            yield test

for test in tests(unittest.defaultTestLoader.discover("tests", top_level_dir=".")):
    module = type(test).__module__.replace(".", "/") + ".py"
    print(f"{module} {type(test).__name__}.{test._testMethodName}")
"""


def git(*argv: str) -> str:
    return subprocess.run(["git", *argv], cwd=REPO_ROOT, check=True, capture_output=True,
                          text=True).stdout.strip()


def extract_merge_base(into: Path) -> str:
    base = git("merge-base", "HEAD", "origin/main")
    archive = subprocess.run(["git", "archive", "--format=tar", base], cwd=REPO_ROOT,
                             check=True, capture_output=True).stdout
    with tarfile.open(fileobj=io.BytesIO(archive)) as tar:
        if hasattr(tarfile, "data_filter"):
            tar.extractall(into, filter="data")
        else:
            tar.extractall(into)
    return base


class Tree:
    """One tree's lotuspod: its own src/ first on PYTHONPATH."""

    def __init__(self, label: str, root: Path, missing_config: Path) -> None:
        self.label = label
        self.root = root
        self.env = dict(os.environ, COLUMNS="100", LOTUSPOD_CONFIG=str(missing_config),
                        PYTHONPATH=os.pathsep.join(
                            [str(root / "src"), *filter(None, [os.environ.get("PYTHONPATH")])]))

    def run(self, *argv: str, cwd: Path | None = None) -> subprocess.CompletedProcess:
        return subprocess.run(list(argv), cwd=cwd or self.root, env=self.env,
                              capture_output=True, text=True)

    def lotuspod(self, *argv: str) -> subprocess.CompletedProcess:
        return self.run(sys.executable, "-m", "lotuspod", *argv)

    def served(self, out_dir: Path) -> dict[str, bytes]:
        """Each served file's bytes after one page is rendered here."""
        done = self.lotuspod("render", "--name", "witness", "--title", "Witness",
                             "--date", "2026-01-02", "--body", PAGE_BODY,
                             "--out-dir", str(out_dir))
        if done.returncode != 0:
            raise RuntimeError(f"{self.label}: lotuspod render failed: {done.stderr.strip()}")
        return {name: (out_dir / name).read_bytes() for name in SERVED}

    def helps(self) -> dict[str, str]:
        """`lotuspod ... --help` text by command, for every subcommand."""
        found: dict[str, str] = {}
        pending = [()]
        while pending:
            command = pending.pop(0)
            done = self.lotuspod(*command, "--help")
            found[" ".join(("lotuspod", *command))] = \
                f"exit {done.returncode}\n{done.stdout}{done.stderr}"
            listed = SUBCOMMANDS.search(done.stdout)
            if listed:
                pending += [(*command, name) for name in listed.group(1).split(",")]
        return found

    def unittest_names(self) -> collections.Counter:
        """(file, Class.method) for each discovered test."""
        done = self.run(sys.executable, "-c", UNITTEST_NAMES)
        if done.returncode != 0:
            raise RuntimeError(f"{self.label}: unittest discovery failed: {done.stderr.strip()}")
        return collections.Counter(tuple(line.split(" ", 1)) for line in done.stdout.splitlines()
                                   if line)

    def playwright_titles(self, playwright: Path, stylesheet: bytes) -> collections.Counter:
        """(file, title) for every e2e config's --list titles. The checks read the joined
        stylesheet from the theme, where tests.capture_site writes it while
        they run, so it is written there for the listing too."""
        css = self.root / "src" / "lotuspod" / "_theme" / "lotuspod.css"
        kept = css.read_bytes() if css.exists() else None
        css.write_bytes(stylesheet)
        titles: collections.Counter = collections.Counter()
        try:
            for config in sorted((self.root / "e2e").glob("*.config.ts")):
                done = self.run(str(playwright), "test", "--config", str(config), "--list",
                                cwd=self.root / "e2e")
                if done.returncode != 0:
                    raise RuntimeError(f"{self.label}: playwright --list {config.name} failed:\n"
                                       f"{done.stdout}{done.stderr}")
                for line in done.stdout.splitlines():
                    listed = LISTED.match(line)
                    if listed:
                        titles[(listed.group(2),
                                f"{config.name} {listed.group(1)} › {listed.group(3)}")] += 1
        finally:
            if kept is None:
                css.unlink()
            else:
                css.write_bytes(kept)
        return titles


def unmarked(data: bytes) -> bytes:
    """data with each build marker's SOURCE cut to its file name."""
    return MARKER.sub(lambda m: m.group(1) + m.group(2).rsplit(b"/", 1)[-1] + m.group(3), data)


def in_tree(files: set[str], path: str) -> bool:
    """Whether the tree whose tracked files are files has the test file at
    path: a unittest module's path from the root, or a Playwright spec's from
    its config's testDir under e2e/."""
    return path in files or any(name.startswith("e2e/") and name.endswith("/" + path)
                                for name in files)


def multiset_differences(kind: str, before: collections.Counter, after: collections.Counter,
                         base_files: set[str]) -> tuple[list[str], list[str]]:
    """The differences between before's and after's names, each counted
    without its file, and the names after adds from test files the merge
    base lacks, which are allowed."""
    old: collections.Counter = collections.Counter()
    new: collections.Counter = collections.Counter()
    added: collections.Counter = collections.Counter()
    added_in: dict[str, set[str]] = collections.defaultdict(set)
    for (_, name), count in before.items():
        old[name] += count
    for (path, name), count in after.items():
        new[name] += count
        if not in_tree(base_files, path):
            added[name] += count
            added_in[name].add(path)
    lines, allowed = [], []
    for name in sorted(set(old) | set(new)):
        if old[name] == new[name]:
            continue
        if old[name] < new[name] <= old[name] + added[name]:
            allowed.append(f"{kind}: {name!r} is added by {', '.join(sorted(added_in[name]))}")
        else:
            lines.append(f"{kind}: {name!r} is discovered {old[name]} time(s) at the merge "
                         f"base and {new[name]} time(s) here")
    return lines, allowed


def main() -> int:
    playwright = REPO_ROOT / "e2e" / "node_modules" / ".bin" / "playwright"
    if not playwright.exists():
        print(f"move witness: {playwright} is missing: npm --prefix e2e ci", file=sys.stderr)
        return 2
    with tempfile.TemporaryDirectory(prefix="lotuspod-witness-") as scratch:
        scratch = Path(scratch)
        base_root = scratch / "base"
        base = extract_merge_base(base_root)
        base_files = set(git("ls-tree", "-r", "--name-only", base).splitlines())
        (base_root / "e2e" / "node_modules").symlink_to(REPO_ROOT / "e2e" / "node_modules")
        missing = scratch / "no-such-config.ini"
        trees = (Tree(f"merge base {base[:12]}", base_root, missing),
                 Tree("working tree", REPO_ROOT, missing))
        results = []
        for number, tree in enumerate(trees):
            served = tree.served(scratch / f"site-{number}")
            results.append({
                "served": served,
                "helps": tree.helps(),
                "unittest": tree.unittest_names(),
                "playwright": tree.playwright_titles(playwright, served["lotuspod.css"]),
            })
    before, after = results
    differences = []
    for name in SERVED:
        old, new = unmarked(before["served"][name]), unmarked(after["served"][name])
        if old != new:
            at = next((i for i, (a, b) in enumerate(zip(old, new)) if a != b), min(len(old), len(new)))
            differences.append(f"served {name}: differs from the merge base's from byte {at}")
    for command in sorted(set(before["helps"]) | set(after["helps"])):
        old, new = before["helps"].get(command), after["helps"].get(command)
        if old != new:
            diff = difflib.unified_diff((old or "").splitlines(), (new or "").splitlines(),
                                        "merge base", "working tree", lineterm="", n=1)
            differences.append(f"`{command} --help` reads differently:\n" + "\n".join(diff))
    added = []
    for kind in ("unittest", "playwright"):
        lines, allowed = multiset_differences(kind, before[kind], after[kind], base_files)
        differences += lines
        added += allowed
    for line in added:
        print(line)
    if differences:
        for line in differences:
            print(line)
        print(f"move witness: {len(differences)} difference(s) from merge base {base}")
        return 1
    print(f"move witness: the same as merge base {base}: {len(SERVED)} served files, "
          f"{len(after['helps'])} help texts, {sum(after['unittest'].values())} unittest names "
          f"and {sum(after['playwright'].values())} Playwright titles")
    return 0


if __name__ == "__main__":
    sys.exit(main())
