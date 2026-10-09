"""Ticket keys and pull request numbers on a page, each opening a card.

`lotuspod publish --refs FILE` reads a JSON object `{"refs": {KEY: ENTRY}}`
the publisher writes: Lotuspod looks nothing up itself. A KEY is a ticket key
(`HOLO-175`) or a pull request (`#2266`, `relos#2266`); an ENTRY has a
`title` and may have a `project`, `status`, `summary`, `tone`, `updated`,
`pr` and `board` (FIELDS). `check_refs()` refuses a file that breaks any rule
with one line naming the key and the field.

`mark_refs()` runs on the body after the decision forms are drawn and before
the outline. Each whole-word mention of a key the file holds, in text outside
SKIP, becomes a `button.artifact-ref` spliced in at the parser's offsets, so
the rest of the body stays byte for byte as written. One card per key used
goes in a `div.artifact-ref-cards` the template writes after the body, never
in it, so no passage, section or comment box takes in a card's text. Each
card is hidden: the page script shows it.
"""

from __future__ import annotations

import datetime
import html
import json
import re
from html.parser import HTMLParser
from urllib.parse import urlsplit

# cli imports this module too: only names used at call time are read from it.
from lotuspod import cli

REF_CLASS = "artifact-ref"
CARDS_CLASS = "artifact-ref-cards"
CARD_CLASS = "artifact-ref-card"
ID_PREFIX = "ref-"
TICKET = re.compile(r"[A-Z][A-Z0-9]*-[0-9]+")
PULL = re.compile(r"(?:[a-z0-9][a-z0-9._-]*)?#[0-9]+")
# A key in text: whole, so not after a letter, digit, "_", "-", "/" or "#",
# and not before a letter, digit or "_", in any script (\w, as str patterns
# match it). A repository goes before its "#".
_MENTION = re.compile(
    r"(?<![\w/#-])(?:[A-Z][A-Z0-9]*-[0-9]+|(?:[a-z0-9][a-z0-9._-]*)?#[0-9]+)"
    r"(?!\w)"
)
# An ISO 8601 date, or date and time with a "T", seconds, fraction and
# offset optional; fromisoformat then checks each part's range, but takes
# any separator and other forms, so it is not the check alone.
_ISO_TIME = re.compile(
    r"\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?",
    re.ASCII,
)
TONES = ("merged", "review", "progress", "waiting")
DEFAULT_TONE = "waiting"
# Each text field's longest length, in characters.
TEXTS = {"title": 200, "project": 60, "status": 40, "summary": 400}
LINKS = ("pr", "board")
FIELDS = frozenset({*TEXTS, "tone", "updated", *LINKS})
# A mention in text inside one of these is left as written: a button may not
# sit in a link, a button or a form's controls, and code, headings and
# summaries are read as they are.
SKIP = frozenset({
    "a", "code", "pre", "button", "form", "h1", "h2", "h3", "h4", "h5", "h6", "summary",
    "textarea", "script", "style", "svg", "select",
})
# Elements with no end tag, which open no depth.
_VOID = frozenset({
    "br", "img", "input", "hr", "wbr", "source", "col", "area", "embed", "track", "meta",
    "link", "param", "base",
})
# Inline elements: a word may run on through their tags, the skipped ones
# among them, whose text is never marked but still joins the words beside
# it (<code>X</code>HOLO-175 reads XHOLO-175).
_INLINE = frozenset({
    "a", "abbr", "b", "bdi", "bdo", "button", "cite", "code", "data", "del", "dfn", "em",
    "i", "ins", "kbd", "label", "mark", "output", "q", "s", "samp", "select", "small",
    "span", "strong", "sub", "sup", "textarea", "time", "u", "var", "wbr",
})
# Elements whose text is never shown: it neither joins nor ends a word.
_UNSHOWN = frozenset({"script", "style", "template"})


def is_key(key: str) -> bool:
    return bool(TICKET.fullmatch(key) or PULL.fullmatch(key))


def shown(text: str) -> str:
    """text for a one-line message: each character that is not printable,
    a newline among them, written as its \\u escape."""
    return "".join(char if char.isprintable() else f"\\u{ord(char):04x}" for char in text)


def _refused(key: str, field: str, why: str) -> RuntimeError:
    # Keys and fields come from the file: one may hold a newline.
    where = f"refs {shown(key)}" + (f" {shown(field)}" if field else "")
    return RuntimeError(f"{where}: {why}; nothing written")


def _link(key: str, field: str, value: object) -> dict:
    if not isinstance(value, dict):
        raise _refused(key, field, 'not an object {"text", "href"}')
    for name in value:
        if name not in ("text", "href"):
            raise _refused(key, f"{field}.{name}", "not a field of a link")
    text, href = value.get("text"), value.get("href")
    if not isinstance(text, str):
        raise _refused(key, f"{field}.text", "not text")
    try:
        # A URL urlsplit cannot read, such as https://[, is no URL either.
        parts = urlsplit(href) if isinstance(href, str) else None
    except ValueError:
        parts = None
    if parts is None or parts.scheme not in ("http", "https") or not parts.netloc \
            or any(c.isspace() or ord(c) < 32 for c in href):
        raise _refused(key, f"{field}.href", "not an http or https URL")
    return {"text": text, "href": href}


