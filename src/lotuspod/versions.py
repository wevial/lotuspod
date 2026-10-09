"""A page's earlier versions, read from the artifacts repository.

Every publish commits the output directory when it is the top of its own git
repository (cli.commit_output), so each commit that changed NAME.html is a
version of the page. They are read at request time, with nothing stored:

    git log --raw over NAME.html   the commits that changed it, newest first,
                                   each naming the page's blob, at most
                                   MAX_VERSIONS of them
    git cat-file --batch           the blobs not read before, in one process

From each blob only its lotuspod:revision and lotuspod:visible are kept, in
memory by blob id: a blob never changes. A list runs at most two git
processes, and one once its blobs are known; an old version's HTML runs at
most two. A version is listed only when its own page was visible, and a
directory that is not the top of its own repository has none.

old_page() is a version's HTML as serve answers it: marked as old, with a
banner linking back to the current page, and its decision forms disabled.
"""

from __future__ import annotations

import datetime as _dt
import html
import os
import re
import subprocess
import threading
import urllib.parse
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

# The versions of one page a list reads, newest first.
MAX_VERSIONS = 200
# Seconds one git process may take.
GIT_TIMEOUT = 10
# A version's commit as a URL names it: the full object id.
COMMIT = re.compile(r"[0-9a-f]{40}")

_NO_BLOB = "0" * 40
_MAIN_OPEN_RE = re.compile(r'<main class="([^"]*)"([^>]*)>')
_DECISION_FORM_RE = re.compile(r'<form class="artifact-decision[\s"]')
_FIELDSET_RE = re.compile(r"<fieldset(?=[\s>])")


def git_environment() -> dict[str, str]:
    """The environment every git process runs in: never asking for a password."""
    return {**os.environ, "GIT_TERMINAL_PROMPT": "0"}


@dataclass(frozen=True)
class Version:
    """One commit that changed a page."""

    commit: str
    # The commit's committer time, UTC, as publish stamps a page.
    date: str
    revision: str
    visible: bool


