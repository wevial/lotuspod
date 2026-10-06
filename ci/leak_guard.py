"""Fail a diff that adds a personal or host value.

Scans the lines `git diff BASE HEAD` adds to text files against two layers of
rules: generic ones kept here (emails, home directory paths, tailnet
addresses and names, private-key headers), and private literal patterns read
from the `LEAK_PATTERNS` environment variable, one per line, which are never
kept in the repository.

A hit prints only `PATH:LINE: RULE`, never text from the line or a pattern,
since the CI logs are public. The run ends with one summary line, and exits 1
on any hit and 0 otherwise.

Run from the repo root, standard library only:

    python ci/leak_guard.py BASE HEAD
"""

from __future__ import annotations

import os
import re
import subprocess
import sys

EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b")
EMAIL_DOMAINS = ("@example.com", "@example.org", "@users.noreply.github.com")
# A home directory followed by a name; `<user>` and `~` placeholders are not names.
HOME_MACOS = re.compile(r"/Users/[A-Za-z0-9_][A-Za-z0-9._-]*")
HOME_LINUX = re.compile(r"/home/([A-Za-z0-9_][A-Za-z0-9._-]*)")
HOME_LINUX_PLACEHOLDER = "writer"
TAILNET_IP = re.compile(r"(?<![\d.])100\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})(?!\.?\d)")
TAILNET_IPS = ("100.64.0.0", "100.64.0.1")
TAILNET_NAME = re.compile(r"[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.ts\.net\b", re.IGNORECASE)
PRIVATE_KEY = re.compile(r"-----BEGIN[A-Z0-9 ]*PRIVATE KEY")

HUNK = re.compile(r"^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@")


def _email(line: str) -> bool:
    return any(not address.lower().endswith(EMAIL_DOMAINS)
               for address in EMAIL.findall(line))


def _home_macos(line: str) -> bool:
    return HOME_MACOS.search(line) is not None


def _home_linux(line: str) -> bool:
    return any(name != HOME_LINUX_PLACEHOLDER for name in HOME_LINUX.findall(line))


def _tailnet_ip(line: str) -> bool:
    for match in TAILNET_IP.finditer(line):
        if all(int(octet) <= 255 for octet in match.groups()) \
                and match.group(0) not in TAILNET_IPS:
            return True
    return False


def _tailnet_name(line: str) -> bool:
    return TAILNET_NAME.search(line) is not None


def _private_key(line: str) -> bool:
    return PRIVATE_KEY.search(line) is not None


GENERIC_RULES = (
    ("email", _email),
    ("home-macos", _home_macos),
    ("home-linux", _home_linux),
    ("tailnet-ip", _tailnet_ip),
    ("tailnet-name", _tailnet_name),
    ("private-key", _private_key),
)


def private_patterns(value: str | None) -> list[str]:
    """The private patterns in `LEAK_PATTERNS`: one per line, trimmed, blanks dropped."""
    return [line.strip().casefold() for line in (value or "").splitlines() if line.strip()]


def rule_hits(line: str, patterns: list[str]) -> list[str]:
    """The ids of the rules `line` breaks, generic ones first."""
    hits = [rule for rule, breaks in GENERIC_RULES if breaks(line)]
    folded = line.casefold()
    hits += [f"private-{number}" for number, pattern in enumerate(patterns, start=1)
             if pattern in folded]
    return hits


def _unquote(path: str) -> str:
    """A path as git prints it in a header, with C-style quoting undone."""
    if len(path) >= 2 and path.startswith('"') and path.endswith('"'):
        raw = path[1:-1].encode("ascii", "replace").decode("unicode_escape")
        return raw.encode("latin-1").decode("utf-8", "replace")
    return path


def added_lines(diff: str):
    """Yield `(path, line number in the new file, text)` for each added line."""
    path = None
    number = 0
    in_hunk = False
    for line in diff.split("\n"):
        if line.startswith("diff --git "):
            path, in_hunk = None, False
        elif not in_hunk and line.startswith("+++ "):
            target = _unquote(line[4:].rstrip("\t"))
            path = target[2:] if target.startswith("b/") else None
        elif line.startswith("@@"):
            match = HUNK.match(line)
            in_hunk = match is not None
            number = int(match.group(1)) if match else 0
        elif in_hunk and line.startswith("+"):
            if path is not None:
                yield path, number, line[1:]
            number += 1


def _plural(count: int, noun: str) -> str:
    return f"{count} {noun}" if count == 1 else f"{count} {noun}s"


def main(argv: list[str]) -> int:
    if len(argv) != 2:
        print("usage: python ci/leak_guard.py BASE HEAD", file=sys.stderr)
        return 2
    base, head = argv
    patterns = private_patterns(os.environ.get("LEAK_PATTERNS"))
    proc = subprocess.run(
        ["git", "-c", "core.quotePath=true", "diff", "--no-color", "--no-ext-diff",
         "--no-textconv", "--src-prefix=a/", "--dst-prefix=b/", "--unified=0",
         base, head, "--"],
        capture_output=True,
    )
    if proc.returncode != 0:
        print(f"leak guard: git diff {base} {head} failed (exit {proc.returncode})",
              file=sys.stderr)
        return 2
    hits = 0
    for path, number, text in added_lines(proc.stdout.decode("utf-8", "replace")):
        for rule in rule_hits(text, patterns):
            print(f"{path}:{number}: {rule}")
            hits += 1
    print(f"leak guard: scanned {base}..{head}, "
          f"{_plural(len(patterns), 'private pattern')}, {_plural(hits, 'hit')}")
    return 1 if hits else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
