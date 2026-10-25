"""render: a page from its body, the template and the theme."""

from __future__ import annotations

import argparse
import datetime as _dt
import html
import json
import os
import re
import shutil
import sqlite3
import sys
from html.parser import HTMLParser
from pathlib import Path

from lotuspod import core
from lotuspod.features import agents
from lotuspod.features import serve
from lotuspod.features import comments
from lotuspod.features import decisions
from lotuspod.features.blocks import mark_node_tables, mark_refs
from lotuspod.features.publish import markdown, media, sections
from lotuspod.features import widgets
from lotuspod.core import (DEFAULT_OUTPUT_DIR, _META_CONTENT_RE, PAGE_SCRIPT, _REVISION_TAG_RE,
                           collect_scripts, commit_output, extract_visibility, load_tokens,
                           render_template, script_hash, slugify, sync_theme_css, theme_hash,
                           _unique_id, unit_digest, write_atomic)
from lotuspod.store import db


# Render variants. Each is one ruleset in lotuspod.css keyed off a class on
# the main element, never a second stylesheet: the one file serve allow-lists
# is the whole theme. The default variant stamps nothing, so a page rendered
# without --variant is byte-identical to one rendered before variants existed.
DEFAULT_VARIANT = "article"
VARIANTS = (DEFAULT_VARIANT, "report")


# A diagram block: a `pre` whose class list carries `mermaid`. Mermaid reads the
# element's text verbatim, so render leaves it alone and only decides from its
# presence whether the page needs the drawing script at all.
_MERMAID_BLOCK = re.compile(r'<pre\b[^>]*\bclass="[^"]*\bmermaid\b')
_CALLTREE_BLOCK = re.compile(r'<div\b[^>]*\bclass="(?:[^"]*\s)?calltree[\s"]')


class _LinkFinder(HTMLParser):
    """Whether a body holds an `a` element with an href."""

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.found = False

    def handle_starttag(self, tag: str, attrs: list) -> None:
        if tag == "a" and any(key == "href" for key, _ in attrs):
            self.found = True


def has_link(body: str) -> bool:
    """Whether body holds any link. Which site a link goes to is only known
    in the browser (`//host`, an entity in the scheme and `/\\host` all leave
    it), so the page script (js/link-tab.js) is loaded for every link and
    decides its tab there."""
    finder = _LinkFinder()
    finder.feed(body)
    finder.close()
    return finder.found


def has_mermaid_block(body: str) -> bool:
    return _MERMAID_BLOCK.search(body) is not None


def has_calltree_block(body: str) -> bool:
    """Whether body holds a calltree block, which the page script folds."""
    return _CALLTREE_BLOCK.search(body) is not None


def mermaid_theme_variables(tokens: dict) -> str:
    """Mermaid `themeVariables` for its `base` theme, serialised from the
    tokens: one set for Night ("night") and one for Dawn ("dawn"), Dawn's
    from the dawn colours over Night's fonts.

    One source for the palette: the diagram takes the same surface, lavender
    and night the stylesheet does, instead of Mermaid's default white.
    Mermaid writes them into the drawing as literal colours, so the page's
    module draws with the set its theme names and draws again on a switch.
    """
    fonts = tokens["fonts"]

    def variables(colors: dict) -> dict:
        return {
            "background": colors["night"],
            "fontFamily": fonts["mono"],
            "lineColor": colors["lavender"],
            "primaryBorderColor": colors["lavender"],
            "primaryColor": colors["surface"],
            "primaryTextColor": colors["pale_lavender"],
            "secondaryBorderColor": colors["lavender"],
            "secondaryColor": colors["glow"],
            "secondaryTextColor": colors["pale_lavender"],
            "tertiaryBorderColor": colors["lavender"],
            "tertiaryColor": colors["deep_night"],
            "tertiaryTextColor": colors["pale_lavender"],
            "textColor": colors["pale_lavender"],
        }
    return json.dumps({"night": variables(tokens["colors"]),
                       "dawn": variables(tokens["dawn"]["colors"])}, sort_keys=True)


