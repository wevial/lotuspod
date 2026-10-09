"""A flowchart's Nodes table marked, so the page script can make a card of
each box.

`mark_node_tables()` runs on the body just after it is built. A Nodes table
is a `pre.mermaid` whose source is a flowchart (`flowchart` or `graph`),
followed directly by an h3 or h4 whose text is exactly `Nodes`, followed
directly by a `table`; only whitespace may come between them. Each one found
gets attributes and nothing else: `data-node-table` on the `pre`, naming the
table's id; an id on the table if it has none, and the class
`artifact-node-table`; the class `artifact-node-heading` on the heading; and
on each body row, `data-node` (its first cell's text, when that is a node id
no earlier row took) and `data-status` (its Status cell lowercased, when that
is one of STATUSES). The attributes are spliced in at the parser's offsets,
so the rest of the body stays byte for byte as written. Nothing is written
hidden: a page without its script shows the heading and table.
"""

from __future__ import annotations

import html
import re
from html.parser import HTMLParser

PRE_ATTRIBUTE = "data-node-table"
TABLE_CLASS = "artifact-node-table"
HEADING_CLASS = "artifact-node-heading"
HEADING_TEXT = "Nodes"
STATUS_HEADER = "status"
STATUSES = frozenset({"merged", "open", "ready", "waiting"})
# The id a table without one is given, made unique among the body's ids.
TABLE_ID = "nodes-table"
NODE_ID = re.compile(r"[A-Za-z0-9_-]+")
# The first word of a flowchart's source, as Mermaid detects one.
_FLOWCHART = re.compile(r"(flowchart|graph)\b")
_TAG_NAME = re.compile(r"<[A-Za-z][A-Za-z0-9]*")
_CLASS_ATTRIBUTE = re.compile(r"""\sclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))""", re.I)


def is_flowchart(source: str) -> bool:
    """Whether a diagram's source is a flowchart: its first non-blank line,
    after any `%%` directive lines, starts `flowchart` or `graph`."""
    for line in source.splitlines():
        line = line.strip()
        if not line or line.startswith("%%"):
            continue
        return _FLOWCHART.match(line) is not None
    return False


class _NodeTableFinder(HTMLParser):
    """Find each diagram, heading and table in a row, with the source offset
    of each one's start tag and of each body row's."""

    def __init__(self, body: str) -> None:
        super().__init__(convert_charrefs=True)
        self._line_starts = [0]
        for index, char in enumerate(body):
            if char == "\n":
                self._line_starts.append(index + 1)
        self.ids: set[str] = set()
        self.found: list[dict] = []
        # Depth of `pre` nesting while inside a `pre.mermaid`, 0 outside one:
        # anything in it is diagram source.
        self._mermaid_depth = 0
        # What the run holds so far: "pre" once a flowchart has ended,
        # "heading" while its heading is open, "nodes" once a Nodes heading
        # has ended, "table" while its table is open; None outside a run.
        self._state: str | None = None
        self._run: dict = {}
        self._pre: dict | None = None
        self._table_depth = 0
        self._row: dict | None = None
        self._cell: dict | None = None
        self._section = ""

    def _offset(self) -> int:
        line, column = self.getpos()
        return self._line_starts[line - 1] + column

    def _tag(self, attrs: list) -> dict:
        return {"start": self._offset(), "source": self.get_starttag_text() or "",
                "attrs": dict(attrs)}

    def _reset(self) -> None:
        self._state = None
        self._run = {}

    def handle_starttag(self, tag: str, attrs: list) -> None:
        explicit = next((v for k, v in attrs if k == "id" and v), "")
        if explicit:
            self.ids.add(explicit)
        if tag == "pre":
            classes = next((v for k, v in attrs if k == "class" and v), "").split()
            if self._mermaid_depth or "mermaid" in classes:
                self._mermaid_depth += 1
                # One in a heading or a table is part of it, never a diagram
                # a Nodes table follows.
                if self._mermaid_depth == 1 and self._state not in ("heading", "table"):
                    self._reset()
                    self._pre = {**self._tag(attrs), "text": []}
                return
        if self._mermaid_depth:
            return
        if self._state == "table":
            self._table_tag(tag, attrs)
        elif self._state == "pre" and tag in ("h3", "h4"):
            self._state = "heading"
            self._run["heading"] = {**self._tag(attrs), "name": tag, "text": []}
        elif self._state == "nodes" and tag == "table":
            self._state = "table"
            self._table_depth = 1
            self._section = ""
            self._run["table"] = self._tag(attrs)
            self._run["rows"] = []
        elif self._state != "heading":
            self._reset()

    def handle_startendtag(self, tag: str, attrs: list) -> None:
        explicit = next((v for k, v in attrs if k == "id" and v), "")
        if explicit:
            self.ids.add(explicit)
        if self._mermaid_depth:
            return
        if self._state not in ("table", "heading"):
            self._reset()

    def _table_tag(self, tag: str, attrs: list) -> None:
        if tag == "table":
            self._table_depth += 1
        if self._table_depth != 1:
            return
        if tag in ("thead", "tbody", "tfoot"):
            self._section = tag
        elif tag == "tr":
            self._row = {**self._tag(attrs), "section": self._section, "cells": []}
            self._run["rows"].append(self._row)
        elif tag in ("td", "th") and self._row is not None:
            self._cell = {"tag": tag, "text": [], "link": False}
            self._row["cells"].append(self._cell)
        elif tag == "a" and self._cell is not None and any(k == "href" for k, _ in attrs):
            self._cell["link"] = True

    def handle_data(self, data: str) -> None:
        if self._mermaid_depth:
            if self._mermaid_depth == 1 and self._pre is not None:
                self._pre["text"].append(data)
            return
        if self._state == "heading":
            self._run["heading"]["text"].append(data)
        elif self._state == "table":
            if self._cell is not None and self._table_depth == 1:
                self._cell["text"].append(data)
        elif data.strip():
            self._reset()

    def handle_endtag(self, tag: str) -> None:
        if self._mermaid_depth:
            if tag == "pre":
                self._mermaid_depth -= 1
                if not self._mermaid_depth and self._pre is not None:
                    pre, self._pre = self._pre, None
                    if is_flowchart("".join(pre["text"])):
                        self._state = "pre"
                        self._run = {"pre": pre}
            return
        if self._state == "heading":
            if tag == self._run["heading"]["name"]:
                text = "".join(self._run["heading"]["text"]).strip()
                if text == HEADING_TEXT:
                    self._state = "nodes"
                else:
                    self._reset()
        elif self._state == "table":
            if tag == "table":
                self._table_depth -= 1
                if not self._table_depth:
                    self.found.append(self._run)
                    self._row = self._cell = None
                    self._reset()
            elif self._table_depth == 1:
                if tag in ("td", "th"):
                    self._cell = None
                elif tag == "tr":
                    self._row = self._cell = None
                elif tag in ("thead", "tbody", "tfoot"):
                    self._section = ""
        else:
            self._reset()

    def handle_comment(self, data: str) -> None:
        if not self._mermaid_depth and self._state not in ("table", "heading"):
            self._reset()


