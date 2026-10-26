"""A comment thread anchored to a spot on one of a page's diagrams or images.

A new thread on a section, or on the whole page, may carry `spot` in place
of `quote` or `widget`: {id, hash, shape, nodes}. `id` names one of the
page's targets (Page.targets, lotuspod.features.blocks.targets) and `hash`
is 12 lowercase hex digits of it. `shape` is {kind: box, x, y, w, h} or
{kind: stroke, points: [[x, y], ...]}, 2 to MAX_POINTS points; `nodes` is a
list of up to MAX_NODES {id, label}, the flowchart boxes the mark covers,
each id a node id listed once and each label up to MAX_NAME characters
with no control character. The coordinates are fractions of the box the
covered nodes span when `nodes` is not empty; fractions of the whole
drawing when a diagram's mark covers none; an image's natural pixels. The
server cannot lay out Mermaid, so a mark on nodes is checked only for
finite numbers, and its nodes and labels are stored as sent. The spot is
stored as {id, hash, shape, nodes, title}, `title` the target's Target.title
as the page had it when the thread was posted (an image's alt text, a
diagram's section heading text, "" before the first heading), so the
thread can name its target once it is gone; a spot stored before titles
were kept has none.

After the route's checks before the widget's, a spot is refused, with
nothing stored, in this order: 400 invalid_body for any other key, a hash
or shape not of that shape, a coordinate that is not a finite number (a
boolean is not one), a box whose w or h is not above 0, a mark on no nodes
outside its drawing (beyond 0 to 1, or 0 to the image's width and height),
nodes not of that shape, nodes on an image, or a spot beside a quote or a
widget (on a reply or a decision thread it is a body not of its shape);
400 unknown_spot for an id the page has no target for, or a target in
another section than the thread's; and 409 stale_spot for a hash the target
has had in none of the page's visible publishes (Target.earlier, kept
beside the page) nor of its versions (History.target_hashes()). A hash it
had in an earlier one is stored as sent. Every comment a route answers
carries `spot`: the anchor as stored on a thread's first comment, null on
every other comment.
"""

from __future__ import annotations

import math
import unicodedata
from dataclasses import dataclass
from http import HTTPStatus

from lotuspod.features import blocks
from lotuspod.features.history import History
# api imports this module too: each uses the other only once both are loaded.
from lotuspod.features.serve import api

DIAGRAM = "diagram"
IMAGE = "image"
# The nodes one mark may cover, and the points of one stroke.
MAX_NODES = 12
MAX_POINTS = 256


@dataclass(frozen=True)
class Target:
    """A diagram or an image as the page shows it."""

    kind: str
    # A diagram's source's hash, an image's stored name's: 12 hex digits.
    hash: str
    title: str
    # Its section, as Page.sections and comment_sections name it, as a live
    # block's is (Widget.section).
    section: str
    # The hashes it had in the page's visible publishes, its own among them
    # (render.TARGETS_SUFFIX); empty for a page published before they were kept.
    earlier: frozenset[str] = frozenset()
    # A diagram's Mermaid source; "" for an image.
    source: str = ""
    # An image's /media/ URL and natural size; "" and 0 for a diagram.
    url: str = ""
    width: int = 0
    height: int = 0


def _number(value: object) -> int | float:
    """value as a finite number; Refusal for anything else, an integer too
    large to compare with a float among them."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise api._invalid()
    try:
        finite = math.isfinite(value)
    except OverflowError:
        finite = False
    if not finite:
        raise api._invalid()
    return value


def _shape(value: object) -> dict:
    """value as a box or a stroke; Refusal for anything else."""
    if not isinstance(value, dict):
        raise api._invalid()
    if value.get("kind") == "box":
        api._keys(value, {"kind", "x", "y", "w", "h"})
        box = {key: _number(value[key]) for key in ("x", "y", "w", "h")}
        if box["w"] <= 0 or box["h"] <= 0:
            raise api._invalid()
        return {"kind": "box", **box}
    if value.get("kind") == "stroke":
        api._keys(value, {"kind", "points"})
        points = value["points"]
        if not isinstance(points, list) or not 2 <= len(points) <= MAX_POINTS:
            raise api._invalid()
        if not all(isinstance(point, list) and len(point) == 2 for point in points):
            raise api._invalid()
        return {"kind": "stroke", "points": [[_number(x), _number(y)] for x, y in points]}
    raise api._invalid()


def _nodes(value: object) -> list[dict]:
    """value as up to MAX_NODES distinct nodes, {id, label}; Refusal for
    anything else. A label is shown as text, so it holds no control
    character."""
    if not isinstance(value, list) or len(value) > MAX_NODES:
        raise api._invalid()
    nodes = []
    for node in value:
        if not isinstance(node, dict):
            raise api._invalid()
        api._keys(node, {"id", "label"})
        ident = api._text(node["id"], 1, api.MAX_BODY)
        label = api._text(node["label"], 0, api.MAX_NAME)
        if not blocks.NODE_ID.fullmatch(ident) or any(
                unicodedata.category(char) == "Cc" for char in label):
            raise api._invalid()
        nodes.append({"id": ident, "label": label})
    if len({node["id"] for node in nodes}) != len(nodes):
        raise api._invalid()
    return nodes


def _inside(shape: dict, width: float, height: float) -> bool:
    """Whether shape lies within 0 to width and 0 to height."""
    if shape["kind"] == "box":
        return (shape["x"] >= 0 and shape["y"] >= 0 and shape["x"] + shape["w"] <= width
                and shape["y"] + shape["h"] <= height)
    return all(0 <= x <= width and 0 <= y <= height for x, y in shape["points"])


def check(value: object, page: api.Page, section: str, quote: dict | None,
          history: History | None) -> dict:
    """value as a spot on one of page's targets in section, for a new
    thread with quote (None for none), its earlier hashes read from history
    (None for none); Refusal, in the module's order, for anything else."""
    if quote is not None or not isinstance(value, dict):
        raise api._invalid()
    api._keys(value, {"id", "hash", "shape", "nodes"})
    ident, hash_ = api._text(value["id"], 1, api.MAX_BODY), api._text(value["hash"], 12, 12)
    if not api.WIDGET_HASH.fullmatch(hash_):
        raise api._invalid()
    shape, nodes = _shape(value["shape"]), _nodes(value["nodes"])
    target = page.targets.get(ident)
    if target is not None and target.kind == IMAGE and nodes:
        raise api._invalid()
    if target is not None and not nodes and not _inside(
            shape, *((target.width, target.height) if target.kind == IMAGE else (1, 1))):
        raise api._invalid()
    if target is None or target.section != section:
        raise api.Refusal(HTTPStatus.BAD_REQUEST, "unknown_spot")
    if (target.hash != hash_ and hash_ not in target.earlier
            and (history is None or hash_ not in history.target_hashes(page.name, ident))):
        raise api.Refusal(HTTPStatus.CONFLICT, "stale_spot")
    return {"id": ident, "hash": hash_, "shape": shape, "nodes": nodes, "title": target.title}
