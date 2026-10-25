"""kept: a page rendered again from what it keeps (render_kept),
`lotuspod pages migrate`, which keeps the body of each page published only as
HTML as its NAME.body.html once a render from it gives the page back, and
`lotuspod pages diff`, which lists each page whose body a render now gives
differently from its published file."""

from __future__ import annotations

import argparse
import html
import json
import re
import sys
from html.parser import HTMLParser
from difflib import SequenceMatcher
from itertools import zip_longest
from pathlib import Path

from lotuspod.core import (BODY_SOURCE_SUFFIX, DEFAULT_OUTPUT_DIR, _KEPT_SOURCE_SUFFIX, _git,
                           Templates,
                           _git_ok, _GitFailed, extract_meta, html_title, is_page_name,
                           is_repository_top, normalized, publish_lock, source_revision,
                           write_atomic)
from lotuspod.features import agents
from lotuspod.features import comments
from lotuspod.features import decisions
from lotuspod.features import history
from lotuspod.features import widgets
from lotuspod.features.publish import markdown, media
from lotuspod.features.publish.publish import kept_refs
from lotuspod.features.publish.render import (_H2Collector, build_page, page_owner,
                                              page_variant, version_stamp)


_OUTLINE_MARK = '<nav class="artifact-outline"'


class _BodySpan(HTMLParser):
    """Locate the inner HTML of a page's section.artifact-body. A template's
    content is inert, so no section tag inside one opens or closes the page's
    body, and a noscript's is raw text, as core.Templates reads it."""

    CDATA_CONTENT_ELEMENTS = Templates.CDATA_CONTENT_ELEMENTS

    def __init__(self, page_html: str) -> None:
        super().__init__(convert_charrefs=True)
        self._line_starts = [0, *(match.end() for match in re.finditer("\n", page_html))]
        self._templates = 0
        self._depth = 0
        self.start: int | None = None
        self.end: int | None = None

    def _offset(self) -> int:
        line, column = self.getpos()
        return self._line_starts[line - 1] + column

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag == "template":
            self._templates += 1
        elif tag != "section" or self.end is not None or self._templates:
            return
        elif self._depth:
            self._depth += 1
        elif "artifact-body" in (dict(attrs).get("class") or "").split():
            self.start = self._offset() + len(self.get_starttag_text() or "")
            self._depth = 1

    def handle_endtag(self, tag: str) -> None:
        if tag == "template" and self._templates:
            self._templates -= 1
        elif tag == "section" and self._depth and self.end is None and not self._templates:
            self._depth -= 1
            if not self._depth:
                self.end = self._offset()


def published_body(page_html: str) -> str | None:
    """The inner HTML of a page's section.artifact-body, byte for byte as
    published; None when it has none."""
    parser = _BodySpan(page_html)
    parser.feed(page_html)
    parser.close()
    if parser.start is None or parser.end is None:
        return None
    return page_html[parser.start:parser.end]


def kept_source(out_dir: Path, name: str) -> tuple[str, bytes] | None:
    """(format, bytes) of NAME's kept source; None when it keeps none."""
    for fmt, suffix in _KEPT_SOURCE_SUFFIX.items():
        path = out_dir / f"{name}{suffix}"
        if path.is_file():
            return fmt, path.read_bytes()
    return None


def _render(out_dir: Path, name: str, page_html: str, fmt: str, data: bytes,
            refs: tuple[dict[str, dict], str] | None = None) -> tuple[str, dict[str, bytes]]:
    """NAME rendered from a source of fmt, with the stamps page_html carries
    and refs, (entries, asOf), or NAME.refs.json's when None."""
    text = normalized(data.decode("utf-8"))
    if fmt == "markdown":
        sizes = {}
        for line in markdown.images(text):
            if line.src.startswith(media.URL_PREFIX):
                image = media.load_stored(media.media_dir(out_dir),
                                          line.src[len(media.URL_PREFIX):])
                if image is not None:
                    sizes[image.url] = (image.width, image.height)
        body = markdown.to_body(text, sizes)
    else:
        body = html_title(text)[1]
    meta = extract_meta(page_html, name)
    revision, visible, _ = version_stamp(page_html)
    owner = page_owner(page_html)
    refs, refs_as_of = kept_refs(out_dir, name) if refs is None else refs
    built = build_page(argparse.Namespace(
        name=name,
        title=html.escape(meta["title"], quote=False),
        episode=meta["episode"],
        date=meta["date"],
        updated=meta["updated"],
        summary=html.escape(meta["summary"], quote=False),
        labels=meta["labels"],
        body=body,
        hidden=not visible,
        no_outline=_OUTLINE_MARK not in page_html,
        comments=bool(comments.read_boxes(page_html)),
        owner=owner if agents.is_handle(owner) else "",
        owner_checked=True,
        variant=page_variant(page_html),
        out_dir=str(out_dir),
        revision=revision,
        refs=refs,
        refs_as_of=refs_as_of,
        # Each frame keeps the name the page links; its bytes are today's.
        frame_names={ident: f"{name}.w-{hash_}.html" for ident, (hash_, _, _)
                     in widgets.PageWidgets(page_html).found.items()},
    ))
    return built.html, built.widget_files


