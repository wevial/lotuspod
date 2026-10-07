"""A page's "Decisions for the maintainer" tables, answered on the page.

Under each h2 or h3 whose text is "Decisions for the maintainer" (any case),
the first table before the next h2 (or the next such heading) whose header
row has a "Question" column becomes one radio form per row:
`render_decisions()` replaces it in the body HTML, so markdown and HTML
sources alike get it. A page may so ask each question in the section it is
about. `#`, `Options` and `Default` columns are optional; any other column
is shown under its question as context.

Each form carries `data-question` (`decision-` and the slug of its `#` cell,
or its row number in its table), unique across the page, and
`data-version`, a short hash of the question's text and its options' labels:
rewording a question strands the answers given to the old wording instead of
attaching them to the new words. A table with any row of fewer than two
options is left exactly as written.

`read_forms()` reads the forms back from a finished page, which is how the
answers route knows what a page asks and `lotuspod answers` its labels. Each
form's section is that of the first comment box after it, which ends the
form's own section: the comments route files a thread on the decision there.
"""

from __future__ import annotations

import hashlib
import html
import json
import re
from dataclasses import dataclass, field, replace
from html.parser import HTMLParser

# cli imports this module too: only names used at call time are read from it.
from lotuspod import cli, comments

HEADING = "decisions for the maintainer"
FORM_CLASS = "artifact-decision"
ID_PREFIX = "decision-"
VERSION_LENGTH = 12
# The options a row with a Default and no Options column offers.
ACCEPT = ("accept", "Accept the default")
OTHER = ("other", "Something else")
# The stylesheet draws the "· " before it.
DEFAULT_MARK = "default"

# Tags that end a table cell left open, at the table's own depth.
_CELL_ENDS = frozenset({"tr", "td", "th", "thead", "tbody", "tfoot"})
_SLUGGABLE = re.compile(r"[a-z0-9]")


@dataclass(frozen=True)
class Form:
    """One question as its page's form asks it."""

    question: str
    text: str
    version: str
    # (value, label) per option, in the page's order.
    options: tuple[tuple[str, str], ...]
    # The data-section of the first comment box after the form; "" when
    # none follows it. Where it is asked is not what it asks: not compared.
    section: str = field(default="", compare=False)

    def label(self, choice: str) -> str:
        """The label of the option valued choice; choice itself when none is."""
        return next((label for value, label in self.options if value == choice), choice)


def _text(parts: list[str]) -> str:
    return " ".join("".join(parts).split())


class _TableFinder(HTMLParser):
    """Locate the decisions tables: each one's source span and rows' cells.

    Spans are recorded against the source string, as _H2Collector's are, so
    a table that is not replaced is never re-serialized. Headings and tables
    inside a `pre.mermaid` are diagram source and are skipped.
    """

    def __init__(self, body: str) -> None:
        super().__init__(convert_charrefs=True)
        self._body = body
        self._line_starts = [0]
        for index, char in enumerate(body):
            if char == "\n":
                self._line_starts.append(index + 1)
        self._mermaid_depth = 0
        self._heading: list[str] | None = None
        # Whether a decisions heading is in force: until the next h2, or
        # until it has yielded its table.
        self._armed = False
        self._depth = 0
        self._candidate: dict | None = None
        self._cell: dict | None = None
        self.tables: list[dict] = []

    def _offset(self) -> int:
        line, column = self.getpos()
        return self._line_starts[line - 1] + column

    def _after_tag(self) -> int:
        return self._body.index(">", self._offset()) + 1

    def _close_cell(self) -> None:
        if self._cell is None or self._candidate is None:
            return
        cell = self._cell
        self._cell = None
        cell["html"] = self._body[cell.pop("start"):self._offset()].strip()
        cell["text"] = _text(cell["text"])
        if not self._candidate["rows"]:
            self._candidate["rows"].append([])
        self._candidate["rows"][-1].append(cell)

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag == "pre":
            classes = next((v for k, v in attrs if k == "class" and v), "").split()
            if self._mermaid_depth or "mermaid" in classes:
                self._mermaid_depth += 1
        if self._mermaid_depth:
            return
        if tag in ("h2", "h3") and not self._depth:
            if tag == "h2":
                self._armed = False
            self._heading = []
        elif tag == "table":
            self._depth += 1
            if self._depth == 1 and self._armed:
                self._candidate = {"start": self._offset(), "rows": []}
        elif self._depth == 1 and self._candidate is not None and tag in _CELL_ENDS:
            self._close_cell()
            if tag == "tr":
                self._candidate["rows"].append([])
            elif tag in ("td", "th"):
                self._cell = {"start": self._after_tag(), "text": []}

    def handle_data(self, data: str) -> None:
        if self._mermaid_depth:
            return
        if self._heading is not None:
            self._heading.append(data)
        if self._cell is not None:
            self._cell["text"].append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "pre" and self._mermaid_depth:
            self._mermaid_depth -= 1
            return
        if self._mermaid_depth:
            return
        if tag in ("h2", "h3") and self._heading is not None:
            # An h2 opening has already ended any section in force.
            if _text(self._heading).casefold() == HEADING:
                self._armed = True
            self._heading = None
        elif tag == "table" and self._depth:
            if self._depth == 1 and self._candidate is not None:
                self._close_cell()
                candidate, self._candidate = self._candidate, None
                candidate["end"] = self._after_tag()
                candidate["rows"] = [row for row in candidate["rows"] if row]
                if candidate["rows"] and _column(candidate["rows"][0], "question") is not None:
                    self.tables.append(candidate)
                    self._armed = False
            self._depth -= 1
        elif self._depth == 1 and self._candidate is not None and tag in _CELL_ENDS:
            self._close_cell()