# The pinned Mermaid's directory on jsDelivr. The page template's start-up
# module imports the library from here, and the library its chunks.
MERMAID_DIR = "https://cdn.jsdelivr.net/npm/mermaid@11.4.1/"
# The ELK layout's directory, for Mermaid 11. The same module registers it,
# so a diagram whose init line asks for layout "elk" is drawn with it.
MERMAID_ELK_DIR = "https://cdn.jsdelivr.net/npm/@mermaid-js/layout-elk@0.2.3/"

# Context values an author supplies. None of them is part of a script the
# template writes, so a page rendered with them blank holds exactly the
# template's own inline scripts.
_AUTHORED_KEYS = ("title", "kicker", "date", "summary_block", "body", "outline_items", "revision",
                  "labels", "label_tags", "refs_block", "intro_digest", "header_digest",
                  "outline_digest")


def page_policy(page_html: str, own_scripts: set[str]) -> str:
    """The Content-Security-Policy for a finished page.

    Scripts run from the site itself, and inline only when the template
    wrote them (own_scripts): each such script in the page is allowed by its
    hash, and the Mermaid and ELK directories each only when one of them
    loads from it. A script in the body is never hashed, so it never runs,
    and neither does an inline event handler.
    """
    script_src = ["'self'"]
    hashes: list[str] = []
    for text in collect_scripts(page_html).inline:
        if text not in own_scripts:
            continue
        for directory in (MERMAID_DIR, MERMAID_ELK_DIR):
            if directory in text and directory not in script_src:
                script_src.append(directory)
        source = script_hash(text)
        if source not in hashes:
            hashes.append(source)
    directives = (
        "default-src 'self'",
        "script-src " + " ".join(script_src + hashes),
        # Mermaid sets its styles inline.
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data:",
        "connect-src 'self'",
        "object-src 'none'",
        "base-uri 'none'",
        "form-action 'self'",
    )
    if widgets.Frames(page_html).sources:
        directives += ("frame-src 'self'",)
    return "; ".join(directives)


def render_page(context: dict) -> str:
    """Render an artifact page with its policy meta tag in the head.

    The policy is computed from the finished page, so it never allows more
    than the page holds.
    """
    blank = {**context, **dict.fromkeys(_AUTHORED_KEYS, ""), "outline": []}
    own_scripts = set(collect_scripts(render_template({**blank, "policy": ""})).inline)
    page = render_template({**context, "policy": ""})
    return render_template({**context, "policy": page_policy(page, own_scripts)})


def script_warning(name: str, body: str) -> str:
    """The line render prints for a body holding scripts ("" when none)."""
    count = collect_scripts(body).count
    if not count:
        return ""
    noun = "script" if count == 1 else "scripts"
    return (
        f"warning: {name}: {count} {noun} will not run; "
        "a page runs only the site's own scripts"
    )


_OUTLINE_MIN_HEADINGS = 2


class _H2Collector(HTMLParser):
    """Locate the body's h2 elements: source span, explicit id, and text.

    Spans are recorded against the source string rather than re-serialized,
    so injecting an id can splice the original bytes back untouched - the
    parser never gets to normalize markup the author wrote by hand.
    """

    def __init__(self, body: str) -> None:
        super().__init__(convert_charrefs=True)
        self._line_starts = [0]
        for index, char in enumerate(body):
            if char == "\n":
                self._line_starts.append(index + 1)
        self._open: dict | None = None
        # Depth of `pre` nesting while inside a `pre.mermaid`, 0 outside one.
        # Mermaid reads a diagram block's text verbatim and allows HTML in
        # node labels, so an h2 spelled out there is diagram source, not a
        # heading - it gets no id and no outline entry.
        self._mermaid_depth = 0
        self.headings: list[dict] = []
        self.ids: set[str] = set()

    def _offset(self) -> int:
        line, column = self.getpos()
        return self._line_starts[line - 1] + column

    def handle_starttag(self, tag: str, attrs: list) -> None:
        explicit = next((v for k, v in attrs if k == "id" and v), "")
        if explicit:
            # Every element's id is reserved, not just the headings' - an
            # anchor that lands on some other element is a broken anchor.
            self.ids.add(explicit)
        if tag == "pre":
            classes = next((v for k, v in attrs if k == "class" and v), "").split()
            if self._mermaid_depth or "mermaid" in classes:
                self._mermaid_depth += 1
        if tag != "h2" or self._mermaid_depth:
            return
        self._finish()
        start = self._offset()
        source = self.get_starttag_text() or ""
        self._open = {
            "start": start,
            "end": start + len(source),
            "source": source,
            "id": explicit,
            "text": [],
        }

    def handle_data(self, data: str) -> None:
        if self._open is not None:
            self._open["text"].append(data)

    def handle_endtag(self, tag: str) -> None:
        if tag == "pre" and self._mermaid_depth:
            self._mermaid_depth -= 1
        elif tag == "h2" and not self._mermaid_depth:
            self._finish()

    def _finish(self) -> None:
        """Close the open heading, collapsing its text to a single line."""
        if self._open is None:
            return
        self._open["text"] = " ".join("".join(self._open["text"]).split())
        self.headings.append(self._open)
        self._open = None

    def close(self) -> None:
        super().close()
        self._finish()


