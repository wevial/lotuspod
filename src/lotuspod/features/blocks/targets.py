"""The spots a comment thread may be anchored to: a page's Mermaid diagrams
and its stored images, each with an id and a hash.

A diagram is a `pre.mermaid`; an image is an `img` inside a
`figure.artifact-figure` whose `src` is a stored name under /media/. Neither
counts inside another diagram, a `template` or a `noscript`. Each one's
section is the id of the last h2 before it that starts one (an h2 in a
diagram, a form or a template starts none), "" before the first.

Ids: a diagram's is the `data-spot` its `pre` carries (a `mermaid id=NAME`
fence writes it), else SECTION-diagram-N, N counted from 1 among the
diagrams of its section (`diagram-N` before the first heading). An image's
is the slug of its alt text, else SECTION-figure-N (`figure-N` before the
first heading). A `data-spot` that is not SPOT_ID, or that an earlier one
took, makes its element no target. A slug or counted id another target
has takes -2, -3 in page order.

Hashes: a diagram's is the first 12 hex digits of the SHA-256 of its text,
entities decoded, as Mermaid reads it; an image's the first 12 of its stored
name, which is its SHA-256. A diagram's title is its section's heading
text, "" before the first; an image's its alt text.

`mark_targets()` runs on the body once its h2s have ids: it splices
`data-spot` (when the element has none) and `data-spot-hash` (when it has
none, or one other than its hash, which it takes out) into each target's
start tag at the parser's offsets, so the rest of
the body stays byte for byte as written. `PageTargets` reads a page's
targets from its HTML by the same rules, with or without those attributes.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass
from html.parser import HTMLParser

from lotuspod.core import URL_PREFIX, Templates, _unique_id
from lotuspod.features.blocks.node_tables import _ATTRIBUTE, _TAG_NAME, _with_attributes

DIAGRAM = "diagram"
IMAGE = "image"
SPOT_ATTRIBUTE = "data-spot"
HASH_ATTRIBUTE = "data-spot-hash"
FIGURE_CLASS = "artifact-figure"
# An explicit id: a fence's, checked at publish, or one written in HTML.
SPOT_ID = re.compile(r"[A-Za-z0-9_-]+")
_STORED = re.compile(re.escape(URL_PREFIX) + r"([0-9a-f]{64})\.[a-z]+")
_SLUG_STRIP = re.compile(r"[^a-z0-9]+")


@dataclass(frozen=True)
class Target:
    """One spot target as the page shows it."""

    kind: str
    hash: str
    title: str
    section: str
    # A diagram's text as Mermaid reads it; "" for an image.
    source: str = ""
    # An image's /media/ URL and the size its tag gives (render writes its
    # natural size; serve reads that from the media store); "" and 0 for a diagram.
    src: str = ""
    width: int = 0
    height: int = 0


def _size(value: str | None) -> int:
    return int(value) if value and value.isdigit() else 0


class _TargetFinder(HTMLParser):
    """Each diagram and stored image in page order, with its start tag's
    source offset, its section and its section's heading text."""

    CDATA_CONTENT_ELEMENTS = Templates.CDATA_CONTENT_ELEMENTS

    def __init__(self, text: str) -> None:
        super().__init__(convert_charrefs=True)
        self._line_starts = [0]
        for index, char in enumerate(text):
            if char == "\n":
                self._line_starts.append(index + 1)
        self.found: list[dict] = []
        self._templates = 0
        self._mermaid = 0
        self._forms = 0
        self._figures = 0
        self._section = ""
        self._title = ""
        # The h2 being read: its id and its text so far.
        self._heading: dict | None = None
        self._pre: dict | None = None

    def _offset(self) -> int:
        line, column = self.getpos()
        return self._line_starts[line - 1] + column

    def _candidate(self, kind: str, attrs: dict) -> dict:
        return {"kind": kind, "start": self._offset(), "tag": self.get_starttag_text() or "",
                "attrs": attrs, "section": self._section, "sectionTitle": self._title}

    def handle_starttag(self, tag: str, attrs: list) -> None:
        attrs = dict(attrs)
        classes = (attrs.get("class") or "").split()
        if tag == "template":
            self._templates += 1
        elif self._templates:
            return
        elif tag == "pre" and (self._mermaid or "mermaid" in classes):
            self._mermaid += 1
            if self._mermaid == 1:
                self._pre = {**self._candidate(DIAGRAM, attrs), "text": []}
        elif self._mermaid:
            return
        elif tag == "form":
            self._forms += 1
        elif tag == "h2" and not self._forms:
            self._heading = {"id": attrs.get("id") or "", "text": []}
        elif tag == "figure" and FIGURE_CLASS in classes:
            self._figures += 1
        elif tag == "figure" and self._figures:
            self._figures += 1
        elif tag == "img" and self._figures and _STORED.fullmatch(attrs.get("src") or ""):
            self.found.append(self._candidate(IMAGE, attrs))

    def handle_data(self, data: str) -> None:
        if self._templates:
            return
        if self._pre is not None and self._mermaid == 1:
            self._pre["text"].append(data)
        elif self._heading is not None and not self._mermaid:
            self._heading["text"].append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "template" and self._templates:
            self._templates -= 1
        elif self._templates:
            return
        elif tag == "pre" and self._mermaid:
            self._mermaid -= 1
            if not self._mermaid and self._pre is not None:
                self._pre["text"] = "".join(self._pre["text"])
                self.found.append(self._pre)
                self._pre = None
        elif self._mermaid:
            return
        elif tag == "form" and self._forms:
            self._forms -= 1
        elif tag == "h2" and self._heading is not None:
            self._section = self._heading["id"]
            self._title = " ".join("".join(self._heading["text"]).split())
            self._heading = None
        elif tag == "figure" and self._figures:
            self._figures -= 1


