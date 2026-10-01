"""Each h2 section of a page wrapped, so the page script can fold it.

`wrap_sections()` runs on the body last, after the comment boxes are placed.
The content of each h2 section, from just after its heading to the next
section's heading or the end of the body, goes in one
`div.artifact-section-body` whose `data-section` is the heading's id; the
heading stays outside it, and the intro before the first h2 is never
wrapped. Sections start where the comment boxes' do (an h2 inside a
`pre.mermaid` or a form starts none), so a section's box and decision forms
always fall inside its wrapper.

A body is wrapped all or nothing: only when it has two or more sections,
every one headed by an h2 with an id that is a direct child of the body.
Any other body is left exactly as written. No wrapper is written hidden: a
page without its script shows everything.
"""

from __future__ import annotations

import html

from lotuspod.comments import MIN_SECTIONS, _SectionFinder

WRAPPER_CLASS = "artifact-section-body"
# Elements with no end tag, which open no depth.
_VOID = frozenset({
    "br", "img", "input", "hr", "wbr", "source", "col", "area", "embed", "track", "meta",
    "link",
})


class _TopSections(_SectionFinder):
    """_SectionFinder, also noting where each heading ends and whether it
    is a direct child of the body."""

    def __init__(self, body: str) -> None:
        super().__init__(body)
        self._body = body
        self._stack: list[str] = []

    def handle_starttag(self, tag: str, attrs: list) -> None:
        opened = self._open
        super().handle_starttag(tag, attrs)
        if self._open is not None and self._open is not opened:
            self._open["top"] = not self._stack
        if tag not in _VOID:
            self._stack.append(tag)

    def handle_endtag(self, tag: str) -> None:
        if tag == "h2" and self._open is not None and not self._mermaid_depth:
            close = self._body.find(">", self._offset())
            if close >= 0:
                self._open["end"] = close + 1
        super().handle_endtag(tag)
        # An end tag closes its element and any left open inside it; one
        # with nothing to close is ignored, as a browser ignores it.
        if tag in self._stack:
            while self._stack.pop() != tag:
                pass


def wrap_sections(body: str) -> tuple[str, bool]:
    """The body with each section's content wrapped, and whether it was."""
    finder = _TopSections(body)
    finder.feed(body)
    finder.close()
    headings = finder.headings
    if len(headings) < MIN_SECTIONS or not all(
        heading["id"] and heading.get("top") and "end" in heading for heading in headings
    ):
        return body, False
    ends = [heading["start"] for heading in headings[1:]] + [len(body)]
    pieces: list[str] = [body[:headings[0]["start"]]]
    for heading, end in zip(headings, ends):
        content = body[heading["end"]:end]
        pieces.append(body[heading["start"]:heading["end"]])
        pieces.append(
            f'\n<div class="{WRAPPER_CLASS}" data-section="{html.escape(heading["id"])}">'
        )
        pieces.append(content)
        if not content.endswith("\n"):
            pieces.append("\n")
        pieces.append("</div>\n")
    return "".join(pieces), True