def outline_body(body: str) -> tuple[str, list[dict]]:
    """Give the body's h2s stable ids; return (body, outline entries).

    Ids come from the heading text alone, so the same body always yields the
    same anchors - a re-render never breaks a link someone already shared.
    Headings that carry an explicit id keep it (it may already be linked) and
    only reserve that name, so a generated id can never collide with one -
    nor with an id already spelled out anywhere else in the body.
    A body with fewer than two h2s has nothing to navigate, so it is left
    exactly as written.
    """
    parser = _H2Collector(body)
    parser.feed(body)
    parser.close()
    headings = parser.headings
    if len(headings) < _OUTLINE_MIN_HEADINGS:
        return body, []

    taken = set(parser.ids)
    outline: list[dict] = []
    pieces: list[str] = []
    cursor = 0
    for heading in headings:
        heading_id = heading["id"]
        if not heading_id:
            heading_id = _unique_id(slugify(heading["text"]), taken)
            taken.add(heading_id)
            # Splice the id in just after the "<h2" the tag opens with, so
            # the author's own attributes and spacing survive verbatim.
            source = heading["source"]
            pieces.append(body[cursor:heading["start"]])
            pieces.append(f'{source[:3]} id="{heading_id}"{source[3:]}')
            cursor = heading["end"]
        outline.append({"id": heading_id, "text": heading["text"]})
    pieces.append(body[cursor:])
    return "".join(pieces), outline


def outline_html(outline: list[dict]) -> str:
    """Render the outline's section links ("" when there is none).

    Only the `<li>` items are built here - the nav, disclosure and list that
    wrap them live in artifact.html, inside an `{{#outline}}` section the
    renderer drops when this returns nothing. One list serves both roles the
    theme draws from it - a sticky rail beside the prose where the page is wide
    enough for one, a disclosure above the prose where it is not - so there is
    never a second copy of the links to keep in step, and no script deciding
    which copy to show. It ships open: folding it away is the reader's to do,
    at either width.
    """
    esc = html.escape
    return "\n".join(
        '            <li><a href="#{id}">{text}</a></li>'.format(
            id=esc(str(entry["id"])), text=esc(str(entry["text"]))
        )
        for entry in outline
    )


def variant_class(variant: str) -> str:
    """The class the main element carries for a variant ("" for the default)."""
    if variant not in VARIANTS:
        raise KeyError(f"unknown render variant {variant!r}")
    return "" if variant == DEFAULT_VARIANT else f" artifact--{variant}"


_OWNER_TAG_RE = re.compile(
    r"<meta\s[^>]*name=[\"']lotuspod:owner[\"'][^>]*>", re.IGNORECASE
)


def page_owner(page_html: str) -> str:
    """The handle a page's lotuspod:owner meta tag names ("" when none)."""
    tag = _OWNER_TAG_RE.search(page_html)
    content = _META_CONTENT_RE.search(tag.group(0)) if tag else None
    return content.group(1).strip() if content else ""


