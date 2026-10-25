"""A Claude artifact's HTML document made fit for a live block on the sending
side of publish (`publish --artifact`): each script from one of two CDNs
fetched and inlined, Google Fonts links dropped, and a script that sets the
root's data-theme from the reader's theme put first in its head."""

from __future__ import annotations

import base64
import hashlib
import html
import http.client
import re
import sys
import urllib.request
from dataclasses import dataclass
from html.parser import HTMLParser
from urllib.parse import urlsplit

from lotuspod.core import normalized

# The only places a script is fetched from: what the frame's policy would
# block is put inline, where its hash covers it.
CDN_PREFIXES = ("https://cdnjs.cloudflare.com/", "https://cdn.jsdelivr.net/npm/")
FONT_HOSTS = ("fonts.googleapis.com", "fonts.gstatic.com")
FETCH_TIMEOUT = 30
# What a whole document in a live block may hold, as widgets.render counts it;
# the file read may hold more, since what counts is the adapted document.
DOCUMENT_MAX = 2 * 1024 * 1024
READ_MAX = 16 * 1024 * 1024
# An inlined script keeps every attribute but these.
_DROPPED = ("src", "integrity", "crossorigin", "referrerpolicy")
_SCRIPT_CLOSE = re.compile(r"</(script)", re.IGNORECASE)
# "<!--" in script text lets a later "<script" keep the element open past its
# end tag; written \x3C it reads the same in a string, a template or a regex.
_COMMENT_OPEN = "<!--"
_DIGESTS = {"sha256": hashlib.sha256, "sha384": hashlib.sha384, "sha512": hashlib.sha512}

# Put first in the head: the bridge before it keeps window.lotuspod.theme and
# dispatches lotuspod:theme on each change.
THEME_SCRIPT = (
    '(function () {\n'
    '  function follow() {\n'
    '    var theme = window.lotuspod && window.lotuspod.theme;\n'
    '    if (theme === "dawn") document.documentElement.setAttribute("data-theme", "light");\n'
    '    else if (theme === "night") document.documentElement.setAttribute("data-theme", "dark");\n'
    '  }\n'
    '  follow();\n'
    '  document.addEventListener("lotuspod:theme", follow);\n'
    '})();'
)


class _CdnRedirects(urllib.request.HTTPRedirectHandler):
    """Follow a redirect only to another URL a script may be fetched from."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        if not newurl.startswith(CDN_PREFIXES):
            raise ValueError(f"redirected to {newurl}")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch(url: str) -> bytes:
    """The bytes at an https URL on one of the CDNs, whole; OSError or
    ValueError when they cannot be had. Every fetch goes through here."""
    if not url.startswith(CDN_PREFIXES):
        raise ValueError("not an https URL on " + " or ".join(CDN_PREFIXES))
    opener = urllib.request.build_opener(_CdnRedirects)
    try:
        with opener.open(url, timeout=FETCH_TIMEOUT) as response:
            data = response.read(DOCUMENT_MAX + 1)
            if len(data) > DOCUMENT_MAX:
                raise ValueError("over 2 MB")
            # A read with a size returns what came before the connection
            # closed; the length still owed says it was cut short.
            if response.length:
                raise ValueError(f"cut short, {response.length} bytes missing")
            return data
    except http.client.HTTPException as exc:
        raise ValueError(f"cut short or malformed ({exc!r})") from None


@dataclass(frozen=True)
class _Element:
    """A script or link element: its span in the document and its attributes,
    the first value of each."""

    tag: str
    start: int
    end: int
    attrs: dict


class _Elements(HTMLParser):
    """The document's script elements with a src, its link elements, and
    where its head's start tag ends (None when it has none before content)."""

    def __init__(self, source: str) -> None:
        super().__init__(convert_charrefs=True)
        self._source = source
        self._lines = [0, *(m.end() for m in re.finditer("\n", source))]
        self._script: tuple[int, dict] | None = None
        self.elements: list[_Element] = []
        self.head: int | None = None
        self.html: int | None = None
        self._started = False
        self.feed(source)
        self.close()
        if self._script is not None:
            raise RuntimeError(f"artifact script {self._script[1]['src']}: no end tag; "
                               "nothing written")

    def _offset(self) -> int:
        line, column = self.getpos()
        return self._lines[line - 1] + column

    def handle_starttag(self, tag: str, attrs: list) -> None:
        first: dict[str, str] = {}
        for key, value in attrs:
            first.setdefault(key, value or "")
        start = self._offset()
        end = start + len(self.get_starttag_text() or "")
        if tag == "head" and not self._started and self.head is None:
            self.head = end
        elif tag == "html" and not self._started and self.html is None:
            self.html = end
        else:
            self._started = True
        if tag == "script" and "src" in first:
            self._script = (start, first)
        elif tag == "link":
            self.elements.append(_Element("link", start, end, first))

    def handle_endtag(self, tag: str) -> None:
        self._started = True
        if tag == "script" and self._script is not None:
            start, attrs = self._script
            end = self._source.find(">", self._offset())
            end = len(self._source) if end < 0 else end + 1
            self.elements.append(_Element("script", start, end, attrs))
            self._script = None

    def handle_data(self, data: str) -> None:
        if data.strip(" \t\r\n\f﻿"):
            self._started = True