def _utc(stamp: str) -> str:
    try:
        moment = _dt.datetime.fromisoformat(stamp)
    except ValueError:
        return ""
    return moment.astimezone(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class History:
    """The versions of the pages in out_dir. stamp(page_html) is a page's
    (lotuspod:revision, lotuspod:visible), read from its HTML."""

    def __init__(self, out_dir: Path, stamp: Callable[[str], tuple[str, bool]]) -> None:
        self.out_dir = Path(out_dir)
        self.stamp = stamp
        # Blob ids to what stamp read from them.
        self._stamps: dict[str, tuple[str, bool]] = {}
        self._lock = threading.Lock()

    def _git(self, *argv: str, data: bytes | None = None) -> bytes | None:
        """git's output in out_dir; None when it failed or took too long."""
        # The top of a repository holds its .git; below the parent no
        # repository is looked for, so a directory inside another's has none.
        if not (self.out_dir / ".git").exists():
            return None
        env = {**git_environment(), "GIT_CEILING_DIRECTORIES": str(self.out_dir.resolve().parent),
               "GIT_LITERAL_PATHSPECS": "1"}
        try:
            done = subprocess.run(["git", "-C", str(self.out_dir), *argv], input=data,
                                  capture_output=True, env=env, timeout=GIT_TIMEOUT)
        except (OSError, subprocess.SubprocessError):
            return None
        return done.stdout if done.returncode == 0 else None

    def _commits(self, name: str) -> list[tuple[str, str, str]]:
        """(commit, date, blob) for each commit that left NAME.html in place,
        newest first."""
        out = self._git("log", "--format=%H%x09%cI", "--raw", "--no-abbrev", "--no-renames",
                        f"--max-count={MAX_VERSIONS}", "--", f"{name}.html")
        if out is None:
            return []
        found: list[tuple[str, str, str]] = []
        commit = date = ""
        for line in out.decode("utf-8", "replace").splitlines():
            head, _, rest = line.partition("\t")
            if COMMIT.fullmatch(head):
                commit, date = head, _utc(rest.strip())
            elif line.startswith(":") and commit:
                fields = head.split()
                # :OLDMODE NEWMODE OLD NEW STATUS; a deleted page's NEW is zeros.
                if len(fields) == 5 and COMMIT.fullmatch(fields[3]) and fields[3] != _NO_BLOB:
                    found.append((commit, date, fields[3]))
                commit = ""
        return found

    def _read(self, blobs: list[str], keep: str = "") -> str | None:
        """Read the blobs whose stamps are not known yet, and keep too, in
        one process; keep's text (None when it was not read)."""
        with self._lock:
            wanted = [blob for blob in dict.fromkeys(blobs) if blob not in self._stamps]
        if keep and keep not in wanted:
            wanted.append(keep)
        if not wanted:
            return None
        asked = "".join(f"{blob}\n" for blob in wanted).encode("ascii")
        out = self._git("cat-file", "--batch", data=asked)
        if out is None:
            return None
        kept = None
        at = 0
        while at < len(out):
            end = out.find(b"\n", at)
            if end < 0:
                break
            header = out[at:end].split()
            at = end + 1
            if len(header) != 3 or header[1] != b"blob" or not header[2].isdigit():
                continue
            size = int(header[2])
            text = out[at:at + size].decode("utf-8", "replace")
            at += size + 1
            blob = header[0].decode("ascii", "replace")
            stamp = self.stamp(text)
            with self._lock:
                self._stamps[blob] = stamp
            if blob == keep:
                kept = text
        return kept

    def _versions(self, commits: list[tuple[str, str, str]],
                  keep: str = "") -> tuple[list[Version], str | None]:
        """The visible versions among commits, and keep's text."""
        kept = self._read([blob for _, _, blob in commits], keep)
        with self._lock:
            stamps = dict(self._stamps)
        listed = [Version(commit, date, *stamps[blob])
                  for commit, date, blob in commits if blob in stamps]
        return [version for version in listed if version.visible], kept

    def listed(self, name: str) -> list[Version]:
        """NAME's visible versions, newest first."""
        return self._versions(self._commits(name))[0]

    def version(self, name: str, commit: str) -> tuple[Version, int, str] | None:
        """NAME's version at commit, how many listed versions are newer, and
        its HTML; None unless it is one of NAME's listed versions."""
        if not COMMIT.fullmatch(commit):
            return None
        commits = self._commits(name)
        blob = next((blob for found, _, blob in commits if found == commit), "")
        if not blob:
            return None
        listed, text = self._versions(commits, keep=blob)
        for behind, version in enumerate(listed):
            if version.commit == commit and text is not None:
                return version, behind, text
        return None


def _shown_date(stamp: str) -> str:
    """A UTC stamp as the banner says it: 2026-09-10 14:05 UTC."""
    return f"{stamp[:10]} {stamp[11:16]} UTC" if len(stamp) >= 16 else stamp


def _disable_forms(page_html: str, current: str) -> str:
    """Each decision form's fieldset disabled, and a note after it saying
    where to answer."""
    note = ('<p class="artifact-version-note">Answering is off on old versions. '
            f'<a href="{current}">Answer on the current page.</a></p>')
    parts: list[str] = []
    at = 0
    for start in [match.start() for match in _DECISION_FORM_RE.finditer(page_html)]:
        if start < at:
            continue
        end = page_html.find("</form>", start)
        if end < 0:
            break
        form = page_html[start:end]
        opened = _FIELDSET_RE.search(form)
        closed = form.rfind("</fieldset>")
        if opened is None or closed < opened.end():
            continue
        closed += len("</fieldset>")
        parts += [page_html[at:start], form[:opened.end()], " disabled",
                  form[opened.end():closed], "\n", note, form[closed:]]
        at = end
    parts.append(page_html[at:])
    return "".join(parts)


def old_page(page_html: str, name: str, version: Version, behind: int) -> str:
    """An earlier version's HTML as serve answers it."""
    current = html.escape(urllib.parse.quote(f"{name}.html"))
    page_html = _disable_forms(page_html, current)
    count = "1 version" if behind == 1 else f"{behind} versions"
    stamp = html.escape(version.date)
    banner = (
        '\n<div class="artifact-version-banner" role="note">'
        '<p class="artifact-version-banner-text">An earlier version from '
        f'<time datetime="{stamp}">{html.escape(_shown_date(version.date))}</time>, '
        f"{count} behind. It's read-only: comments and answers live on the current page.</p>"
        '<p class="artifact-version-banner-links">'
        f'<a href="{current}#versions">All versions</a> '
        f'<a href="{current}">Back to current</a></p></div>'
    )

    def opened(match: re.Match) -> str:
        return f'<main class="{match.group(1)} artifact--old-version"{match.group(2)}>{banner}'

    return _MAIN_OPEN_RE.sub(opened, page_html, count=1)