def check_owner(args: argparse.Namespace, out_dir: Path) -> None:
    """Refuse (RuntimeError) args.owner unless the credential of --credential,
    else $LOTUSPOD_CREDENTIAL, may publish as it, in serve's database."""
    handle = args.owner
    if not agents.is_handle(handle):
        raise RuntimeError(
            f"--owner {handle!r} is not a handle: 1 to 63 lower-case letters, digits "
            "and hyphens, starting with a letter or digit; nothing written"
        )
    path = args.credential or os.environ.get(agents.CREDENTIAL_ENV, "")
    if not path:
        raise RuntimeError(
            f"--owner {handle} needs --credential FILE for a credential that may publish "
            f"as {handle}; nothing written"
        )
    try:
        token = agents.read_token(path)
        db_path = serve.serve_db_path(out_dir, args.db)
        if not db_path.is_file():
            raise RuntimeError(f"no credentials at {db_path}; nothing written")
        agents.check_owner(db.Database(db_path), token, handle)
    except (ValueError, sqlite3.Error, OSError) as exc:
        raise RuntimeError(f"--owner {handle}: {exc}; nothing written") from None


def label_context(labels: list[str]) -> dict:
    """The page template's labels: the meta tag's content, and the tags that
    end the header's date line."""
    return {
        "labels": html.escape(",".join(labels)),
        "label_tags": "".join(
            f' <span class="artifact-label">{html.escape(label)}</span>' for label in labels
        ),
    }


def keep_frame_names(body: str, files: dict[str, bytes], name: str,
                     frame_names: dict[str, str]) -> tuple[str, dict[str, bytes]]:
    """The body and frame files with each live block's frame named as
    frame_names gives for its id; the bytes stay today's."""
    for ident, (hash_, _, _) in widgets.PageWidgets(body).found.items():
        today, kept = f"{name}.w-{hash_}.html", frame_names.get(ident)
        if kept and kept != today and today in files:
            body = body.replace(html.escape(today), html.escape(kept))
            files = {kept if filename == today else filename: data
                     for filename, data in files.items()}
    return body, files