def _matches(data: bytes, integrity: str) -> bool:
    """Whether data matches an integrity value, by its strongest algorithm."""
    found: dict[str, set[str]] = {}
    for token in integrity.split():
        algorithm, _, digest = token.partition("-")
        if algorithm in _DIGESTS and digest:
            found.setdefault(algorithm, set()).add(digest.split("?", 1)[0])
    if not found:
        return False
    algorithm = max(found, key=list(_DIGESTS).index)
    return base64.b64encode(_DIGESTS[algorithm](data).digest()).decode("ascii") in found[algorithm]


def _inlined(element: _Element) -> str:
    """The inline script element that stands for element, its script fetched."""
    url = element.attrs["src"]

    def refused(reason: str) -> RuntimeError:
        return RuntimeError(f"artifact script {url}: {reason}; nothing written")

    if not url.startswith(CDN_PREFIXES):
        raise refused("only scripts from " + " or ".join(CDN_PREFIXES) + " are inlined")
    try:
        data = fetch(url)
    except (OSError, ValueError) as exc:
        raise refused(f"cannot be fetched ({exc})") from None
    if "integrity" in element.attrs and not _matches(data, element.attrs["integrity"]):
        raise refused("its bytes do not match its integrity")
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        raise refused("not UTF-8") from None
    if any(row.startswith("```") for row in normalized(text).split("\n")):
        raise refused("contains a line starting with three backticks")
    kept = "".join(f' {key}="{html.escape(value)}"' if value else f" {key}"
                   for key, value in element.attrs.items() if key not in _DROPPED)
    text = _SCRIPT_CLOSE.sub(r"<\\/\1", text).replace(_COMMENT_OPEN, "\\x3C!--")
    return f"<script{kept}>{text}</script>"


def _url(href: str) -> str:
    """href as a browser parses it: trimmed, tabs and newlines taken out, a
    backslash read as a slash."""
    return re.sub(r"[\t\n\r]", "", href.strip("\x00- ")).replace("\\", "/")


def _remote(href: str) -> bool:
    return bool(re.match(r"(?:https?:|//)", _url(href), re.IGNORECASE))


def adapt(source: str) -> str:
    """source, a Claude artifact's HTML document, with its CDN scripts
    inlined, its Google Fonts links removed (a warning on standard error for
    each stylesheet) and the theme script first in its head; RuntimeError
    naming the first script or stylesheet it cannot keep."""
    found = _Elements(source)
    pieces: list[str] = []
    cursor = 0
    for element in found.elements:
        if element.tag == "script":
            replacement = _inlined(element)
        else:
            href = element.attrs.get("href", "")
            rels = element.attrs.get("rel", "").lower().split()
            if _remote(href) and (urlsplit(_url(href)).hostname or "") in FONT_HOSTS:
                if "stylesheet" in rels:
                    print(f"warning: artifact stylesheet {href} dropped: its fonts are not "
                          "loaded in a frame, the document's fallback fonts apply",
                          file=sys.stderr)
                replacement = ""
            elif "stylesheet" in rels and _remote(href):
                raise RuntimeError(f"artifact stylesheet {href}: a frame loads no stylesheet "
                                   "from the network; put its CSS inline; nothing written")
            else:
                continue
        pieces += [source[cursor:element.start], replacement]
        cursor = element.end
    pieces.append(source[cursor:])
    document = "".join(pieces)
    theme = f"<script>{THEME_SCRIPT}</script>"
    # Offsets before the first replaced element are unchanged.
    point = found.head if found.head is not None else found.html
    if found.head is None:
        theme = "<head>" + theme + "</head>"
        if point is None:
            declaration = re.match(r"﻿?[ \t\r\n\f]*<!doctype[^>]*>", document, re.IGNORECASE)
            point = declaration.end() if declaration else 0
    document = document[:point] + theme + document[point:]
    if len(document.removesuffix("\n").encode("utf-8")) > DOCUMENT_MAX:
        raise RuntimeError("artifact document exceeds 2 MB once its scripts are inlined; "
                           "nothing written")
    return document
