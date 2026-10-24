"""`lotuspod manifest`: manifest.json, the site's visible pages as the index
slice's listing reads them (lotuspod.features.index.listing)."""

from __future__ import annotations

import argparse
import json
from pathlib import Path

from lotuspod.core import (DEFAULT_OUTPUT_DIR, MANIFEST_FILE, commit_output, sync_theme_css,
                           write_atomic)


MANIFEST_VERSION = 2


def cmd_manifest(args: argparse.Namespace) -> int:
    # The listing imports the archive, which imports this slice: both are
    # read at call time.
    from lotuspod.features import index
    from lotuspod.features.index import _hidden_note

    out_dir = Path(args.out_dir) if args.out_dir else DEFAULT_OUTPUT_DIR
    if not out_dir.is_dir():
        raise FileNotFoundError(f"artifacts directory not found: {out_dir}")

    artifacts, hidden = index.collect_artifacts(out_dir)
    sync_theme_css(out_dir)

    manifest_path = out_dir / MANIFEST_FILE
    write_atomic(
        manifest_path,
        (
            json.dumps({"version": MANIFEST_VERSION, "artifacts": artifacts}, indent=2)
            + "\n"
        ).encode("utf-8"),
    )
    print(f"wrote {manifest_path} ({len(artifacts)} artifacts{_hidden_note(hidden)})")
    if getattr(args, "commit", True):
        commit_output(out_dir, "manifest")
    return 0
