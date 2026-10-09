"""A page's earlier versions, read from the artifacts repository.

Every publish commits the output directory when it is the top of its own git
repository (cli.commit_output), so each commit that changed NAME.html is a
version of the page. They are read at request time, with nothing stored:

    git log --raw over NAME.html   the commits that changed it, newest first,
                                   each naming the page's blob
    git cat-file --batch           the blobs not read before, in one process

From each blob only its lotuspod:revision, lotuspod:visible and
lotuspod:owner are kept, in memory by blob id: a blob never changes. A list
runs at most two git processes, and one once its blobs are known; an old
version's HTML runs at most two. A version is listed only when its own page
was visible, at most MAX_VERSIONS of them, and a directory that is not the
top of its own repository has none. The whole history of the page is read,
so the version before the oldest one listed is known too.

Each listed version carries a one-line summary of what it changed from the
visible version before it: compare()'s sections in words (summary()), kept
in memory by the pair of blobs. It is "" on a version with no visible
version before it.

recent() lists the versions of the pages serve answers in a window of time,
for the activity route, in at most two git processes too: one git log over
those pages' whole history up to the window's end, each commit naming the
blob of every page it changed, so the version before each one is known
however far back it is, and one git cat-file --batch for the blobs and
texts not known yet.

old_page() is a version's HTML as serve answers it: marked as old, with a
banner linking back to the current page, and its decision forms disabled.

compare() is what changed between two versions: the sections of each body,
split at its h2 elements by id and compared by their text with whitespace
collapsed, and a line diff of their markdown sources when both have one.
History.changes() reads both versions and their sources for it, in at most
three git processes.
"""

from __future__ import annotations

import datetime as _dt
import difflib
import html
import os
import re
import subprocess
import threading
import urllib.parse
from dataclasses import dataclass
from html.parser import HTMLParser
from pathlib import Path
from typing import Callable

# The versions of one page a list holds, newest first.
MAX_VERSIONS = 200
# Seconds one git process may take.
GIT_TIMEOUT = 10
# The sections each part of a summary names before "and N more".
SUMMARY_NAMES = 3
# A version's commit as a URL names it: the full object id.
COMMIT = re.compile(r"[0-9a-f]{40}")
# The lines of a source diff compare() keeps.
MAX_DIFF_LINES = 400
# Context lines around each change in a source diff.
DIFF_CONTEXT = 3
# What a body's text before its first h2 is called, the whole text of a body
# without one.
PAGE_TEXT = "The page text"
_SLUG_STRIP = re.compile(r"[^a-z0-9]+")

_NO_BLOB = "0" * 40
_MAIN_OPEN_RE = re.compile(r'<main class="([^"]*)"([^>]*)>')
_TITLE_END_RE = re.compile(r"</title\s*>", re.IGNORECASE)


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
    # The handle its lotuspod:owner names; "" when none does.
    owner: str = ""
    # What it changed from the page before it, in words (summary()).
    summary: str = ""


@dataclass(frozen=True)
class Change:
    """One version of a page in a window, as recent() lists it."""

    name: str
    commit: str
    date: str
    revision: str
    owner: str
    # Whether the page had no visible version before it.
    first: bool
    summary: str


@dataclass(frozen=True)
class Recent:
    """What recent() found: its changes newest first; whether a page served
    now was visible up to the window's start; whether the repository lacks
    what came before a version (a shallow clone)."""

    changes: list[Change]
    older: bool
    truncated: bool


def _moment(stamp: str) -> _dt.datetime | None:
    """A UTC stamp as _utc() writes it, as a time; None for "". Before
    Python 3.11, fromisoformat() takes no Z."""
    try:
        return _dt.datetime.fromisoformat(stamp[:-1] + "+00:00" if stamp.endswith("Z") else stamp)
    except ValueError:
        return None


def _previous(chain: list[tuple[str, str]], at: int, stamps: dict) -> str | None:
    """The blob of the visible version before chain[at], a page's (blob,
    old blob) newest first: the first visible blob after it, else the
    oldest entry's old blob when that was visible; "" when the page had
    none before (that old blob is zeros), None when what came before was
    in the repository (a shallow clone)."""
    found = next((blob for blob, _ in chain[at + 1:] if blob in stamps and stamps[blob][1]), "")
    if found:
        return found
    last = chain[-1][1]
    if last == _NO_BLOB:
        return ""
    return last if last in stamps and stamps[last][1] else None