def _with_class(source: str, name: str) -> str:
    """A start tag's source with name added to its class list."""
    match = _CLASS_ATTRIBUTE.search(source)
    if match is None:
        tag = len(source) - len(source[1:].lstrip("abcdefghijklmnopqrstuvwxyz0123456789"))
        return f'{source[:tag]} class="{name}"{source[tag:]}'
    group = next(index for index in (1, 2, 3) if match.group(index) is not None)
    if group == 3:
        return (f'{source[:match.start(3)]}"{match.group(3)} {name}"'
                f'{source[match.end(3):]}')
    return f"{source[:match.end(group)]} {name}{source[match.end(group):]}"


def _with_attributes(source: str, attributes: dict[str, str]) -> str:
    """A start tag's source with attributes added just after its name."""
    tag = _TAG_NAME.match(source).end()
    added = "".join(f' {name}="{html.escape(value)}"' for name, value in attributes.items())
    return f"{source[:tag]}{added}{source[tag:]}"


def _cell_text(cell: dict) -> str:
    return "".join(cell["text"]).strip()


def _row_marks(rows: list[dict]) -> dict[int, dict[str, str]]:
    """Each body row's attributes, by the row's start offset."""
    header = next((row for row in rows if row["section"] == "thead"), None)
    if header is None:
        header = next((row for row in rows if row["cells"] and row["cells"][0]["tag"] == "th"),
                      None)
    headers = [_cell_text(cell).lower() for cell in header["cells"]] if header else []
    status = headers.index(STATUS_HEADER) if STATUS_HEADER in headers else -1
    taken: set[str] = set()
    marks: dict[int, dict[str, str]] = {}
    for row in rows:
        cells = row["cells"]
        if row is header or row["section"] == "thead" or not cells or cells[0]["tag"] != "td":
            continue
        attributes: dict[str, str] = {}
        node = _cell_text(cells[0])
        if NODE_ID.fullmatch(node) and node not in taken:
            taken.add(node)
            attributes["data-node"] = node
        state = _cell_text(cells[status]).lower() if 0 < status < len(cells) else ""
        if state in STATUSES:
            attributes["data-status"] = state
        if attributes:
            marks[row["start"]] = attributes
    return marks


def mark_node_tables(body: str) -> tuple[str, bool]:
    """The body with each Nodes table and its diagram marked, and whether
    any was."""
    # Here rather than at the top: cli imports this module.
    from lotuspod.cli import _unique_id

    finder = _NodeTableFinder(body)
    finder.feed(body)
    finder.close()
    if not finder.found:
        return body, False
    taken = set(finder.ids)
    # Each start tag to rewrite, by its offset: (its source, the new source).
    edits: dict[int, tuple[str, str]] = {}
    for run in finder.found:
        pre, heading, table = run["pre"], run["heading"], run["table"]
        table_id = table["attrs"].get("id") or ""
        table_source = _with_class(table["source"], TABLE_CLASS)
        if not table_id:
            table_id = _unique_id(TABLE_ID, taken)
            taken.add(table_id)
            table_source = _with_attributes(table_source, {"id": table_id})
        edits[table["start"]] = (table["source"], table_source)
        edits[pre["start"]] = (pre["source"],
                               _with_attributes(pre["source"], {PRE_ATTRIBUTE: table_id}))
        edits[heading["start"]] = (heading["source"],
                                   _with_class(heading["source"], HEADING_CLASS))
        sources = {row["start"]: row["source"] for row in run["rows"]}
        for start, attributes in _row_marks(run["rows"]).items():
            edits[start] = (sources[start], _with_attributes(sources[start], attributes))
    pieces: list[str] = []
    cursor = 0
    for start in sorted(edits):
        before, after = edits[start]
        pieces.append(body[cursor:start])
        pieces.append(after)
        cursor = start + len(before)
    pieces.append(body[cursor:])
    return "".join(pieces), True