def _column(header: list[dict], name: str) -> int | None:
    return next((i for i, cell in enumerate(header) if cell["text"].casefold() == name), None)


def version(text: str, labels: list[str]) -> str:
    """The version of a question: a short hash of its text and option labels."""
    data = json.dumps([text, labels], ensure_ascii=False).encode("utf-8")
    return hashlib.sha256(data).hexdigest()[:VERSION_LENGTH]


def _cell(row: list[dict], index: int | None) -> dict:
    if index is None or index >= len(row):
        return {"html": "", "text": ""}
    return row[index]


def _questions(rows: list[list[dict]], taken: set[str]) -> list[dict] | None:
    """Each row's question; None when a row does not make one.

    Ids already in taken, the page's earlier tables', are not reused; each
    new id is added to it.
    """
    header, body = rows[0], rows[1:]
    columns = {name: _column(header, name) for name in ("#", "question", "options", "default")}
    context = [i for i in range(len(header)) if i not in columns.values()]
    questions = []
    for number, row in enumerate(body, start=1):
        question = _cell(row, columns["question"])
        if not question["text"]:
            return None
        # A `#` cell with nothing to slug falls back to the row number.
        mark = _cell(row, columns["#"])["text"]
        key = cli.slugify(mark) if _SLUGGABLE.search(mark.lower()) else str(number)
        question_id = cli._unique_id(ID_PREFIX + key, taken)
        taken.add(question_id)
        default = _cell(row, columns["default"])
        if columns["options"] is not None:
            parts = _cell(row, columns["options"])["text"].split(" / ")
            labels = [label for label in (" ".join(part.split()) for part in parts) if label]
            values: set[str] = set()
            options = []
            for label in labels:
                value = cli._unique_id(cli.slugify(label), values)
                values.add(value)
                options.append((value, label))
        elif columns["default"] is not None and default["text"]:
            options = [ACCEPT, OTHER]
        else:
            options = []
        if len(options) < 2:
            return None
        marked = ""
        if columns["options"] is not None and default["text"]:
            wanted = cli.slugify(default["text"])
            marked = next((value for value, label in options if cli.slugify(label) == wanted), "")
        questions.append({
            "id": question_id,
            "number": _cell(row, columns["#"])["html"],
            "question": question,
            "options": options,
            "marked": marked,
            # The default's text, shown only when the row has no Options
            # column: it is what "Accept the default" accepts.
            "default": default["html"] if columns["options"] is None and default["text"] else "",
            "context": [(header[i]["html"], _cell(row, i)["html"])
                        for i in context if _cell(row, i)["text"]],
            "version": version(question["text"], [label for _, label in options]),
        })
    return questions


