"""Check a release tag against the package version and the changelog.

Refuses, naming the problem, a tag that isn't `v` plus the `version` in
`pyproject.toml`, and a `CHANGELOG.md` with no `## X.Y.Z` section for that
version (or one with nothing under its heading). Otherwise prints the
section's body, without its heading, which the release workflow keeps as the
release notes.

Reads the files beside this script's directory, so it checks the checkout it
lives in. Runs on Python 3.9, which has no `tomllib`: there the version is
read by a line match under `[project]`.

Run from the repo root, standard library only:

    python ci/release_check.py v0.1.0 > notes.md
"""

from __future__ import annotations

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TABLE = re.compile(r"^\s*\[([^\]]*)\]\s*(?:#.*)?$")
VERSION_LINE = re.compile(r"""^\s*version\s*=\s*(["'])([^"']*)\1\s*(?:#.*)?$""")
HEADING = re.compile(r"^(#{1,2})(?:\s+(.*?))?\s*$")


def version_from_lines(text: str) -> str | None:
    """The `version = "..."` value in the `[project]` table, by line match."""
    table = None
    for line in text.splitlines():
        match = TABLE.match(line)
        if match:
            table = match.group(1).strip()
            continue
        if table == "project":
            match = VERSION_LINE.match(line)
            if match:
                return match.group(2)
    return None


def read_version(text: str) -> str | None:
    """The project version in a `pyproject.toml`, with `tomllib` when present."""
    try:
        import tomllib
    except ImportError:
        return version_from_lines(text)
    version = tomllib.loads(text).get("project", {}).get("version")
    return version if isinstance(version, str) else None


def changelog_section(text: str, version: str) -> str | None:
    """The body under the `## VERSION` heading, up to the next one, trimmed;
    None when there is no such heading. `## VERSION - DATE` and Keep a
    Changelog's `## [VERSION] - DATE` both count."""
    wanted = re.compile(rf"^\[?{re.escape(version)}\]?(?:\s+-\s+.*)?$")
    body: list[str] | None = None
    for line in text.splitlines():
        match = HEADING.match(line)
        if match:
            if body is not None:
                break
            if match.group(1) == "##" and wanted.match(match.group(2) or ""):
                body = []
        elif body is not None:
            body.append(line)
    return None if body is None else "\n".join(body).strip()


def check(tag: str, root: Path = ROOT) -> str:
    """The release notes for tag, or a RuntimeError naming what is wrong."""
    pyproject = root / "pyproject.toml"
    version = read_version(pyproject.read_text(encoding="utf-8"))
    if not version:
        raise RuntimeError(f"no [project] version in {pyproject.name}")
    if tag != f"v{version}":
        raise RuntimeError(
            f"tag {tag!r} does not match version {version} in {pyproject.name}: "
            f"the tag for it is v{version}"
        )
    changelog = root / "CHANGELOG.md"
    if not changelog.is_file():
        raise RuntimeError(f"no {changelog.name}, so no section for {version}")
    notes = changelog_section(changelog.read_text(encoding="utf-8"), version)
    if notes is None:
        raise RuntimeError(f"{changelog.name} has no '## {version}' section")
    if not notes:
        raise RuntimeError(f"{changelog.name}'s '## {version}' section is empty")
    return notes


def main(argv: list[str]) -> int:
    if len(argv) != 1:
        print("usage: python ci/release_check.py TAG", file=sys.stderr)
        return 2
    try:
        notes = check(argv[0])
    except (OSError, RuntimeError, ValueError) as exc:
        print(f"release check: {exc}", file=sys.stderr)
        return 1
    print(notes)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
