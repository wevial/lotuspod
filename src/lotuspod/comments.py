"""A comment box at the end of every section of a page.

`render_comments()` runs on the body after the outline pass has given each
h2 its id, so markdown and HTML sources alike get it. Each h2 section, from
its heading to the next h2 or the end of the body, ends with a
`details.artifact-comment` carrying `data-page` and `data-section` (the
heading's id); a body with fewer than two h2 sections gets one box, section
`page`, at its end. A box holds its section's threads, which the page script
fills in, and a form to start a new one.

Headings inside a `pre.mermaid` are diagram source, and headings inside a
form start no section: a box never lands inside a diagram or a form.

`read_boxes()` reads the boxes back from a finished page, which is how the
comments route knows which sections a page takes new threads on. A page
with section boxes also takes threads on the whole page, section WHOLE_PAGE.
"""

from __future__ import annotations

import html
from html.parser import HTMLParser

BOX_CLASS = "artifact-comment"
# The section of the one box a page with fewer than two h2 sections gets.
PAGE_SECTION = "page"
# The section of a thread on the whole page of a page with section boxes. No
# box carries it: the page script draws that page's box under its title.
WHOLE_PAGE = ""
MIN_SECTIONS = 2


class _SectionFinder(HTMLParser):
    """Locate the h2s that start sections: source offset, id and text.

    Offsets are recorded against the source string, as _H2Collector's are,
    so the body around each box is never re-serialized.
    """

    def __init__(self, body: str) -> None:
        super().__init__(convert_charrefs=True)
        self._line_starts = [0]
        for index, char in enumerate(body):
            if char == "\n":
                self._line_starts.append(index + 1)
        self._mermaid_depth = 0
        self._form_depth = 0
        self._open: dict | None = None
        self.headings: list[dict] = []

    def _offset(self) -> int:
        line, column = self.getpos()
        return self._line_starts[line - 1] + column

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag == "pre":
            classes = next((v for k, v in attrs if k == "class" and v), "").split()
            if self._mermaid_depth or "mermaid" in classes:
                self._mermaid_depth += 1
        if self._mermaid_depth:
            return
        if tag == "form":
            self._form_depth += 1
        elif tag == "h2" and not self._form_depth:
            self._finish()
            self._open = {
                "start": self._offset(),
                "id": next((v for k, v in attrs if k == "id" and v), ""),
                "text": [],
            }

    def handle_data(self, data: str) -> None:
        if self._open is not None:
            self._open["text"].append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "pre" and self._mermaid_depth:
            self._mermaid_depth -= 1
        elif self._mermaid_depth:
            return
        elif tag == "form" and self._form_depth:
            self._form_depth -= 1
        elif tag == "h2":
            self._finish()

    def _finish(self) -> None:
        if self._open is None:
            return
        self._open["text"] = " ".join("".join(self._open["text"]).split())
        self.headings.append(self._open)
        self._open = None

    def close(self) -> None:
        super().close()
        self._finish()


def box(page: str, section: str, title: str) -> str:
    """The comment box of one section."""
    esc = html.escape
    about = f"Comment on {title}" if title else "Comment on this page"
    return "\n".join((
        f'<details class="{BOX_CLASS}" data-page="{esc(page)}" data-section="{esc(section)}">',
        '<summary class="artifact-comment-summary">Comment</summary>',
        '<div class="artifact-comment-threads"></div>',
        '<form class="artifact-comment-form">',
        f'<textarea name="text" rows="3" maxlength="4000" required aria-label="{esc(about)}">'
        "</textarea>",
        '<div class="artifact-comment-actions"><button type="submit">Comment</button>'
        '<p class="artifact-comment-status" role="status"></p></div>',
        "</form>",
        "</details>",
    ))


def render_comments(body: str, page: str) -> str:
    """The body with a comment box ending each of its sections."""
    finder = _SectionFinder(body)
    finder.feed(body)
    finder.close()
    headings = finder.headings
    ends = [heading["start"] for heading in headings[1:]] + [len(body)]
    if len(headings) < MIN_SECTIONS or not all(heading["id"] for heading in headings):
        spans = [(PAGE_SECTION, "", len(body))]
    else:
        spans = [(heading["id"], heading["text"], end) for heading, end in zip(headings, ends)]
    pieces: list[str] = []
    cursor = 0
    for section, title, end in spans:
        pieces.append(body[cursor:end])
        if end == len(body) and body and not body.endswith("\n"):
            pieces.append("\n")
        pieces.append(box(page, section, title) + "\n")
        cursor = end
    pieces.append(body[cursor:])
    return "".join(pieces)


class _BoxReader(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.sections: list[str] = []

    def handle_starttag(self, tag: str, attrs: list) -> None:
        values = {key: value or "" for key, value in attrs}
        if tag == "details" and BOX_CLASS in values.get("class", "").split():
            section = values.get("data-section", "")
            if section and section not in self.sections:
                self.sections.append(section)


def read_boxes(page_html: str) -> list[str]:
    """The sections of the page's comment boxes, in page order."""
    reader = _BoxReader()
    reader.feed(page_html)
    reader.close()
    return reader.sections