def _form(page: str, question: dict) -> str:
    esc = html.escape
    lines = [
        f'<form class="{FORM_CLASS}" data-page="{esc(page)}" '
        f'data-question="{esc(question["id"])}" data-version="{esc(question["version"])}">',
        "<fieldset>",
    ]
    number = question["number"]
    lines.append(
        '<legend class="artifact-decision-question">'
        + (f'<span class="artifact-decision-number">{number}</span> ' if number else "")
        + f'<span class="artifact-decision-text">{question["question"]["html"]}</span></legend>'
    )
    for label, value in question["context"]:
        lines.append(
            f'<p class="artifact-decision-context"><span class="artifact-decision-context-label">'
            f"{label}:</span> {value}</p>"
        )
    if question["default"]:
        lines.append(
            '<p class="artifact-decision-context"><span class="artifact-decision-context-label">'
            f'Default:</span> {question["default"]}</p>'
        )
    lines.append('<div class="artifact-decision-options">')
    for value, label in question["options"]:
        mark = (f' <span class="artifact-decision-default">{DEFAULT_MARK}</span>'
                if value == question["marked"] else "")
        lines.append(
            f'<label class="artifact-decision-option"><input type="radio" name="choice" '
            f'value="{esc(value)}" required> <span class="artifact-decision-label">'
            f"{esc(label, quote=False)}</span>{mark}</label>"
        )
    lines += [
        "</div>",
        '<div class="artifact-decision-foot">',
        '<details class="artifact-decision-note"><summary>Add a note</summary>'
        '<textarea name="note" rows="2" maxlength="4000" aria-label="Note"></textarea></details>',
        '<button type="submit">Save answer</button>',
        '<span class="artifact-decision-unsaved" hidden>Not saved</span>',
        '<span class="artifact-decision-hint">Not answered yet</span>',
        '<p class="artifact-decision-status" role="status"></p>',
        "</div>",
        "</fieldset>",
        "</form>",
    ]
    return "\n".join(lines)


def render_decisions(body: str, page: str) -> tuple[str, bool]:
    """(body with its decisions tables as forms, whether it has any forms).

    A decisions table with a row of fewer than two options is left exactly
    as written, so a body without a table that makes forms comes back as
    written.
    """
    finder = _TableFinder(body)
    finder.feed(body)
    finder.close()
    taken: set[str] = set()
    blocks = []
    for table in finder.tables:
        ids = set(taken)
        questions = _questions(table["rows"], ids)
        if not questions:
            continue
        taken = ids
        forms = "\n".join(_form(page, question) for question in questions)
        blocks.append((table, f'<div class="artifact-decisions">\n{forms}\n</div>'))
    # Last first, so the spans before each replacement still hold.
    for table, block in reversed(blocks):
        body = body[:table["start"]] + block + body[table["end"]:]
    return body, bool(blocks)


class _FormReader(HTMLParser):
    """Read a finished page's decision forms back."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.forms: dict[str, Form] = {}
        # The questions of the forms read since the last comment box.
        self._unboxed: list[str] = []
        self._open: dict | None = None
        # (class being read, span depth inside it, text so far)
        self._reading: tuple[str, int, list[str]] | None = None

    def handle_starttag(self, tag: str, attrs: list) -> None:
        values = {key: value or "" for key, value in attrs}
        classes = values.get("class", "").split()
        if tag == "details" and comments.BOX_CLASS in classes and self._open is None:
            section = values.get("data-section", "")
            for question in self._unboxed:
                self.forms[question] = replace(self.forms[question], section=section)
            self._unboxed = []
        elif tag == "form" and FORM_CLASS in classes:
            self._open = {"question": values.get("data-question", ""),
                          "version": values.get("data-version", ""),
                          "text": "", "options": []}
        elif self._open is None:
            return
        elif self._reading is not None:
            if tag == "span":
                name, depth, parts = self._reading
                self._reading = (name, depth + 1, parts)
        elif tag == "input" and values.get("type") == "radio" and values.get("name") == "choice":
            self._open["options"].append([values.get("value", ""), ""])
        elif tag == "span" and "artifact-decision-text" in classes:
            self._reading = ("text", 1, [])
        elif tag == "span" and "artifact-decision-label" in classes and self._open["options"]:
            self._reading = ("label", 1, [])

    def handle_data(self, data: str) -> None:
        if self._reading is not None:
            self._reading[2].append(data)

    def handle_endtag(self, tag: str) -> None:
        if self._open is None:
            return
        if tag == "span" and self._reading is not None:
            name, depth, parts = self._reading
            if depth > 1:
                self._reading = (name, depth - 1, parts)
                return
            self._reading = None
            if name == "text":
                self._open["text"] = _text(parts)
            else:
                self._open["options"][-1][1] = _text(parts)
        elif tag == "form":
            found, self._open = self._open, None
            self._reading = None
            if found["question"] and found["question"] not in self.forms:
                self.forms[found["question"]] = Form(
                    question=found["question"], text=found["text"],
                    version=found["version"],
                    options=tuple((value, label) for value, label in found["options"]),
                )
                self._unboxed.append(found["question"])


def read_forms(page_html: str) -> dict[str, Form]:
    """The page's decision forms by question id, in page order."""
    reader = _FormReader()
    reader.feed(page_html)
    reader.close()
    return reader.forms
