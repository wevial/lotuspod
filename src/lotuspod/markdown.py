"""Convert a page's markdown into the body HTML `lotuspod render` takes.

Ported from the operator's publishing converter, kept unchanged beside the
tests (tests/fixtures/markdown/reference_md2body.py) as the oracle this module
is held to byte for byte. It handles `##` and `###` headings, paragraphs,
`-` and `1.` lists nested by indentation (indented plain text continues an
item), `>` blockquotes converted recursively, pipe tables, code spans,
`**bold**` and fenced code, where a `mermaid` fence becomes a
`<pre class="mermaid">` diagram block. Every `# ` line is dropped, since the
title is passed separately, and everything from a `## Concrete commands`
heading on is left out, which keeps host-only commands off published pages.
"""

from __future__ import annotations

import html
import re

CUT = "\n## Concrete commands"

_ITEM = re.compile(r"^( *)(-|\d+\.) (.*)$")
_QUOTE = re.compile(r"^ {0,3}>")
_LIST_START = re.compile(r"^(-|\d+\.) ")
_PARA_BREAK = re.compile(r"^(#|\||- |\d+\. |```)")
_SEPARATOR_CELL = re.compile(r"-+")


def to_body(text: str) -> str:
    """The body HTML for markdown `text`, ending with one newline."""
    source = text.split(CUT)[0]
    return "\n".join(_convert(source.split("\n"))) + "\n"


def _inline(text: str) -> str:
    text = html.escape(text, quote=False)
    text = re.sub(r"`([^`]+)`", r"<code>\1</code>", text)
    return re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", text)


def _render_list(block: list[str]) -> str:
    """`block`'s lines as nested <ul>/<ol>: an item indented deeper than the
    one above it opens a list inside that item."""
    root: dict = {"children": []}
    stack: list[tuple[int, dict]] = [(-1, root)]  # (indent, node)
    for line in block:
        m = _ITEM.match(line)
        if not m:  # an indented continuation of the last item
            stack[-1][1]["text"] += " " + line.strip()
            continue
        indent, marker, text = len(m.group(1)), m.group(2), m.group(3)
        while len(stack) > 1 and stack[-1][0] >= indent:
            stack.pop()
        item = {"text": text, "ordered": marker[0].isdigit(), "children": []}
        stack[-1][1]["children"].append(item)
        stack.append((indent, item))

    def emit(items: list[dict]) -> str:
        if not items:
            return ""
        tag = "ol" if items[0]["ordered"] else "ul"
        inner = "".join(
            f"<li>{_inline(x['text'])}{emit(x['children'])}</li>" for x in items
        )
        return f"<{tag}>{inner}</{tag}>"

    return emit(root["children"])


def _convert(lines: list[str]) -> list[str]:
    """Body HTML blocks for markdown `lines`; a blockquote's inner lines go
    through the same conversion, so code blocks, lists and tables work inside."""
    out: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        if line.startswith("# "):
            i += 1
            continue
        if _QUOTE.match(line):
            inner = []
            while i < len(lines) and _QUOTE.match(lines[i]):
                inner.append(re.sub(r"^ {0,3}> ?", "", lines[i]))
                i += 1
            out.append("<blockquote>" + "\n".join(_convert(inner)) + "</blockquote>")
            continue
        if line.startswith("```"):
            lang = line[3:].strip()
            code = []
            i += 1
            while i < len(lines) and not lines[i].startswith("```"):
                code.append(lines[i])
                i += 1
            i += 1  # the closing fence
            text = html.escape("\n".join(code), quote=False)
            if lang == "mermaid":
                out.append(f'<pre class="mermaid">{text}</pre>')
            else:
                out.append(f"<pre><code>{text}</code></pre>")
            continue
        if line.startswith("## "):
            out.append(f"<h2>{_inline(line[3:])}</h2>")
            i += 1
            continue
        if line.startswith("### "):
            out.append(f"<h3>{_inline(line[4:])}</h3>")
            i += 1
            continue
        if line.startswith("|"):
            rows = []
            while i < len(lines) and lines[i].startswith("|"):
                cells = [c.strip() for c in lines[i].strip("|").split("|")]
                if not all(_SEPARATOR_CELL.fullmatch(c) for c in cells):
                    rows.append(cells)
                i += 1
            th = "".join(f"<th>{_inline(c)}</th>" for c in rows[0])
            body = "".join(
                "<tr>" + "".join(f"<td>{_inline(c)}</td>" for c in r) + "</tr>"
                for r in rows[1:]
            )
            out.append(f"<table><thead><tr>{th}</tr></thead><tbody>{body}</tbody></table>")
            continue
        if _LIST_START.match(line):
            # A list runs over its items and every indented line under them:
            # an indented item nests inside the item above it, and indented
            # plain text continues that item.
            block = []
            while i < len(lines) and (
                _ITEM.match(lines[i])
                or (lines[i].startswith(" ") and lines[i].strip() and not _QUOTE.match(lines[i]))
            ):
                block.append(lines[i])
                i += 1
            out.append(_render_list(block))
            continue
        if not line.strip():
            i += 1
            continue
        para = []
        while (
            i < len(lines)
            and lines[i].strip()
            and not _QUOTE.match(lines[i])
            and not _PARA_BREAK.match(lines[i])
        ):
            para.append(lines[i])
            i += 1
        if not para:
            # A line such as `#### x` or `#tag` matches no block above and
            # stops a paragraph; the reference loops forever on it, so it is
            # taken as a paragraph of its own instead.
            para.append(line)
            i += 1
        out.append(f"<p>{_inline(' '.join(para))}</p>")
    return out