def _chain(entries: list[tuple]) -> list[tuple]:
    """A page's commits, (commit, date, old blob, blob, ...) newest first,
    once each, leaving out a commit that left the page's blob as the commit
    before it did: a merge that took it from its first parent, which git
    log -m lists by its change from another."""
    seen: set[str] = set()
    once = [entry for entry in entries if not (entry[0] in seen or seen.add(entry[0]))]
    return [entry for at, entry in enumerate(once)
            if at + 1 == len(once) or once[at + 1][3] != entry[3]]


def _utc(stamp: str) -> str:
    try:
        moment = _dt.datetime.fromisoformat(stamp)
    except ValueError:
        return ""
    return moment.astimezone(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


@dataclass(frozen=True)
class Section:
    """One h2 section of a page's body; the text before the first h2 is one
    with id "" titled PAGE_TEXT."""

    id: str
    title: str
    # Its text, the heading's included, with whitespace collapsed.
    text: str

    # Whether it starts at an h2; the text before the first one does not.
    headed: bool = True

    @property
    def key(self) -> str:
        """What the section is known by in another version: its id, else the
        id the outline gives its heading text (cli.slugify), as a page left
        with one h2 has none, with its heading text, so a renamed heading
        is one section removed and one added even where it keeps an id the
        author gave it; "" for the text before the first h2."""
        if not self.headed:
            return ""
        anchor = self.id or _SLUG_STRIP.sub("-", self.title.lower()).strip("-") or "section"
        return f"{anchor}\n{self.title}"


class _Sections(HTMLParser):
    """The sections of a page's section.artifact-body, by text alone: an
    attribute, such as a form's version hash, is never part of it. A block
    element's tags count as whitespace, so a line break between two blocks is
    no change, and an inline element's as nothing, so neither is wrapping
    words in one."""

    _SKIPPED = frozenset({"script", "style", "template"})
    # The elements that start a new line of text, as the page script reads
    # the text (js/page-open.js BLOCK).
    _BLOCKS = frozenset({
        "address", "article", "aside", "blockquote", "br", "caption", "dd", "details", "div",
        "dl", "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3",
        "h4", "h5", "h6", "header", "hr", "legend", "li", "main", "nav", "ol", "p", "pre",
        "section", "summary", "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul"})

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        # Open section elements while inside the body, 0 outside it.
        self._depth = 0
        self._skipped = 0
        # pre elements open inside a pre.mermaid: an h2 there is diagram source.
        self._mermaid = 0
        self._heading: list[str] | None = None
        self._current = {"id": "", "title": PAGE_TEXT, "text": [], "headed": False}
        self.found: list[dict] = []

    def _gap(self, tag: str) -> None:
        if self._depth and not self._skipped and tag in self._BLOCKS:
            self._current["text"].append(" ")

    def handle_starttag(self, tag: str, attrs: list) -> None:
        values = dict(attrs)
        if tag == "section":
            # A section inside the body is a block too.
            self._gap(tag)
            if self._depth or "artifact-body" in (values.get("class") or "").split():
                self._depth += 1
            return
        if not self._depth:
            return
        self._gap(tag)
        if tag in self._SKIPPED:
            self._skipped += 1
        elif tag == "pre" and (self._mermaid or "mermaid" in (values.get("class") or "").split()):
            self._mermaid += 1
        elif tag == "h2" and not self._mermaid and self._heading is None:
            self.found.append(self._current)
            self._current = {"id": values.get("id") or "", "title": "", "text": [],
                             "headed": True}
            self._heading = []

    def handle_endtag(self, tag: str) -> None:
        if not self._depth:
            return
        self._gap(tag)
        if tag == "section":
            self._depth -= 1
        elif tag in self._SKIPPED and self._skipped:
            self._skipped -= 1
        elif tag == "pre" and self._mermaid:
            self._mermaid -= 1
        elif tag == "h2" and self._heading is not None:
            self._current["title"] = " ".join("".join(self._heading).split())
            self._heading = None

    def handle_data(self, data: str) -> None:
        if not self._depth or self._skipped:
            return
        self._current["text"].append(data)
        if self._heading is not None:
            self._heading.append(data)

    def sections(self) -> list[Section]:
        self.close()
        if self._heading is not None:
            self._current["title"] = " ".join("".join(self._heading).split())
        made = []
        for found in [*self.found, self._current]:
            text = " ".join("".join(found["text"]).split())
            # The text before the first h2 counts only when there is some.
            if found["headed"] or text:
                made.append(Section(found["id"], found["title"] or found["id"], text,
                                    found["headed"]))
        return made


def sections(page_html: str) -> list[Section]:
    """The sections of a page's body, in its order."""
    parser = _Sections()
    parser.feed(page_html)
    return parser.sections()


def source_diff(old: str, new: str) -> tuple[list[dict], bool]:
    """A unified diff of two sources, as {op, text} lines: op "+", "-", " "
    or "@" for a hunk's header; at most MAX_DIFF_LINES of them, and whether
    any were cut."""
    lines: list[dict] = []
    diff = difflib.unified_diff(old.splitlines(), new.splitlines(), n=DIFF_CONTEXT, lineterm="")
    for line in diff:
        if line.startswith(("---", "+++")) and not lines:
            continue
        if len(lines) == MAX_DIFF_LINES:
            return lines, True
        if line.startswith("@@"):
            lines.append({"op": "@", "text": line})
        else:
            lines.append({"op": line[:1] or " ", "text": line[1:]})
    return lines, False


def _names(titles: list[str]) -> str:
    """Titles as words: "A", "A and B", "A, B and C", "A, B, C and 2 more"."""
    shown, rest = titles[:SUMMARY_NAMES], len(titles) - SUMMARY_NAMES
    if rest > 0:
        return f"{', '.join(shown)} and {rest} more"
    return " and ".join([", ".join(shown[:-1]), shown[-1]]) if len(shown) > 1 else shown[0]


def summary(compared: dict) -> str:
    """compare()'s sections in one line: "Alpha and Beta changed; Delta
    added; Gamma removed", a part left out when it has none, or "new
    version" when no section changed."""
    sections = compared["sections"]
    parts = [f"{_names([section['title'] for section in sections[kind]])} {kind}"
             for kind in ("changed", "added", "removed") if sections[kind]]
    return "; ".join(parts) or "new version"


def compare(old_html: str, new_html: str, old_source: str | None = None,
            new_source: str | None = None) -> dict:
    """What changed from one version of a page to another: {sections:
    {changed, added, removed}}, the first two as {id, title} in the new
    page's order and removed ones as {title} in the old page's (id "" for
    a heading the page gives none, and for the text before the first), and, when
    both sources are given, {lines, truncated} from source_diff()."""
    before = {section.key: section for section in sections(old_html)}
    after = sections(new_html)
    keys = {section.key for section in after}
    found: dict = {"sections": {
        "changed": [{"id": section.id, "title": section.title} for section in after
                    if section.key in before and before[section.key].text != section.text],
        "added": [{"id": section.id, "title": section.title} for section in after
                  if section.key not in before],
        "removed": [{"title": section.title} for key, section in before.items()
                    if key not in keys],
    }}
    if old_source is not None and new_source is not None:
        found["lines"], found["truncated"] = source_diff(old_source, new_source)
    return found


class History:
    """The versions of the pages in out_dir. stamp(page_html) is a page's
    (lotuspod:revision, lotuspod:visible, lotuspod:owner), read from its HTML."""

    def __init__(self, out_dir: Path, stamp: Callable[[str], tuple[str, bool, str]]) -> None:
        self.out_dir = Path(out_dir)
        self.stamp = stamp
        # Blob ids to what stamp read from them.
        self._stamps: dict[str, tuple[str, bool, str]] = {}
        # (old blob, new blob) to the summary of the version the new one is.
        self._summaries: dict[tuple[str, str], str] = {}
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

    @staticmethod
    def _log(out: bytes) -> list[tuple[str, str, str, str, str]]:
        """(commit, date, path, old blob, new blob) for each file each commit
        in git log --raw's output left in place, newest first, old zeros for
        a file the commit added."""
        found: list[tuple[str, str, str, str, str]] = []
        commit = date = ""
        for line in out.decode("utf-8", "replace").splitlines():
            head, _, rest = line.partition("\t")
            if COMMIT.fullmatch(head):
                commit, date = head, _utc(rest.strip())
            elif line.startswith(":") and commit:
                fields = head.split()
                # :OLDMODE NEWMODE OLD NEW STATUS; a deleted file's NEW is zeros.
                if (len(fields) == 5 and COMMIT.fullmatch(fields[2])
                        and COMMIT.fullmatch(fields[3]) and fields[3] != _NO_BLOB):
                    found.append((commit, date, rest, fields[2], fields[3]))
        return found

    def _commits(self, name: str) -> list[tuple[str, str, str, str]]:
        """(commit, date, old blob, blob) for each commit that left NAME.html
        in place, newest first (_chain()); a merge counts by its change."""
        out = self._git("log", "-m", "--format=%H%x09%cI", "--raw", "--no-abbrev",
                        "--no-renames", "--", f"{name}.html")
        if out is None:
            return []
        return _chain([(commit, date, old, new)
                       for commit, date, _, old, new in self._log(out)])

    def _read(self, blobs: list[str], keep: list[str] = ()) -> dict[str, str] | None:
        """Read the blobs whose stamps are not known yet, and those in keep
        too, in one process; the texts of those in keep that were read (None
        when nothing was, or git failed)."""
        with self._lock:
            wanted = [blob for blob in dict.fromkeys(blobs) if blob not in self._stamps]
        wanted += [blob for blob in dict.fromkeys(keep) if blob not in wanted]
        if not wanted:
            return None
        asked = "".join(f"{blob}\n" for blob in wanted).encode("ascii")
        out = self._git("cat-file", "--batch", data=asked)
        if out is None:
            return None
        kept: dict[str, str] = {}
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
            if blob in keep:
                kept[blob] = text
        return kept

    def _versions(self, commits: list[tuple[str, str, str, str]],
                  keep: str = "") -> tuple[list[Version], str | None]:
        """The newest MAX_VERSIONS visible versions among commits, and keep's
        text."""
        kept = self._read([blob for _, _, _, blob in commits], [keep] if keep else [])
        with self._lock:
            stamps = dict(self._stamps)
        listed = [Version(commit, date, *stamps[blob])
                  for commit, date, _, blob in commits if blob in stamps]
        return ([version for version in listed if version.visible][:MAX_VERSIONS],
                (kept or {}).get(keep))

    def _summarize(self, chains: list[tuple[list[tuple[str, str]], list[int]]],
                   limit: int | None = None) -> list[dict[int, tuple[str | None, str]]]:
        """For each chain, a page's (blob, old blob) newest first and the
        places in it whose summaries are wanted, (previous, summary) by place
        for each visible version among them, the first `limit` of them when
        given: previous as _previous() gives it, and summary "" when it is
        not a blob.

        Reads in one process the stamps not known of any chain's blobs and
        its oldest old blob, and the texts the summaries not made before
        need: while a chain's stamps are not all known, which version comes
        before which is not either, so every blob from its first wanted
        place on is kept."""
        with self._lock:
            stamps = dict(self._stamps)
            made = dict(self._summaries)
        read: list[str] = []
        keep: list[str] = []
        for chain, wanted in chains:
            blobs = [blob for blob, _ in chain]
            if chain and chain[-1][1] != _NO_BLOB:
                blobs.append(chain[-1][1])
            read += blobs
            if not wanted:
                continue
            if not all(blob in stamps for blob in blobs):
                keep += blobs[min(wanted):]
                continue
            for at in wanted:
                before = _previous(chain, at, stamps)
                if stamps[chain[at][0]][1] and before and (before, chain[at][0]) not in made:
                    keep += [before, chain[at][0]]
        texts = self._read(read, keep) or {}
        with self._lock:
            stamps = dict(self._stamps)
        found: list[dict[int, tuple[str | None, str]]] = []
        for chain, wanted in chains:
            said: dict[int, tuple[str | None, str]] = {}
            for at in wanted:
                blob = chain[at][0]
                if blob not in stamps or not stamps[blob][1]:
                    continue
                if limit is not None and len(said) == limit:
                    break
                before = _previous(chain, at, stamps)
                if not before:
                    said[at] = (before, "")
                elif (before, blob) in made:
                    said[at] = (before, made[(before, blob)])
                elif before in texts and blob in texts:
                    made[(before, blob)] = summary(compare(texts[before], texts[blob]))
                    with self._lock:
                        self._summaries[(before, blob)] = made[(before, blob)]
                    said[at] = (before, made[(before, blob)])
            found.append(said)
        return found

    def listed(self, name: str) -> list[Version]:
        """NAME's newest MAX_VERSIONS visible versions, newest first, each
        with its summary."""
        commits = self._commits(name)
        chain = [(blob, old) for _, _, old, blob in commits]
        (said,) = self._summarize([(chain, list(range(len(chain))))], MAX_VERSIONS)
        with self._lock:
            stamps = dict(self._stamps)
        return [Version(commit, date, *stamps[blob], summary=said[at][1])
                for at, (commit, date, _, blob) in enumerate(commits) if at in said]

    def recent(self, start: _dt.datetime, end: _dt.datetime, names: list[str]) -> Recent:
        """The versions of the pages named, those serve answers, whose
        commits fall after start and up to end, newest first.

        A commit is a version of a page only when the page is visible in it
        and its lotuspod:revision is not that of the visible version before
        it (_previous()); one with none before it is the page's first. A
        merge counts by its change, as in _commits(). `older` is whether one
        of the pages was visible up to start. `truncated` is whether the
        repository lacks what came before a version (a shallow clone), which
        is then not its page's first and has summary "".
        """
        if not names:
            return Recent([], False, False)
        until = end.astimezone(_dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%S+00:00")
        # A name git would quote, as one outside ASCII, is read as it is.
        out = self._git("-c", "core.quotePath=false", "log", "-m", f"--until={until}",
                        "--format=%H%x09%cI", "--raw", "--no-abbrev", "--no-renames", "--",
                        *(f"{name}.html" for name in sorted(set(names))))
        if out is None:
            return Recent([], False, False)
        # Each page's commits, newest first: (commit, date, old, blob, after start).
        pages: dict[str, list[tuple[str, str, str, str, bool]]] = {}
        for commit, date, path, old, new in self._log(out):
            moment = _moment(date)
            if moment is not None and moment <= end and path.endswith(".html"):
                pages.setdefault(path[:-len(".html")], []).append(
                    (commit, date, old, new, moment > start))
        listed = [(name, _chain(entries)) for name, entries in pages.items()]
        chains = [[(blob, old) for _, _, old, blob, _ in entries] for _, entries in listed]
        said = self._summarize([(chain, [at for at, entry in enumerate(entries) if entry[4]])
                                for chain, (_, entries) in zip(chains, listed)])
        with self._lock:
            stamps = dict(self._stamps)
        changes = []
        older = cut = False
        for (name, entries), found in zip(listed, said):
            for at, (before, words) in found.items():
                commit, date, _, blob, _ = entries[at]
                if before and stamps[before][0] == stamps[blob][0]:
                    continue
                cut = cut or before is None
                revision, _, owner = stamps[blob]
                changes.append(Change(name, commit, date, revision, owner, before == "", words))
            older = older or any(not after and blob in stamps and stamps[blob][1]
                                 for _, _, _, blob, after in entries)
        changes.sort(key=lambda change: change.date, reverse=True)
        return Recent(changes, older, cut)

    def version(self, name: str, commit: str) -> tuple[Version, int, str] | None:
        """NAME's version at commit, how many listed versions are newer, and
        its HTML; None unless it is one of NAME's listed versions."""
        if not COMMIT.fullmatch(commit):
            return None
        commits = self._commits(name)
        blob = next((blob for found, _, _, blob in commits if found == commit), "")
        if not blob:
            return None
        listed, text = self._versions(commits, keep=blob)
        for behind, version in enumerate(listed):
            if version.commit == commit and text is not None:
                return version, behind, text
        return None

    def _objects(self, names: list[str]) -> list[str | None] | None:
        """Each named object's text, None for one git does not have; None
        when git failed."""
        asked = "".join(f"{name}\n" for name in names).encode("utf-8")
        out = self._git("cat-file", "--batch", data=asked)
        if out is None:
            return None
        texts: list[str | None] = []
        at = 0
        while at < len(out) and len(texts) < len(names):
            end = out.find(b"\n", at)
            if end < 0:
                break
            header = out[at:end].split()
            at = end + 1
            if len(header) == 3 and header[2].isdigit():
                size = int(header[2])
                texts.append(out[at:at + size].decode("utf-8", "replace"))
                at += size + 1
            else:
                # NAME missing, or ambiguous.
                texts.append(None)
        return texts if len(texts) == len(names) else None

    def changes(self, name: str, since: str) -> tuple[Version, int, dict | None] | None:
        """NAME's newest listed version whose revision is since, how many
        listed versions are newer, and what changed from it to the current
        one (compare(), with the sources when both versions kept NAME.md);
        None for what changed when it is the current one. None unless a
        listed version carries since."""
        if not since:
            return None
        commits = self._commits(name)
        listed = self._versions(commits)[0]
        found = next(((behind, version) for behind, version in enumerate(listed)
                      if version.revision == since), None)
        if found is None:
            return None
        behind, version = found
        if behind == 0:
            return version, 0, None
        blobs = {commit: blob for commit, _, _, blob in commits}
        current = listed[0]
        texts = self._objects([blobs[version.commit], blobs[current.commit],
                               f"{version.commit}:{name}.md", f"{current.commit}:{name}.md"])
        if texts is None or texts[0] is None or texts[1] is None:
            return None
        return version, behind, compare(*texts)


def _shown_date(stamp: str) -> str:
    """A UTC stamp as the banner says it: 2026-09-10 14:05 UTC."""
    return f"{stamp[:10]} {stamp[11:16]} UTC" if len(stamp) >= 16 else stamp


class Places(HTMLParser):
    """Where a page's own elements are, as offsets into its HTML, read from
    the end of the head's title on as a browser reads them: a tag spelled in
    a comment or in script text is no element. The title itself is text to
    a browser, whatever it spells, so it is never read.

    head_end is where the head's end tag starts; main the start and end of
    main's start tag; topbar_end just after the title bar's end tag; and
    fieldsets, one per decision form, just after its first fieldset's
    "<fieldset" and just after that fieldset's end tag. Each is None, or
    empty, when the page has none."""

    def __init__(self, page_html: str) -> None:
        super().__init__(convert_charrefs=True)
        title = _TITLE_END_RE.search(page_html)
        self._base = title.end() if title else 0
        self._html = page_html
        read = page_html[self._base:]
        self._lines = [0] + [match.end() for match in re.finditer("\n", read)]
        self.head_end: int | None = None
        self.main: tuple[int, int] | None = None
        self.topbar_end: int | None = None
        self.fieldsets: list[tuple[int, int]] = []
        # The title bar's divs open; whether a decision form is open, its
        # fieldsets open and where its first one's tag name ends.
        self._bar = 0
        self._form = False
        self._depth = 0
        self._start: int | None = None
        self.feed(read)
        self.close()

    def _at(self) -> int:
        line, column = self.getpos()
        return self._base + self._lines[line - 1] + column

    def handle_starttag(self, tag, attrs):
        at = self._at()
        classes = (dict(attrs).get("class") or "").split()
        if tag == "main" and self.main is None:
            self.main = (at, at + len(self.get_starttag_text() or ""))
        elif tag == "div":
            if self._bar:
                self._bar += 1
            elif self.topbar_end is None and "artifact-topbar" in classes:
                self._bar = 1
        elif tag == "form" and "artifact-decision" in classes:
            self._form, self._depth, self._start = True, 0, None
        elif tag == "fieldset" and self._form:
            if self._depth == 0 and self._start is None:
                self._start = at + len("<fieldset")
            self._depth += 1

    def handle_endtag(self, tag):
        at = self._at()
        end = self._html.find(">", at) + 1
        if tag == "head" and self.head_end is None:
            self.head_end = at
        elif tag == "div" and self._bar:
            self._bar -= 1
            if not self._bar:
                self.topbar_end = end
        elif tag == "fieldset" and self._form and self._depth:
            self._depth -= 1
            if not self._depth and self._start is not None:
                self.fieldsets.append((self._start, end))
                self._form = False
        elif tag == "form":
            self._form = False


def edited(page_html: str, edits: list[tuple[int, int, str]]) -> str:
    """page_html with each (start, end, text) of edits put in place of what
    lies between start and end; no two edits overlap."""
    for start, end, text in sorted(edits, reverse=True):
        page_html = page_html[:start] + text + page_html[end:]
    return page_html


def _disable_forms(page_html: str, note: str) -> str:
    """Each decision form's fieldset disabled, and note, HTML, after it
    saying why."""
    return edited(page_html, [edit for start, end in Places(page_html).fieldsets
                              for edit in ((start, start, " disabled"), (end, end, "\n" + note))])


def old_page(page_html: str, name: str, version: Version, behind: int) -> str:
    """An earlier version's HTML as serve answers it."""
    current = html.escape(urllib.parse.quote(f"{name}.html"))
    page_html = _disable_forms(page_html, (
        '<p class="artifact-version-note">Answering is off on old versions. '
        f'<a href="{current}">Answer on the current page.</a></p>'))
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
