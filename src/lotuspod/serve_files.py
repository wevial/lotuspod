"""What serve may answer from the output directory, and the database it keeps."""

from __future__ import annotations

import argparse
from pathlib import Path

from lotuspod import widgets
from lotuspod.core import (DEFAULT_OUTPUT_DIR, INDEX_FILE, INDEX_SCRIPT, MANIFEST_FILE,
                           OLD_VERSION_SCRIPT, PAGE_SCRIPT, WIDGET_NAME, extract_visibility,
                           is_page_name)
from lotuspod.store import db


_SERVE_CSS_FILE = "lotuspod.css"
_SERVE_ICON_FILE = "favicon.svg"
_SERVE_SUPPORT_FILES = (_SERVE_CSS_FILE, _SERVE_ICON_FILE, PAGE_SCRIPT, INDEX_SCRIPT,
                        OLD_VERSION_SCRIPT)
_SERVE_NEVER_FILES = frozenset({MANIFEST_FILE, "FINDINGS.md"})


def serve_allow_list(out_dir: Path) -> frozenset[str]:
    """Names serve v2 may answer with: visible pages + support files.

    Same fail-closed rule as manifest/index: an artifact page is servable
    only when its lotuspod:visible meta flag parses to exactly true.
    manifest.json and FINDINGS.md are never served (_SERVE_NEVER_FILES):
    the manifest lists private artifact ids, so it must stay unreachable
    over HTTP even though it lives in the served directory. Sources
    (NAME.body.html, like NAME.md), dotfiles and symbolic links are never
    pages, so they are never listed, and neither is a page's kept refs
    (NAME.refs.json) or block hashes (NAME.blocks.json), which are no
    pages either.
    """
    allowed = {INDEX_FILE, *_SERVE_SUPPORT_FILES}
    try:
        pages = sorted(out_dir.glob("*.html"))
    except OSError:
        return allowed
    for page in pages:
        if not is_page_name(page.name):
            continue
        try:
            if page.is_symlink():
                continue
            page_text = page.read_text(encoding="utf-8")
            visible = extract_visibility(page_text)
        except (OSError, UnicodeDecodeError):
            continue
        if visible:
            allowed.add(page.name)
            for src in widgets.Frames(page_text).sources:
                if (WIDGET_NAME.fullmatch(src) and src.startswith(page.stem + ".w-")
                        and "/" not in src and not (out_dir / src).is_symlink()):
                    allowed.add(src)
    return frozenset(allowed)


def serve_db_path(out_dir: Path, db_arg: str) -> Path:
    """The database serve keeps: --db, else lotuspod.sqlite3 beside the
    output directory. ValueError when it would sit inside the output
    directory, which the artifacts repository commits whole."""
    out_dir = out_dir.resolve()
    path = Path(db_arg).resolve() if db_arg else out_dir.parent / db.DEFAULT_NAME
    if path == out_dir or out_dir in path.parents:
        raise ValueError(
            f"--db {db_arg or path} is inside the output directory {out_dir}; "
            "the artifacts repository would commit it"
        )
    return path


def serve_database(args: argparse.Namespace) -> db.Database:
    """The database serve keeps for the same --out-dir and --db."""
    out_dir = Path(args.out_dir) if args.out_dir else DEFAULT_OUTPUT_DIR
    return db.Database(serve_db_path(out_dir, args.db))