def _entry(key: str, value: object) -> dict:
    if not is_key(key):
        raise _refused(key, "", "not a ticket key (HOLO-175) or pull request (#2266, "
                                "relos#2266)")
    if not isinstance(value, dict):
        raise _refused(key, "", "not an object")
    for field in value:
        if field not in FIELDS:
            raise _refused(key, field, "not a field of a reference")
    entry: dict = {}
    for field, most in TEXTS.items():
        if field not in value:
            if field == "title":
                raise _refused(key, field, "missing")
            continue
        text = value[field]
        # The title is required, so it may not be empty; the others may.
        if field == "title" and (not isinstance(text, str) or not text.strip()):
            raise _refused(key, field, f"not text of 1 to {most} characters")
        if not isinstance(text, str) or len(text) > most:
            raise _refused(key, field, f"not text of at most {most} characters")
        entry[field] = text
    tone = value.get("tone", DEFAULT_TONE)
    if tone not in TONES:
        raise _refused(key, "tone", f"not one of {', '.join(TONES)}")
    entry["tone"] = tone
    if "updated" in value:
        updated = value["updated"]
        try:
            if not isinstance(updated, str) or not _ISO_TIME.fullmatch(updated):
                raise ValueError
            datetime.datetime.fromisoformat(updated.replace("Z", "+00:00"))
        except ValueError:
            raise _refused(key, "updated", "not an ISO 8601 time") from None
        entry["updated"] = updated
    for field in LINKS:
        if field in value:
            entry[field] = _link(key, field, value[field])
    return entry


def check_refs(data: object) -> dict[str, dict]:
    """The entries of a refs file's parsed JSON, each checked; RuntimeError
    naming the first key and field that breaks a rule."""
    if not isinstance(data, dict):
        raise _refused("file", "", 'not an object {"refs": {KEY: ENTRY}}')
    for name in data:
        if name != "refs":
            raise _refused("file", name, 'not a field of a refs file: only "refs"')
    refs = data.get("refs")
    if not isinstance(refs, dict):
        raise _refused("file", "refs", "not an object of KEY: ENTRY")
    return {key: _entry(key, value) for key, value in refs.items()}


def parse_refs(raw: bytes, label: str) -> dict[str, dict]:
    """The checked entries of a refs file's bytes; RuntimeError when they are
    not JSON, or break a rule."""
    try:
        data = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError) as exc:
        raise RuntimeError(f"refs {shown(label)}: not JSON ({exc}); nothing written") \
            from None
    return check_refs(data)


class _TextFinder(HTMLParser):
    """Locate the body's runs of text: source span, whether a mention in it
    may be marked, and the text either side of it.

    Spans are recorded against the source string, as _H2Collector's are, so
    a mention is marked without re-serializing anything around it. Character
    references are read as written: no key holds one.
    """

    def __init__(self, body: str) -> None:
        super().__init__(convert_charrefs=False)
        self._body = body
        self._line_starts = [0]
        for index, char in enumerate(body):
            if char == "\n":
                self._line_starts.append(index + 1)
        self._stack: list[str] = []
        self._skip = 0
        # False after a tag that ends a word: a block, or a skipped element.
        self._joined = False
        self.runs: list[dict] = []
        # Every element's id, and the slug of each h2 without one, in page
        # order: the outline gives such headings ids from those slugs.
        self.ids: set[str] = set()
        self.slugs: list[str] = []
        self._heading: list[str] | None = None

    def _offset(self) -> int:
        line, column = self.getpos()
        return self._line_starts[line - 1] + column

    def _tag(self, tag: str) -> None:
        if tag not in _INLINE and tag not in _UNSHOWN:
            self._joined = False

    def handle_starttag(self, tag: str, attrs: list) -> None:
        explicit = next((v for k, v in attrs if k == "id" and v), "")
        if explicit:
            self.ids.add(explicit)
        self._tag(tag)
        if tag in _VOID:
            return
        if tag == "h2" and not explicit:
            self._heading = []
        self._stack.append(tag)
        if tag in SKIP:
            self._skip += 1

    def handle_startendtag(self, tag: str, attrs: list) -> None:
        explicit = next((v for k, v in attrs if k == "id" and v), "")
        if explicit:
            self.ids.add(explicit)
        self._tag(tag)

    def handle_endtag(self, tag: str) -> None:
        self._tag(tag)
        if tag == "h2" and self._heading is not None:
            self.slugs.append(cli.slugify(" ".join("".join(self._heading).split())))
            self._heading = None
        # An end tag closes its element and any left open inside it; one
        # with nothing to close is ignored, as a browser ignores it.
        if tag in self._stack:
            while True:
                closed = self._stack.pop()
                if closed in SKIP:
                    self._skip -= 1
                if closed == tag:
                    break

    def _text(self, text: str, start: int, end: int, open_: bool) -> None:
        if any(tag in _UNSHOWN for tag in self._stack):
            return
        if self._heading is not None:
            self._heading.append(text)
        run = {"start": start, "end": end, "text": text, "open": open_ and not self._skip,
               "before": " ", "after": " "}
        if self._joined and self.runs:
            last = self.runs[-1]
            last["after"] = text[:1] or " "
            run["before"] = last["text"][-1:] or " "
        self.runs.append(run)
        self._joined = True

    def handle_data(self, data: str) -> None:
        start = self._offset()
        self._text(data, start, start + len(data), True)

    def handle_entityref(self, name: str) -> None:
        self._text(html.unescape(f"&{name};"), self._offset(), self._offset(), False)

    def handle_charref(self, name: str) -> None:
        self._text(html.unescape(f"&#{name};"), self._offset(), self._offset(), False)

    def handle_comment(self, data: str) -> None:
        """A comment is never shown: the words either side of it run on,
        as the reader sees them, so it ends no word."""