def build_page(args: argparse.Namespace) -> argparse.Namespace:
    """The page cmd_render writes, built without writing anything: its
    html, final body and live-block frame files (widget_files), with the
    warnings, refs and names of refs used (named) the writing needs."""
    with_comments = getattr(args, "comments", False)
    owner = getattr(args, "owner", "")
    if owner and not getattr(args, "owner_checked", False):
        check_owner(args, Path(args.out_dir) if args.out_dir else DEFAULT_OUTPUT_DIR)
    tokens = load_tokens()
    # The title bar already names the site; a kicker shows only an episode.
    kicker = f"Lotuspod · Episode {args.episode}" if args.episode else ""
    summary_block = f'<p class="artifact-summary">{args.summary}</p>' if args.summary else ""
    body = args.body
    out_dir = Path(args.out_dir) if args.out_dir else DEFAULT_OUTPUT_DIR
    markdown_path = getattr(args, "markdown", None)
    if markdown_path:
        # Read here rather than passed on the command line, so a body of any
        # size gets through; `-` reads standard input.
        if markdown_path == "-":
            text = sys.stdin.read()
        else:
            text = Path(markdown_path).read_text(encoding="utf-8")
        label = "standard input" if markdown_path == "-" else markdown_path
        store_dir = media.media_dir(out_dir)
        sizes = {}
        for line in markdown.images(text):
            if not line.src.startswith(media.URL_PREFIX):
                why = "render draws only /media/ URLs; publish stores a local image"
            else:
                image = media.load_stored(store_dir, line.src[len(media.URL_PREFIX):])
                if image is not None:
                    sizes[image.url] = (image.width, image.height)
                    continue
                why = f"names no image stored in {store_dir}"
            raise RuntimeError(f"image {line.src} in {label}: {why}; nothing written")
        body = markdown.to_body(text, sizes)
    body, widget_files, widget_warnings = widgets.render(body, args.name)
    if getattr(args, "frame_names", None):
        body, widget_files = keep_frame_names(body, widget_files, args.name, args.frame_names)
    body, has_node_tables = mark_node_tables(body)
    # Before the outline, so the forms sit inside their section.
    body, has_decisions = decisions.render_decisions(body, args.name)
    # Once the forms say which block each is about, so its chrome counts them.
    body = widgets.link_decisions(body)
    # After the forms, so no reference lands in a question or changes its
    # version; before the outline, so no heading's id is a card's.
    page_refs = getattr(args, "refs", None)
    body, refs_block, named = mark_refs(body, page_refs or {},
                                             getattr(args, "refs_as_of", ""))
    body, outline = (body, []) if args.no_outline else outline_body(body)
    # After the outline, so each box names its heading's id.
    whole_page_box = ""
    if with_comments:
        body = comments.render_comments(body, args.name)
        whole_page_box = comments.whole_page_box(body, args.name)
        if not whole_page_box and 'data-height-full="true"' in body:
            whole_page_box = comments.box(args.name, comments.PAGE_SECTION, "")
            body = body.replace(whole_page_box, '')
    # Last, so each section's box and forms fall inside its wrapper.
    body, wrapped, intro_digest = (sections.wrap_sections(body) if outline
                                   else (body, False, unit_digest(body)))
    date = args.date or _dt.date.today().isoformat()
    # Publish stamps the time it ran; a bare render stamps nothing. The header
    # names the updated day only when it is not the created one.
    updated = getattr(args, "updated", "")
    # Publish checks each label (publish_labels): no markup in any.
    labels = getattr(args, "labels", [])
    context = {
        "title": args.title,
        "kicker": kicker,
        "date": date,
        "updated": updated,
        "updated_day": updated[:10] if updated[:10] != date else "",
        "summary_block": summary_block,
        "intro_digest": intro_digest,
        **label_context(labels),
        "body": body,
        "whole_page_box": whole_page_box,
        "refs_block": refs_block,
        "outline": outline,
        "outline_items": outline_html(outline),
        "theme_name": tokens["name"],
        "theme_hash": theme_hash(),
        "visible": "false" if args.hidden else "true",
        "revision": getattr(args, "revision", ""),
        # A handle (check_owner, or a kept one publish checked): no markup.
        "owner": owner,
        "variant_class": variant_class(args.variant),
        "mermaid": has_mermaid_block(body),
        # A page stamped with a revision notices when it is published again,
        # a link off the site opens in a new tab, a diagram can be expanded
        # to fill the window, a calltree block folds, and a listed page
        # loaded on its own opens in the index's tabs.
        "page_script_needed": (not args.hidden or has_decisions or with_comments or wrapped
                               or bool(widget_files) or has_node_tables or bool(refs_block)
                               or bool(getattr(args, "revision", "")) or has_link(body)
                               or has_mermaid_block(body) or has_calltree_block(body)),
        "widget_bridge": ("(function () {\n"
                          + (core.THEME_ROOT / "features/widgets/ts/widgets.js").read_text(encoding="utf-8")
                          + "\ninstallWidgetBridge();\n})();" if widget_files else ""),
        "theme_head": (core.THEME_ROOT / "core/ts/theme-head.js").read_text(encoding="utf-8"),
        "page_script": PAGE_SCRIPT,
        "mermaid_theme_variables": mermaid_theme_variables(tokens) if has_mermaid_block(body) else "",
        "mermaid_dir": MERMAID_DIR,
        "mermaid_elk_dir": MERMAID_ELK_DIR,
    }
    # The header changes with the day it names as updated, not with the second
    # publish ran, so the same source published twice stamps the same digest.
    context["header_digest"] = unit_digest(*(context[key] for key in (
        "kicker", "title", "date", "updated_day", "label_tags", "owner",
        "summary_block",
    )))
    context["outline_digest"] = unit_digest(context["outline_items"])
    return argparse.Namespace(html=render_page(context), body=body, out_dir=out_dir,
                              widget_files=widget_files, widget_warnings=widget_warnings,
                              page_refs=page_refs, named=named)


