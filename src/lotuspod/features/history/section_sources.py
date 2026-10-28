"""Each section's own part of a page's markdown source, so compare() can diff
one section's lines alone.

The source is split at each line that starts with "## " outside a ``` fence,
the lines the converter (features/publish/markdown.py) makes an h2 of, and
read only up to its "## Concrete commands" cut, which is never on the page.
The text before the first heading is the part of the section with key ""
when the page has one; the nth heading's part is the nth headed section the
same version's HTML holds. A version whose page has another number of h2s,
such as one from "> ## Aside" in a blockquote, does not split.
"""

from __future__ import annotations

from lotuspod.features.history.versions import sections

# The converter's cut: from this heading on, the source is not on the page.
_CUT = "## Concrete commands"


def section_sources(page_html: str, source: str) -> dict[str, str] | None:
    """Each section's source text, keyed by Section.key; None when the
    source's headings and the page's h2s do not pair one to one."""
    parts: list[list[str]] = [[]]
    fenced = False
    for i, line in enumerate(source.split("\n")):
        if line.startswith("```"):
            fenced = not fenced
        elif not fenced and i and line.startswith(_CUT):
            break
        elif not fenced and line.startswith("## "):
            parts.append([])
        parts[-1].append(line)
    found = sections(page_html)
    headed = [section for section in found if section.headed]
    if len(headed) != len(parts) - 1:
        return None
    texts = {section.key: "\n".join(part) for section, part in zip(headed, parts[1:])}
    if any(not section.headed for section in found):
        texts[""] = "\n".join(parts[0])
    return texts
