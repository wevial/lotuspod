"""The pages serve answers, as its /api and the agents' socket record them:
served_page_names, api_page and its one-read catalog, and agent_page."""

from __future__ import annotations

from pathlib import Path
from typing import Callable

from lotuspod.features import agents
from lotuspod.core import (_KEPT_SOURCE_SUFFIX, extract_meta, extract_visibility, is_page_name,
                           page_revision, source_revision)
from lotuspod.features import comments
from lotuspod.features import decisions
from lotuspod.features import history
from lotuspod.features.publish import _H2Collector, kept_block_hashes, page_owner
from lotuspod.features.serve import api, serve_files
from lotuspod.features import widgets


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
        page_html = (out_dir / file).read_text(encoding="utf-8")
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
    # A block outside every section's wrapper is on the whole page, or in
    # the page's one box when that is its only box.
    outside = comments.PAGE_SECTION if boxes == {comments.PAGE_SECTION} else comments.WHOLE_PAGE
    earlier = kept_block_hashes(out_dir, name)
    page_widgets = {
        ident: api.Widget(hash=hash_, title=title, section=section or outside,
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