def render_kept(out_dir: Path, name: str) -> tuple[str, dict[str, bytes]]:
    """NAME's page as publish would render it now from its kept source and
    the stamps its published file carries, and its live-block frame files;
    nothing is written. RuntimeError when NAME keeps no source."""
    out_dir = Path(out_dir)
    page_html = (out_dir / f"{name}.html").read_bytes().decode("utf-8")
    kept = kept_source(out_dir, name)
    if kept is None:
        raise RuntimeError(f"{name} keeps no source")
    return _render(out_dir, name, page_html, *kept)


def render_kept_or_extracted(out_dir: Path, name: str) -> tuple[str, dict[str, bytes]]:
    """render_kept(), or for a page that keeps no source, the render from
    the body `lotuspod pages migrate` would keep for it (extract). A kept
    source other than the one the page is stamped at (publish writes the
    page before its source) is not the page's, and the page renders from
    its extracted body."""
    out_dir = Path(out_dir)
    page_html = (out_dir / f"{name}.html").read_bytes().decode("utf-8")
    return render_from(out_dir, name, page_html, kept_source(out_dir, name))


def render_from(out_dir: Path, name: str, page_html: str, kept: tuple[str, bytes] | None,
                refs: tuple[dict[str, dict], str] | None = None
                ) -> tuple[str, dict[str, bytes]]:
    """render_kept_or_extracted() over the inputs given rather than the
    files beside it: page_html, the published page; kept, (format, bytes)
    of its kept source or None; refs, (entries, asOf) or None for
    NAME.refs.json's. RuntimeError names why a body cannot be extracted."""
    revision = version_stamp(page_html)[0]
    if kept is not None and (not revision or source_revision(kept[1]) == revision):
        return _render(out_dir, name, page_html, *kept, refs=refs)
    body = extract(out_dir, name, page_html, refs)
    return _render(out_dir, name, page_html, "html", body.encode("utf-8"), refs=refs)


class _Decorations(HTMLParser):
    """What in a body only publish writes from a source, in body order."""

    MARKS = (("details", comments.BOX_CLASS, "a comment box"),
             ("div", "artifact-section-body", "a section wrapper"),
             ("form", "artifact-decision", "a decision form"),
             ("figure", "artifact-live", "a live block"),
             ("iframe", "artifact-widget", "a live block"))

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.found: list[str] = []

    def handle_starttag(self, tag: str, attrs: list) -> None:
        classes = (dict(attrs).get("class") or "").split()
        for mark_tag, mark_class, what in self.MARKS:
            if tag == mark_tag and mark_class in classes:
                self.found.append(what)


