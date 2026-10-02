"""Browser check helper: render a page from a changed copy of the theme.

The browser check e2e/checks/theme.spec.ts runs this with the capture
fixture's Python (LOTUSPOD_TEST_PYTHON) to render the page `theme-change`
into the fixture's site (LOTUSPOD_TEST_OUT):

    python -m tests.theme_change change COMMENT
        copies the packaged theme to a scratch directory, appends COMMENT to
        the copy's stylesheet and renders the page with cli.THEME_DIR
        pointed at the copy, so the site serves the changed stylesheet;
    python -m tests.theme_change restore
        renders the page again from the packaged theme, so the site serves
        the packaged stylesheet once more.

The fixture renders this checkout: the repo's src/ directory is put at the
front of sys.path.
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

from lotuspod import cli  # noqa: E402

NAME = "theme-change"
OUT_ENV = "LOTUSPOD_TEST_OUT"
SAMPLE_DATE = "2026-01-01"
BODY = "<p>A page rendered from a changed copy of the theme.</p>\n"


def render(out_dir: Path) -> None:
    argv = [
        "render", "--name", NAME, "--title", "Theme change", "--body", BODY,
        "--date", SAMPLE_DATE, "--out-dir", str(out_dir),
    ]
    # The CLI reports on stdout; keep that stream quiet for the caller.
    with redirect_stdout(sys.stderr):
        rc = cli.main(argv)
    if rc != 0:
        raise RuntimeError(f"render {NAME} failed with exit code {rc}")


def main(argv: list[str] | None = None) -> int:
    args = list(sys.argv[1:] if argv is None else argv)
    out = os.environ.get(OUT_ENV, "")
    valid = args == ["restore"] or (len(args) == 2 and args[0] == "change")
    if not out or not valid:
        print(f"usage: {OUT_ENV}=DIR python -m tests.theme_change change COMMENT | restore",
              file=sys.stderr)
        return 2
    out_dir = Path(out)
    if args[0] == "restore":
        render(out_dir)
        return 0
    with tempfile.TemporaryDirectory(prefix="lotuspod-theme-") as scratch:
        theme = Path(scratch) / "theme"
        shutil.copytree(cli.THEME_DIR, theme)
        with (theme / "lotuspod.css").open("a", encoding="utf-8") as fh:
            fh.write(args[1])
        with mock.patch.object(cli, "THEME_DIR", theme):
            render(out_dir)
    return 0


if __name__ == "__main__":
    sys.exit(main())
