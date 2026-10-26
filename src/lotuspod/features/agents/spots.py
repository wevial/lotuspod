"""The diagram or image a pulled thread's spot is on, as an agent's pull
shows it (lotuspod.features.serve.spots has the anchor's rules).

A pulled comment in a thread anchored to a spot carries `spot`, the anchor
{id, hash, shape, nodes, title} as its first comment keeps it (no `title`
on one stored before titles were kept), and `target`: its
`kind` (`diagram` or `image`), `title` and `status`, `current` while the
target's hash is the anchor's, `changed` once it is another, and `removed`,
with kind and title "", once the page has no target of that id. A diagram's
also carries `source`, its Mermaid source on the page now, and `nodes`, the
anchor's; an image's its /media/ `url`, `width` and `height`. The text pull
names it in one line (lines()).
"""

from __future__ import annotations

from typing import Mapping

from lotuspod.features import serve


def target(page: serve.Page, anchor: Mapping) -> dict:
    """The target anchor is on, on page as serve answers it now."""
    found = page.targets.get(anchor["id"])
    if found is None:
        return {"kind": "", "title": "", "status": "removed"}
    shown = {"kind": found.kind, "title": found.title,
             "status": "current" if found.hash == anchor["hash"] else "changed"}
    if found.kind == "diagram":
        return {**shown, "source": found.source, "nodes": anchor["nodes"]}
    return {**shown, "url": found.url, "width": found.width, "height": found.height}


def lines(item: Mapping) -> list[str]:
    """The line naming a pulled item's spot: its shape, the nodes it covers,
    its target's kind and title (else the title the spot was stored with,
    else its id, when the page's title is "") and whether
    the target has changed or gone since; none for any other item."""
    anchor, found = item.get("spot"), item.get("target")
    if not anchor or not found:
        return []
    line = f"- Spot: {anchor['shape']['kind']}"
    if anchor["nodes"]:
        line += " on " + ", ".join(node["label"] for node in anchor["nodes"])
    title = (" ".join(found["title"].split())
             or " ".join((anchor.get("title") or "").split()) or anchor["id"])
    line += f" ({found['kind']} \"{title}\")" if found["kind"] else f" (\"{title}\")"
    if found["status"] != "current":
        line += f", {found['status']} since"
    return [line]