def _targets(text: str) -> list[tuple[str, Target, dict]]:
    """Each target of text in page order: its id, the target and the
    finder's record of its start tag."""
    finder = _TargetFinder(text)
    finder.feed(text)
    finder.close()
    explicit: dict[int, str] = {}
    taken: set[str] = set()
    for candidate in finder.found:
        ident = candidate["attrs"].get(SPOT_ATTRIBUTE)
        if ident is None:
            continue
        if SPOT_ID.fullmatch(ident) and ident not in taken:
            explicit[candidate["start"]] = ident
            taken.add(ident)
        else:
            candidate["refused"] = True
    counts: dict[tuple[str, str], int] = {}
    found = []
    for candidate in finder.found:
        if candidate.get("refused"):
            continue
        kind, section, attrs = candidate["kind"], candidate["section"], candidate["attrs"]
        counts[kind, section] = number = counts.get((kind, section), 0) + 1
        ident = explicit.get(candidate["start"])
        if ident is None:
            counted = f"{DIAGRAM if kind == DIAGRAM else 'figure'}-{number}"
            slug = _SLUG_STRIP.sub("-", (attrs.get("alt") or "").lower()).strip("-")
            base = (slug if kind == IMAGE and slug
                    else f"{section}-{counted}" if section else counted)
            ident = _unique_id(base, taken)
            taken.add(ident)
        if kind == DIAGRAM:
            source = candidate["text"]
            target = Target(DIAGRAM, hashlib.sha256(source.encode("utf-8")).hexdigest()[:12],
                            candidate["sectionTitle"], section, source=source)
        else:
            src = attrs["src"]
            target = Target(IMAGE, _STORED.fullmatch(src).group(1)[:12], attrs.get("alt") or "",
                            section, src=src, width=_size(attrs.get("width")),
                            height=_size(attrs.get("height")))
        found.append((ident, target, candidate))
    return found


def _without_attribute(tag: str, name: str) -> str:
    """A start tag's source with every attribute called name taken out."""
    at = _TAG_NAME.match(tag).end()
    while (match := _ATTRIBUTE.match(tag, at)) is not None and match.end() > at:
        if match.group(1).lower() == name:
            tag = tag[:at] + tag[match.end():]
        else:
            at = match.end()
    return tag


def mark_targets(body: str) -> str:
    """The body with each target's id and hash on its start tag."""
    pieces: list[str] = []
    cursor = 0
    for ident, target, candidate in _targets(body):
        start, tag = candidate["start"], candidate["tag"]
        attrs = candidate["attrs"]
        # A hash carried over from an earlier render of other source is
        # replaced, so the page never names a hash its target no longer has.
        stale = attrs.get(HASH_ATTRIBUTE, target.hash) != target.hash
        added = {}
        if SPOT_ATTRIBUTE not in attrs:
            added[SPOT_ATTRIBUTE] = ident
        if HASH_ATTRIBUTE not in attrs or stale:
            added[HASH_ATTRIBUTE] = target.hash
        if not added:
            continue
        marked = _without_attribute(tag, HASH_ATTRIBUTE) if stale else tag
        pieces += [body[cursor:start], _with_attributes(marked, added)]
        cursor = start + len(tag)
    pieces.append(body[cursor:])
    return "".join(pieces)


class PageTargets:
    """A page's targets, read from its HTML: found maps each id to its
    Target, in page order."""

    def __init__(self, text: str) -> None:
        self.found: dict[str, Target] = {}
        # Most pages have neither: skip parsing them.
        if "mermaid" in text or FIGURE_CLASS in text:
            self.found = {ident: target for ident, target, _ in _targets(text)}
