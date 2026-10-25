"""The pages serve answers: each rendered when asked for (rendered_page),
the index rendered from the manifest (rendered_index), and as its /api and the agents' socket record them: served_page_names,
api_page and its one-read catalog, and agent_page."""

from __future__ import annotations

import datetime as _dt
import hashlib
import json
import sys
import threading
from pathlib import Path
from typing import Callable, NamedTuple

from lotuspod.features import agents
from lotuspod.core import (_KEPT_SOURCE_SUFFIX, MANIFEST_FILE, THEME_ROOT, extract_meta, extract_visibility,
                           is_page_name, page_revision, source_revision)
from lotuspod.features import comments
from lotuspod.features import decisions
from lotuspod.features import history
from lotuspod.features import index
from lotuspod.features.publish import (REFS_SUFFIX, _H2Collector, kept_block_hashes, kept_source,
                                       page_owner, refs_from, render_from,
                                       render_kept_or_extracted)
from lotuspod.features.serve import api, serve_files
from lotuspod.features import widgets


def render_version() -> str:
    """A digest of every file the package holds: its templates, the sources
    of its served theme files and the code a render runs. A deploy restarts
    serve, which takes it once as it starts."""
    digest = hashlib.sha256()
    for path in sorted(THEME_ROOT.rglob("*")):
        if not path.is_file() or "__pycache__" in path.parts:
            continue
        for part in (path.relative_to(THEME_ROOT).as_posix().encode("utf-8"), path.read_bytes()):
            digest.update(len(part).to_bytes(8, "big"))
            digest.update(part)
    return digest.hexdigest()[:16]


def page_inputs(out_dir: Path, name: str) -> str:
    """A digest of what NAME's render is made from: its published file, its
    kept source and its kept refs. OSError when the page cannot be read."""
    digest = hashlib.sha256()
    kept = kept_source(out_dir, name)
    refs = out_dir / f"{name}{REFS_SUFFIX}"
    for part in ((out_dir / f"{name}.html").read_bytes(),
                 (kept[0].encode("utf-8") + b"\0" + kept[1]) if kept else b"",
                 refs.read_bytes() if refs.is_file() else b""):
        digest.update(len(part).to_bytes(8, "big"))
        digest.update(part)
    return digest.hexdigest()[:16]


class Rendered(NamedTuple):
    """A page as serve answers it: its html, its live-block frames by the
    names the page gives them, and the digest of the inputs it was made
    from (page_inputs). rendered is False when the render raised and html
    is the published file's."""
    html: str
    frames: dict[str, bytes]
    inputs: str
    rendered: bool


# One render per page per input digest, for the life of the serve process;
# a page renders under its own lock, so requests that miss together render
# it once. A failed render is never kept, so a page whose render failed
# renders again at its next request; its failure is logged once.
_RENDERS: dict[tuple[Path, str], Rendered] = {}
_RENDERING: dict[tuple[Path, str], threading.Lock] = {}
_FAILED: set[tuple[Path, str, str]] = set()
_RENDERS_LOCK = threading.Lock()


def _linked(out_dir: Path, name: str) -> bool:
    """Whether a file NAME's render reads is a link, which may name a file
    outside the served directory."""
    return any((out_dir / f"{name}{suffix}").is_symlink()
               for suffix in (".html", REFS_SUFFIX, *_KEPT_SOURCE_SUFFIX.values()))


def _published(out_dir: Path, name: str, inputs: str, why: str) -> Rendered | None:
    """NAME's published file as its answer, the reason logged once per inputs."""
    try:
        published = (out_dir / f"{name}.html").read_bytes().decode("utf-8")
    except (OSError, UnicodeDecodeError):
        return None
    with _RENDERS_LOCK:
        logged = (out_dir, name, inputs) in _FAILED
        _FAILED.add((out_dir, name, inputs))
    if not logged:
        print(f"serve: {name}.html is answered from its published file: {why}",
              file=sys.stderr, flush=True)
    return Rendered(published, {}, inputs, False)


def rendered_page(out_dir: Path, name: str) -> Rendered | None:
    """NAME's page rendered now from its kept source (or the body extracted
    from its published file) with today's template; None when its published
    file cannot be read. A render that raises, or a page that reads a link,
    gives the published file, and says so once on standard error."""
    key = (Path(out_dir), name)
    try:
        if _linked(key[0], name):
            return _published(key[0], name, "", "a file it is rendered from is a link")
        inputs = page_inputs(key[0], name)
    except OSError:
        return None
    with _RENDERS_LOCK:
        found = _RENDERS.get(key)
        rendering = _RENDERING.setdefault(key, threading.Lock())
    if found is not None and found.inputs == inputs:
        return found
    with rendering:
        with _RENDERS_LOCK:
            found = _RENDERS.get(key)
        if found is not None and found.inputs == inputs:
            return found
        try:
            page_html, frames = render_kept_or_extracted(key[0], name)
        except Exception as exc:  # noqa: BLE001 - any failed render answers the published file
            return _published(key[0], name, inputs,
                              f"its render failed: {type(exc).__name__}: {exc}")
        found = Rendered(page_html, frames, inputs, True)
        try:
            # Published again while it rendered: answered, never kept.
            if page_inputs(key[0], name) != inputs:
                return found
        except OSError:
            return found
        with _RENDERS_LOCK:
            _RENDERS[key] = found
        return found


