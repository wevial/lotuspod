"""The site's listing of its visible pages, and the index page built from it."""

from __future__ import annotations

import datetime as _dt
import html
from pathlib import Path

from lotuspod import core
from lotuspod.core import (extract_meta, _git, is_page_name, is_repository_top, load_tokens,
                           package_path, render_template, theme_hash)
from lotuspod.features import history


INDEX_TEMPLATE_PATH = package_path("features", "index", "templates", "index.html")
# The head's theme script, relative to THEME_ROOT.
THEME_HEAD_SOURCE = "core/ts/theme-head.js"


# How git log marks each commit's line among the file names it lists: a
# file name never holds a NUL.
_COMMIT_FORMAT = "%x00%cI"
_COMMIT_MARK = "\x00"


def committed_times(out_dir: Path) -> dict[str, str]:
    """Each page's newest commit time, UTC, by file name, from one git log.

    Empty unless out_dir is the top of its own repository with commits."""
    if not is_repository_top(out_dir):
        return {}
    try:
        done = _git(out_dir, "-c", "core.quotePath=false", "log",
                    f"--format={_COMMIT_FORMAT}", "--name-only", "--", "*.html")
    except OSError:
        return {}
    if done.returncode != 0:
        return {}
    times: dict[str, str] = {}
    when = ""
    for line in done.stdout.splitlines():
        if line.startswith(_COMMIT_MARK):
            # git prints the committer's offset (+00:00, or a local one):
            # parse it and store the time as UTC Z, as publish stamps it.
            try:
                when = core._utc_stamp(_dt.datetime.fromisoformat(line[len(_COMMIT_MARK):]))
            except ValueError:
                when = ""
        elif line and when:
            # Newest first: the first commit that names a page is its last.
            times.setdefault(line, when)
    return times


def collect_artifacts(out_dir: Path) -> tuple[list[dict], int]:
    """Parse every artifact page; return (visible entries, hidden count).

    A page publish never stamped takes its updated time from its newest
    commit when out_dir is the top of its own repository, else its created
    date. Visible entries come back newest update first (filename as the
    tiebreaker) so the index leads with what moved."""
    pages = sorted(p for p in out_dir.glob("*.html") if is_page_name(p.name))
    metas = [extract_meta(p.read_text(encoding="utf-8"), p.stem) for p in pages]
    visible = [m for m in metas if m["visible"]]
    unstamped = [m for m in visible if not m["updated"]]
    committed = committed_times(out_dir) if unstamped else {}
    for meta in unstamped:
        meta["updated"] = committed.get(meta["file"], meta["created"])
    for meta in visible:
        record = history.read_record(out_dir, meta["file"].removesuffix(".html"))
        if record is not None:
            meta["archived"] = record["archivedAt"]
            meta["supersededBy"] = record["supersededBy"] or ""
    visible.sort(key=lambda m: m["updated"], reverse=True)
    return visible, len(metas) - len(visible)


_INDEX_EMPTY_BLOCK = (
    '<p class="index-empty">Nothing in the pond yet. Render one with '
    "<code>lotuspod render</code>.</p>"
)


def index_entries_html(artifacts: list[dict]) -> str:
    """Render manifest-style metadata into the index page's table.

    Pages are uniform records, so they are listed as rows: one column per
    field lets a reader scan a single field down the page, and gives the index
    script a grid to sort and filter. The markup is a complete listing on its
    own - the script only adds sorting and the search filter on top.
    """
    if not artifacts:
        return _INDEX_EMPTY_BLOCK
    esc = html.escape

    def date_cell(value: str, clock: bool = False) -> str:
        # The full time sorts; the cell shows its UTC day, and with clock its
        # time of day too when the value has one.
        value = esc(value)
        shown = value[:10]
        if clock and value[10:11] == "T" and len(value) >= 16:
            shown += f" {value[11:16]}"
        return f'<time datetime="{value}">{shown}</time>' if value else ""

    rows = []
    for meta in artifacts:
        href = esc(str(meta["file"]))
        title = esc(str(meta["title"]))
        summary = esc(str(meta["summary"]))
        labels = [esc(str(label)) for label in meta["labels"]]
        # The row names its page, for the index script's updated marks. The
        # labels ride under the title as tags, and on the row for the index
        # script's Labels filter.
        name = esc(str(meta["file"]).removesuffix(".html"))
        labelled = f' data-labels="{",".join(labels)}"' if labels else ""
        # An archived page's row is left out of the default list, with or
        # without the index script, which shows it behind its Archived toggle.
        stamp = esc(str(meta.get("archived") or ""))
        archived = f' data-archived="{stamp}" hidden' if stamp else ""
        row = f'<tr data-page="{name}"{labelled}{archived}>'
        tags = (
            ' <span class="index-tags">'
            + " ".join(f'<span class="index-tag">{label}</span>' for label in labels)
            + "</span>"
        ) if labels else ""
        rows.append(
            f"          {row}\n"
            f'            <td class="episode-title"><a href="{href}">{title}</a>{tags}</td>\n'
            f'            <td class="episode-date">{date_cell(str(meta["updated"]), clock=True)}</td>\n'
            f'            <td class="episode-date">{date_cell(str(meta["created"]))}</td>\n'
            f'            <td class="episode-summary">{summary}</td>\n'
            "          </tr>"
        )
    return (
        '<table class="index-table">\n'
        "        <thead>\n"
        "          <tr>\n"
        '            <th scope="col">Title</th>\n'
        '            <th scope="col" aria-sort="descending">Updated</th>\n'
        '            <th scope="col">Created</th>\n'
        '            <th scope="col">Summary</th>\n'
        "          </tr>\n"
        "        </thead>\n"
        "        <tbody>\n"
        + "\n".join(rows)
        + "\n        </tbody>\n      </table>"
    )


def render_index(artifacts: list[dict], generated: str = "") -> str:
    """The index page's text for a visible set, updated on the day generated
    (YYYY-MM-DD; today when empty)."""
    tokens = load_tokens()
    context = {
        "generated": generated or _dt.date.today().isoformat(),
        "entries_block": index_entries_html(artifacts),
        "theme_name": tokens["name"],
        "theme_hash": theme_hash(),
        # The head script pages carry, so the shell follows the reader's
        # theme from its first paint. The index has no policy meta; one added
        # must allow this script by its hash, as page_policy() does.
        "theme_head": (core.THEME_ROOT / THEME_HEAD_SOURCE).read_text(encoding="utf-8"),
    }
    return render_template(context, INDEX_TEMPLATE_PATH)