class _Text(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []

    def handle_data(self, data: str) -> None:
        self.parts.append(data)


def body_text(body: str) -> str:
    """A body's text, each run of whitespace one space."""
    parser = _Text()
    parser.feed(body)
    parser.close()
    return " ".join("".join(parser.parts).split())


def anchors(body: str) -> dict[str, list[str]]:
    """The anchors a body carries, by kind, in body order."""
    headings = _H2Collector(body)
    headings.feed(body)
    headings.close()
    return {
        "h2 id": [heading["id"] for heading in headings.headings],
        "decision question id": list(decisions.read_forms(body)),
        "live-block frame name": widgets.Frames(body).sources,
        "comment-box section": comments.read_boxes(body),
    }


def first_difference(published: str, rendered: str) -> str:
    """How the body rendered differs from the one published, first
    difference first; "" when its text and anchors are the same."""
    page, render = anchors(published), anchors(rendered)
    for kind in page:
        if page[kind] == render[kind]:
            continue
        for had, got in zip(page[kind], render[kind]):
            if had != got:
                if not had:
                    return f"the {kind} {got!r} the render added"
                return f"the {kind} {got!r} the render gives where the page has {had!r}"
        return f"the {kind}s {render[kind]} the render gives where the page has {page[kind]}"
    had, got = body_text(published), body_text(rendered)
    if had != got:
        at = next((i for i, (a, b) in enumerate(zip(had, got)) if a != b), min(len(had), len(got)))
        return (f"the text the render gives, {got[max(0, at - 20):at + 20]!r}, where the "
                f"page has {had[max(0, at - 20):at + 20]!r}")
    return ""


def extract(out_dir: Path, name: str, page_html: str,
            refs: tuple[dict[str, dict], str] | None = None) -> str:
    """The body to keep for NAME, a page with no source, checked by a render
    from it (with refs, as _render takes them); RuntimeError names why it
    cannot be kept."""
    body = published_body(page_html)
    if body is None:
        raise RuntimeError("the page has no section.artifact-body")
    decorations = _Decorations()
    decorations.feed(body)
    decorations.close()
    if decorations.found:
        raise RuntimeError(f"its body holds {decorations.found[0]}, which publish writes "
                           "only from a source")
    try:
        rendered = published_body(_render(out_dir, name, page_html, "html",
                                          body.encode("utf-8"), refs)[0]) or ""
    except (RuntimeError, ValueError, KeyError) as exc:
        raise RuntimeError(f"a render from its body fails: {exc}") from None
    difference = first_difference(body, rendered)
    if difference:
        raise RuntimeError(difference)
    return body


def behind_origin(out_dir: Path) -> bool:
    """Whether origin's main has commits out_dir's branch lacks, fetched now;
    False when out_dir is not the top of a repository with an origin."""
    if not is_repository_top(out_dir) or _git(out_dir, "remote", "get-url", "origin").returncode:
        return False
    _git_ok(out_dir, "fetch", "origin")
    if _git(out_dir, "rev-parse", "--verify", "--quiet", "refs/remotes/origin/main").returncode:
        return False
    return bool(_git(out_dir, "merge-base", "--is-ancestor", "origin/main", "HEAD").returncode)


def commit_sources(out_dir: Path, written: list[Path]) -> None:
    """Commit only the sources written, and push them when origin's main is
    still behind this branch; a push refused leaves no commit and no source.
    The pages were checked as they stand here, so a newer page never comes
    in under a source taken from an older one."""
    if not is_repository_top(out_dir):
        return
    names = [path.name for path in written]
    committed = False
    try:
        _git_ok(out_dir, "add", "--", *names)
        _git_ok(out_dir, "commit", "-q", "-m", "migrate pages", "--", *names)
        committed = True
        if not _git(out_dir, "remote", "get-url", "origin").returncode:
            _git_ok(out_dir, "push", "origin", "HEAD:main")
    except _GitFailed:
        # Only the sources written leave the index; anything else staged stays.
        if committed:
            _git(out_dir, "reset", "-q", "--soft", "HEAD~1")
        _git(out_dir, "reset", "-q", "HEAD", "--", *names)
        for path in written:
            path.unlink(missing_ok=True)
        raise


def migrate(out_dir: Path, check: bool) -> int:
    """Keep the body of each page with no source as its NAME.body.html,
    and commit once; with check, write nothing. 1 when a page is refused."""
    kept, extracted, refused = 0, {}, {}
    with publish_lock(out_dir):
        try:
            if behind_origin(out_dir):
                print("error: origin has pages this directory lacks: pull, then migrate; "
                      "nothing written", file=sys.stderr)
                return 1
        except _GitFailed as exc:
            print(f"error: {exc}; nothing written", file=sys.stderr)
            return 1
        pages = sorted(path for path in out_dir.glob("*.html")
                       if is_page_name(path.name) and path.is_file() and not path.is_symlink())
        for path in pages:
            name = path.name[:-len(".html")]
            if kept_source(out_dir, name) is not None:
                kept += 1
                continue
            try:
                extracted[name] = extract(out_dir, name, path.read_bytes().decode("utf-8"))
            except (RuntimeError, UnicodeDecodeError) as exc:
                refused[name] = str(exc)
        if extracted and not check:
            written = []
            for name, body in extracted.items():
                written.append(out_dir / f"{name}{BODY_SOURCE_SUFFIX}")
                write_atomic(written[-1], body.encode("utf-8"))
            try:
                commit_sources(out_dir, written)
            except _GitFailed as exc:
                print(f"error: {exc}; nothing kept", file=sys.stderr)
                return 1
    print(f"kept {kept}, extracted {len(extracted)}, refused {len(refused)}")
    for name, why in refused.items():
        print(f"refused {name}: {why}")
    return 1 if refused else 0


# A page's kinds in the diff report, the order its counts are given in.
DIFF_KINDS = ("same", "markup", "text", "anchors", "failed")


def anchor_changes(published: str, rendered: str) -> list[dict]:
    """Each anchor the render gives other than the body published does, the
    two lists of a kind aligned on the anchors both hold: {kind, page,
    render}, None where one has none. An element with no anchor, such as
    an h2 with no id, is no anchor to detach."""
    page, render = ({kind: [value for value in values if value]
                     for kind, values in anchors(body).items()}
                    for body in (published, rendered))
    changes = []
    for kind in page:
        matcher = SequenceMatcher(None, page[kind], render[kind], autojunk=False)
        for op, had_from, had_to, got_from, got_to in matcher.get_opcodes():
            if op != "equal":
                changes += [{"kind": kind, "page": had, "render": got} for had, got in
                            zip_longest(page[kind][had_from:had_to],
                                        render[kind][got_from:got_to])]
    return changes


def _anchor_words(change: dict) -> str:
    had, got = change["page"], change["render"]
    if had is None:
        return f"{change['kind']} {got!r} only in the render"
    if got is None:
        return f"{change['kind']} {had!r} only in the file"
    return f"{change['kind']} {had!r} in the file, {got!r} in the render"


def diff_page(out_dir: Path, name: str) -> dict:
    """How NAME's body as rendered now from its kept source differs from its
    published file's: {name, kind, sections, anchors, error, what}."""
    found = {"name": name, "kind": "same", "sections": [], "anchors": [], "error": "",
             "what": ""}
    try:
        page_html = (out_dir / f"{name}.html").read_bytes().decode("utf-8")
        rendered_html = render_kept(out_dir, name)[0]
        published, rendered = published_body(page_html), published_body(rendered_html)
        if published is None or rendered is None:
            raise RuntimeError("no section.artifact-body")
    except (OSError, RuntimeError, ValueError, KeyError) as exc:
        return {**found, "kind": "failed", "error": str(exc), "what": str(exc)}
    if published == rendered:
        return found
    found["anchors"] = anchor_changes(published, rendered)
    words = [_anchor_words(change) for change in found["anchors"]]
    # The whole body's text, block boundaries kept as history reads them;
    # where its sections split is no change of text.
    text_changed = len({" ".join(" ".join(section.text for section in
                                          history.sections(html_)).split())
                        for html_ in (page_html, rendered_html)}) > 1
    if text_changed:
        compared = history.compare(page_html, rendered_html)
        titles = [section["title"] for part in ("changed", "added", "removed")
                  for section in compared["sections"][part]]
        found["sections"] = list(dict.fromkeys(titles))
        words.append(history.summary(compared) if titles else "the text changed")
    found["kind"] = "anchors" if found["anchors"] else "text" if text_changed else "markup"
    found["what"] = "; ".join(words)
    return found


def diff(out_dir: Path, as_json: bool) -> int:
    """Report each page whose body a render now gives differently from its
    published file; write nothing. 1 when a page's render failed."""
    with publish_lock(out_dir, create=False):
        names = sorted(path.name[:-len(".html")] for path in out_dir.glob("*.html")
                       if is_page_name(path.name) and path.is_file() and not path.is_symlink())
        pages = [diff_page(out_dir, name) for name in names]
    counts = {"pages": len(pages), **{kind: sum(page["kind"] == kind for page in pages)
                                       for kind in DIFF_KINDS}}
    shown = [page for page in pages if page["kind"] != "same"]
    if as_json:
        print(json.dumps({"pages": [{key: page[key] for key in
                                     ("name", "kind", "sections", "anchors", "error")}
                                    for page in shown], "counts": counts}, indent=2))
    else:
        for page in shown:
            print("  ".join(filter(None, (page["name"], page["kind"], page["what"]))))
        print(f"{counts['pages']} pages: "
              + ", ".join(f"{counts[kind]} {kind}" for kind in DIFF_KINDS))
    return 1 if counts["failed"] else 0


def _out_dir(args: argparse.Namespace) -> Path | None:
    out_dir = (Path(args.out_dir) if args.out_dir else DEFAULT_OUTPUT_DIR).resolve()
    if not out_dir.is_dir():
        print(f"error: no output directory {out_dir}", file=sys.stderr)
        return None
    return out_dir


def cmd_pages_diff(args: argparse.Namespace) -> int:
    out_dir = _out_dir(args)
    return 1 if out_dir is None else diff(out_dir, args.json)


def cmd_pages_migrate(args: argparse.Namespace) -> int:
    out_dir = _out_dir(args)
    return 1 if out_dir is None else migrate(out_dir, args.check)
