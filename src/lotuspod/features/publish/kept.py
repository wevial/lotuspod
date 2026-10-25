"""kept: a page rendered again from what it keeps (render_kept), and
`lotuspod pages migrate`, which keeps the body of each page published only as
HTML as its NAME.body.html once a render from it gives the page back."""

from __future__ import annotations

import argparse
import html
import sys
from html.parser import HTMLParser
from pathlib import Path

from lotuspod.core import (BODY_SOURCE_SUFFIX, DEFAULT_OUTPUT_DIR, _KEPT_SOURCE_SUFFIX,
                           commit_output, extract_meta, html_title, is_page_name, normalized,
                           publish_lock, published_body, write_atomic)
from lotuspod.features import agents
from lotuspod.features import comments
from lotuspod.features import decisions
from lotuspod.features import widgets
from lotuspod.features.publish import markdown, media
from lotuspod.features.publish.publish import kept_refs
from lotuspod.features.publish.render import (_H2Collector, build_page, page_owner,
                                              page_variant, version_stamp)


_OUTLINE_MARK = '<nav class="artifact-outline"'


def kept_source(out_dir: Path, name: str) -> tuple[str, bytes] | None:
    """(format, bytes) of NAME's kept source; None when it keeps none."""
    for fmt, suffix in _KEPT_SOURCE_SUFFIX.items():
        path = out_dir / f"{name}{suffix}"
        if path.is_file():
            return fmt, path.read_bytes()
    return None


def _render(out_dir: Path, name: str, page_html: str, fmt: str,
            data: bytes) -> tuple[str, dict[str, bytes]]:
    """NAME rendered from a source of fmt, with the stamps page_html carries."""
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
    refs, refs_as_of = kept_refs(out_dir, name)
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
    page_html = (out_dir / f"{name}.html").read_text(encoding="utf-8")
    kept = kept_source(out_dir, name)
    if kept is None:
        raise RuntimeError(f"{name} keeps no source")
    return _render(out_dir, name, page_html, *kept)


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
            if tag == mark_tag and mark_class in classes and what not in self.found:
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


def extract(out_dir: Path, name: str, page_html: str) -> str:
    """The body to keep for NAME, a page with no source, checked by a render
    from it; RuntimeError names why it cannot be kept."""
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
                                          body.encode("utf-8"))[0]) or ""
    except (RuntimeError, ValueError, KeyError) as exc:
        raise RuntimeError(f"a render from its body fails: {exc}") from None
    difference = first_difference(body, rendered)
    if difference:
        raise RuntimeError(difference)
    return body


def migrate(out_dir: Path, check: bool) -> int:
    """Keep the body of each page with no source as its NAME.body.html,
    and commit once; with check, write nothing. 1 when a page is refused."""
    kept, extracted, refused = 0, {}, {}
    with publish_lock(out_dir):
        pages = sorted(path for path in out_dir.glob("*.html")
                       if is_page_name(path.name) and path.is_file() and not path.is_symlink())
        for path in pages:
            name = path.name[:-len(".html")]
            if kept_source(out_dir, name) is not None:
                kept += 1
                continue
            try:
                extracted[name] = extract(out_dir, name, path.read_text(encoding="utf-8"))
            except (RuntimeError, UnicodeDecodeError) as exc:
                refused[name] = str(exc)
        if extracted and not check:
            for name, body in extracted.items():
                write_atomic(out_dir / f"{name}{BODY_SOURCE_SUFFIX}", body.encode("utf-8"))
            commit_output(out_dir, "migrate pages")
    print(f"kept {kept}, extracted {len(extracted)}, refused {len(refused)}")
    for name, why in refused.items():
        print(f"refused {name}: {why}")
    return 1 if refused else 0


def cmd_pages_migrate(args: argparse.Namespace) -> int:
    out_dir = (Path(args.out_dir) if args.out_dir else DEFAULT_OUTPUT_DIR).resolve()
    if not out_dir.is_dir():
        print(f"error: no output directory {out_dir}", file=sys.stderr)
        return 1
    return migrate(out_dir, args.check)