def theme_head() -> str:
    """The theme head script's text, as a render writes it inline."""
    return (THEME_ROOT / "core" / "ts" / "theme-head.js").read_text(encoding="utf-8")


# One render per page per commit for the life of the serve process (whose
# render version is fixed), the oldest dropped past _VERSIONS_KEPT; a
# version that cannot be rendered is kept as None, so it is said once.
_VERSIONS: dict[tuple[Path, str, str], str | None] = {}
_VERSIONS_KEPT = 256


def rendered_version(out_dir: Path, name: str, commit: str, page_html: str,
                     files_at: Callable[[str, list[str]], list[bytes | None] | None]
                     ) -> str | None:
    """NAME as it was at commit, page_html its published file then, rendered
    with today's template from that commit's kept source (or the body
    extracted from page_html) and kept refs, read by files_at
    (History.files_at); nothing is written. None, said on standard error
    (once, unless git failed), when it cannot be, so the version is
    answered as published."""
    key = (Path(out_dir), name, commit)
    with _RENDERS_LOCK:
        if key in _VERSIONS:
            return _VERSIONS[key]
        rendering = _RENDERING.setdefault(key, threading.Lock())
    with rendering:
        with _RENDERS_LOCK:
            if key in _VERSIONS:
                return _VERSIONS[key]
        sources = [f"{name}{suffix}" for suffix in _KEPT_SOURCE_SUFFIX.values()]
        found = files_at(commit, [*sources, f"{name}{REFS_SUFFIX}"])
        page: str | None = None
        if found is None:
            why = "its files at that commit cannot be read"
        else:
            kept = next(((fmt, data) for fmt, data in zip(_KEPT_SOURCE_SUFFIX, found)
                         if data is not None), None)
            try:
                refs = (refs_from(found[-1], f"{name}{REFS_SUFFIX} at {commit}")
                        if found[-1] is not None else ({}, ""))
                page = render_from(key[0], name, page_html, kept, refs)[0]
            except Exception as exc:  # noqa: BLE001 - any failed render answers the published file
                why = f"its render failed: {type(exc).__name__}: {exc}"
        if page is None:
            print(f"serve: {name}.html?version={commit} is answered from its published "
                  f"file: {why}", file=sys.stderr, flush=True)
        with _RENDERS_LOCK:
            _RENDERING.pop(key, None)
            # git failing is not the version's: it is asked again next time.
            if found is None:
                return None
            _VERSIONS[key] = page
            while len(_VERSIONS) > _VERSIONS_KEPT:
                del _VERSIONS[next(iter(_VERSIONS))]
        return page


# The index as last rendered for each served directory, by its key.
_INDEXES: dict[Path, tuple[str, str]] = {}


def rendered_index(out_dir: Path) -> tuple[str, str] | None:
    """The index rendered now from out_dir's manifest with today's template,
    listing only the pages serve answers, and a key over the manifest's
    bytes, the day it was written, which is the day the index names as
    updated, and the pages listed; None when the manifest cannot be read."""
    path = out_dir / MANIFEST_FILE
    try:
        if path.is_symlink():
            return None
        data = path.read_bytes()
        day = _dt.date.fromtimestamp(path.stat().st_mtime).isoformat()
        artifacts = json.loads(data.decode("utf-8"))["artifacts"]
    except (OSError, UnicodeDecodeError, ValueError, KeyError, TypeError):
        return None
    if not isinstance(artifacts, list) or not all(isinstance(m, dict) for m in artifacts):
        return None
    # A manifest older than a page's turn to hidden still lists it: only the
    # pages serve answers are listed, so none shows its title or summary.
    allowed = serve_files.serve_allow_list(out_dir)
    artifacts = [m for m in artifacts if m.get("file") in allowed and is_page_name(str(m["file"]))]
    listed = "\0".join(str(m["file"]) for m in artifacts)
    key = hashlib.sha256(b"\0".join((data, day.encode("ascii"), listed.encode("utf-8"))))
    key = key.hexdigest()[:16]
    with _RENDERS_LOCK:
        found = _INDEXES.get(Path(out_dir))
    if found is not None and found[1] == key:
        return found
    try:
        found = (index.render_index(artifacts, day), key)
    except (KeyError, TypeError, AttributeError):
        return None
    with _RENDERS_LOCK:
        _INDEXES[Path(out_dir)] = found
    return found


def served_page_names(out_dir: Path, allowed: frozenset[str] | None = None) -> list[str]:
    """The names of the pages serve answers, archived ones left out, in order.
    allowed is serve_files.serve_allow_list(out_dir) when the caller has read it already."""
    if allowed is None:
        allowed = serve_files.serve_allow_list(out_dir)
    return sorted(file[:-len(".html")] for file in allowed
                  if file.endswith(".html") and is_page_name(file)
                  and not history.is_archived(out_dir, file[:-len(".html")]))