def cmd_render(args: argparse.Namespace) -> int:
    if getattr(args, "comments", False) and args.no_outline:
        print("error: --comments needs the heading ids --no-outline leaves out; "
              "nothing written", file=sys.stderr)
        return 1
    built = build_page(args)
    html, body, out_dir = built.html, built.body, built.out_dir
    widget_files, widget_warnings = built.widget_files, built.widget_warnings
    page_refs, named = built.page_refs, built.named

    out_dir.mkdir(parents=True, exist_ok=True)
    out_path = out_dir / f"{args.name}.html"

    sync_theme_css(out_dir)

    for filename, data in widget_files.items():
        write_atomic(out_dir / filename, data)
    # The outgoing page's hashes first, so a page published before they were
    # kept keeps the ones it had.
    try:
        keep_block_hashes(out_dir, args.name, out_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError):
        pass
    write_atomic(out_path, html.encode("utf-8"))
    keep_block_hashes(out_dir, args.name, html)
    widget_name = re.compile(re.escape(args.name) + r"\.w-[0-9a-f]{12}\.html\Z")
    for stale in out_dir.iterdir():
        if widget_name.fullmatch(stale.name) and stale.name not in widget_files:
            stale.unlink()
    for warning in widget_warnings:
        print(warning, file=sys.stderr)
    # Publish keeps the entries the page used beside it; a page that uses
    # none keeps no file.
    if page_refs is not None:
        refs_path = out_dir / f"{args.name}{REFS_SUFFIX}"
        if named:
            kept = {"asOf": args.refs_as_of, "refs": {key: page_refs[key] for key in named}}
            write_atomic(refs_path, (json.dumps(kept, indent=2, ensure_ascii=False) + "\n")
                         .encode("utf-8"))
        else:
            refs_path.unlink(missing_ok=True)
    warning = script_warning(args.name, body)
    if warning:
        print(warning, file=sys.stderr)
    source = getattr(args, "source", None)
    if source:
        destination = out_dir / f"{args.name}.md"
        # The source may already be the copy beside the page, edited in place.
        if not (destination.exists() and Path(source).samefile(destination)):
            shutil.copyfile(source, destination)
    print(f"rendered {out_path}")
    if getattr(args, "commit", True):
        commit_output(out_dir, f"render {args.name}")
    return 0


# The references a published page's cards were drawn from, and when they
# were taken: kept beside it, never served.
REFS_SUFFIX = ".refs.json"
# The largest refs file publish reads, in bytes.
REFS_MAX = 1 << 20
# Each live block's widget file hashes over the page's visible publishes,
# kept beside it, never served: the comments route takes a thread on any of
# them, with or without the site's git history.
BLOCKS_SUFFIX = ".blocks.json"


def kept_block_hashes(out_dir: Path, name: str) -> dict[str, list[str]]:
    """Each live block id to the hashes NAME.blocks.json keeps for it,
    oldest first; {} when there is no file or it cannot be read."""
    try:
        kept = json.loads((out_dir / f"{name}{BLOCKS_SUFFIX}").read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, ValueError):
        return {}
    blocks = kept.get("blocks") if isinstance(kept, dict) else None
    if not isinstance(blocks, dict):
        return {}
    return {ident: [hash_ for hash_ in hashes if isinstance(hash_, str)]
            for ident, hashes in blocks.items() if isinstance(hashes, list)}


def keep_block_hashes(out_dir: Path, name: str, page_html: str) -> None:
    """Add the live blocks' hashes of NAME's page_html, when it is
    visible, to NAME.blocks.json; a page that never had a block keeps no
    file."""
    found = widgets.PageWidgets(page_html).found
    if not found or not extract_visibility(page_html):
        return
    blocks = kept_block_hashes(out_dir, name)
    for ident, (hash_, _, _) in found.items():
        hashes = blocks.setdefault(ident, [])
        if hash_ not in hashes:
            hashes.append(hash_)
    write_atomic(out_dir / f"{name}{BLOCKS_SUFFIX}",
                 (json.dumps({"blocks": blocks}, indent=2) + "\n").encode("utf-8"))


_MAIN_CLASS_RE = re.compile(r'<main class="([^"]*)"')


def version_stamp(page_html: str) -> tuple[str, bool, str]:
    """A page's lotuspod:revision ("" when none), whether it is visible and
    the handle its lotuspod:owner names ("" when none does), read from its
    HTML alone: what lotuspod.features.history.versions keeps of each version."""
    tag = _REVISION_TAG_RE.search(page_html)
    content = _META_CONTENT_RE.search(tag.group(0)) if tag else None
    owner = page_owner(page_html)
    return ((content.group(1).strip() if content else ""), extract_visibility(page_html),
            owner if agents.is_handle(owner) else "")


def page_variant(page_html: str) -> str:
    """The render variant a page's main element carries."""
    main = _MAIN_CLASS_RE.search(page_html)
    classes = main.group(1).split() if main else []
    for variant in VARIANTS:
        stamp = variant_class(variant).strip()
        if stamp and stamp in classes:
            return variant
    return DEFAULT_VARIANT