def card_id(key: str, taken: set[str]) -> str:
    """The id of key's card, taken from those already used."""
    return cli._unique_id(ID_PREFIX + cli.slugify(key), taken)


def _time(stamp: str) -> str:
    esc = html.escape
    return f'<time datetime="{esc(stamp)}">{esc(stamp)}</time>'


def card(key: str, entry: dict, card_id_: str, as_of: str) -> str:
    """The card of one reference, hidden, every text escaped."""
    esc = html.escape
    head = f"{entry['project']} · {key}" if entry.get("project") else key
    lines = [
        f'<div class="{CARD_CLASS}" id="{esc(card_id_)}" role="dialog" '
        f'aria-label="{esc(key)}" data-tone="{esc(entry.get("tone", DEFAULT_TONE))}" hidden>',
        f'<p class="artifact-ref-card-key">{esc(head)}</p>',
        f'<p class="artifact-ref-card-title">{esc(entry["title"])}</p>',
    ]
    state = []
    if entry.get("status"):
        state.append(f'<span class="artifact-ref-chip">{esc(entry["status"])}</span>')
    if entry.get("updated"):
        state.append(f'<span class="artifact-ref-card-updated">Updated '
                     f'{_time(entry["updated"])}</span>')
    if state:
        lines.append(f'<p class="artifact-ref-card-state">{" ".join(state)}</p>')
    if entry.get("summary"):
        lines.append(f'<p class="artifact-ref-card-summary">{esc(entry["summary"])}</p>')
    links = []
    if entry.get("pr"):
        links.append(f'<a class="artifact-ref-card-pr" href="{esc(entry["pr"]["href"])}">'
                     f'{esc(entry["pr"]["text"])}</a>')
    elif TICKET.fullmatch(key):
        links.append('<span class="artifact-ref-card-nopr">No PR yet</span>')
    if entry.get("board"):
        links.append(f'<a class="artifact-ref-card-board" href="{esc(entry["board"]["href"])}">'
                     f'{esc(entry["board"]["text"])}</a>')
    if links:
        lines.append('<p class="artifact-ref-card-links">' + "".join(links) + "</p>")
    lines.append(f'<p class="artifact-ref-card-asof">As of publish {_time(as_of)}</p>')
    lines.append("</div>")
    return "\n".join(lines)


def mark_refs(body: str, refs: dict[str, dict], as_of: str = "") -> tuple[str, str, list[str]]:
    """The body with each mention of a key refs holds a button; the cards'
    block ("" when no key is named); and the keys named, in page order.

    Each card's as-of line names as_of, the time the refs were taken.
    """
    if not refs:
        return body, "", []
    finder = _TextFinder(body)
    finder.feed(body)
    finder.close()
    taken = set(finder.ids)
    # Every id the outline could give a heading, as outline_body gives them:
    # repeated headings take base, base-2, base-3, ... in page order.
    for slug in finder.slugs:
        taken.add(cli._unique_id(slug, taken))
    ids: dict[str, str] = {}
    pieces: list[str] = []
    cursor = 0
    esc = html.escape
    for run in finder.runs:
        if not run["open"]:
            continue
        # One character of the text either side, so a word running on
        # through an inline tag is still one word.
        padded = run["before"] + run["text"] + run["after"]
        for match in _MENTION.finditer(padded):
            start, end = match.start() - 1, match.end() - 1
            key = match.group(0)
            if start < 0 or end > len(run["text"]) or key not in refs:
                continue
            if key not in ids:
                ids[key] = card_id(key, taken)
                taken.add(ids[key])
            at = run["start"] + start
            pieces.append(body[cursor:at])
            pieces.append(
                f'<button type="button" class="{REF_CLASS}" data-ref="{esc(key)}" '
                f'aria-expanded="false" aria-controls="{esc(ids[key])}">{esc(key)}</button>'
            )
            cursor = at + len(key)
    if not ids:
        return body, "", []
    pieces.append(body[cursor:])
    cards = "\n".join(card(key, refs[key], card_id_, as_of) for key, card_id_ in ids.items())
    # The template writes the block straight after the body's section.
    block = f'\n      <div class="{CARDS_CLASS}">\n{cards}\n</div>'
    return "".join(pieces), block, list(ids)