def api_page(out_dir: Path, name: str,
             allowed: frozenset[str] | None = None) -> api.Page | None:
    """The page serve answers as NAME.html, as /api records it; None when
    serve would not answer it. allowed is serve_files.serve_allow_list(out_dir) when
    the caller has read it already."""
    if allowed is None:
        allowed = serve_files.serve_allow_list(out_dir)
    # The allow-list holds bare file names only, so no name reaches past it.
    file = f"{name}.html"
    if not is_page_name(file) or file not in allowed:
        return None
    try:
        # The allow-list may have been read before the page was replaced
        # by a link, which serve_allow_list never lists.
        if (out_dir / file).is_symlink():
            return None
        rendered = rendered_page(out_dir, name)
        if rendered is None:
            return None
        # The page as the reader sees it, rendered from what it keeps.
        page_html = rendered.html
        revision = page_revision(out_dir, name)
        record = history.read_record(out_dir, name) or {}
    except (OSError, UnicodeDecodeError, RuntimeError):
        return None
    # The allow-list may have been read before the page was published hidden.
    if not extract_visibility(page_html):
        return None
    parser = _H2Collector(page_html)
    parser.feed(page_html)
    parser.close()
    sections: dict[str, str] = {}
    for heading in parser.headings:
        if heading["id"]:
            sections.setdefault(heading["id"], heading["text"])
    questions = {
        key: api.Question(version=form.version, choices=frozenset(v for v, _ in form.options),
                          text=form.text, labels=dict(form.options), section=form.section,
                          defaults=form.defaults, checklist=form.checklist,
                          context=form.context, default=form.default)
        for key, form in decisions.read_forms(page_html).items()
    }
    owner = page_owner(page_html)
    boxes = frozenset(comments.read_boxes(page_html))
    # A block is in its wrapper's section or its heading's, else on the
    # whole page; on a page whose only box is `page`, in that box.
    only_page = boxes == {comments.PAGE_SECTION}
    outside = comments.PAGE_SECTION if only_page else comments.WHOLE_PAGE
    earlier = kept_block_hashes(out_dir, name)
    page_widgets = {
        ident: api.Widget(hash=hash_, title=title,
                          section=outside if only_page else section or outside,
                          earlier=frozenset(earlier.get(ident, ())))
        for ident, (hash_, title, section) in widgets.PageWidgets(page_html).found.items()
    }
    return api.Page(name=name, revision=revision, sections=sections, questions=questions,
                    comment_sections=boxes, widgets=page_widgets,
                    owner=owner if agents.is_handle(owner) else "",
                    title=extract_meta(page_html, name)["title"],
                    archived=record.get("archivedAt", ""),
                    superseded_by=record.get("supersededBy") or "")


class _Catalog:
    """api_page and served_page_names over one read of the allow-list, made
    at the first lookup, keeping each page it builds."""

    def __init__(self, out_dir: Path) -> None:
        self.out_dir = out_dir
        self._allowed: frozenset[str] | None = None
        self._found: dict[str, api.Page | None] = {}

    def _allow_list(self) -> frozenset[str]:
        if self._allowed is None:
            self._allowed = serve_files.serve_allow_list(self.out_dir)
        return self._allowed

    def __call__(self, name: str) -> api.Page | None:
        if name not in self._found:
            self._found[name] = api_page(self.out_dir, name, self._allow_list())
        return self._found[name]

    def names(self) -> list[str]:
        return served_page_names(self.out_dir, self._allow_list())


def api_catalog(out_dir: Path) -> Callable[[str], api.Page | None]:
    """A lookup like api_page for one /api request that looks up many names:
    it reads the allow-list once, and only when a name is looked up. Its
    names() is served_page_names over the same read."""
    return _Catalog(out_dir)


def agent_page(out_dir: Path, page: api.Page) -> dict:
    """The page as an agent's pull shows it, with its kept source (NAME.md
    or NAME.body.html). A page published before sources were kept has none:
    an empty source, and the revision of the page as rendered.

    With a source, the revision is that of the very bytes given, which is
    the page's lotuspod:revision once a publish has finished. publish writes
    the page before its source, and this reads without its lock, so a
    revision read apart from the source could be newer than the source
    given; an agent expecting it would then overwrite that newer edit."""
    source_file, source, revision = "", "", page.revision
    for suffix in _KEPT_SOURCE_SUFFIX.values():
        kept = out_dir / f"{page.name}{suffix}"
        if kept.is_file() and not kept.is_symlink():
            data = kept.read_bytes()
            source_file = kept.name
            source = data.decode("utf-8", "replace")
            revision = source_revision(data)
            break
    if not source_file and not revision:
        revision = source_revision((out_dir / f"{page.name}.html").read_bytes())
    return {"name": page.name, "title": page.title, "owner": page.owner,
            "revision": revision, "sourceFile": source_file, "source": source}
