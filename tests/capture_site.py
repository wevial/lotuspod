"""Capture fixture: a served sample site around one command.

Renders a fixed sample site with this checkout's own CLI into a fresh
temporary directory, serves it with the site's own allow-list server on
127.0.0.1 and a free port, runs the command it was given with the site's URL
in LOTUSPOD_URL, then stops the server, removes the directory and exits with
the command's code. It never reads or writes the operator's artifacts/ and
never binds the tailnet address.

Run from the repo root:

    python -m tests.capture_site COMMAND [ARG...]

The fixture always renders this checkout: the repo's src/ directory is put at
the front of sys.path, so an ambient lotuspod install (editable or not)
can never shadow the code under capture.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import threading
from contextlib import redirect_stdout
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

from lotuspod import cli  # noqa: E402


HOST = "127.0.0.1"
URL_ENV = "LOTUSPOD_URL"
# A fixed date, so every run renders the same bytes.
SAMPLE_DATE = "2026-01-01"

# No mermaid block anywhere: the page template would load Mermaid from a CDN,
# and a capture without network must render the same page.
ARTICLE_BODY = """\
<p>A sample article for captures: two sections and one question.</p>
<h2>First section</h2>
<p>The outline links here.</p>
<h2>Second section</h2>
<p>The task list below renders as a response form.</p>
<ul>
<li><input type="checkbox" disabled> Looks right</li>
<li><input type="checkbox" disabled> Needs work</li>
</ul>
"""

REPORT_BODY = """\
<p>A sample report for captures: the denser reading surface.</p>
<h2>Findings</h2>
<p>The outline sits in the left rail.</p>
<h2>Method</h2>
<p>Rendered with the report variant.</p>
"""

HIDDEN_BODY = "<p>A hidden page: rendered, never listed, never served.</p>\n"

SAMPLE_PAGES = (
    ("capture-article", "Capture article", ARTICLE_BODY, ()),
    ("capture-report", "Capture report", REPORT_BODY, ("--variant", "report")),
    ("capture-hidden", "Capture hidden", HIDDEN_BODY, ("--hidden",)),
)


def render(out_dir: Path) -> None:
    """Render the sample pages and then the index into out_dir.

    Calls the CLI in process, the same code the installed `lotuspod` command
    runs. Raises RuntimeError naming the step that failed.
    """
    steps = [
        (
            f"render {name}",
            [
                "render", "--name", name, "--title", title, "--body", body,
                "--date", SAMPLE_DATE, "--out-dir", str(out_dir), *extra,
            ],
        )
        for name, title, body, extra in SAMPLE_PAGES
    ]
    steps.append(("index", ["index", "--out-dir", str(out_dir)]))
    for step, argv in steps:
        # The CLI reports on stdout; keep that stream for COMMAND alone.
        with redirect_stdout(sys.stderr):
            try:
                rc = cli.main(argv)
            except SystemExit as exc:
                rc = exc.code if isinstance(exc.code, int) else 1
        if rc != 0:
            raise RuntimeError(f"{step} failed with exit code {rc}")


def main(argv: list[str] | None = None) -> int:
    command = list(sys.argv[1:] if argv is None else argv)
    if not command:
        print("usage: python -m tests.capture_site COMMAND [ARG...]", file=sys.stderr)
        return 2

    directory = Path(tempfile.mkdtemp(prefix="lotuspod-capture-"))
    server = None
    thread = None
    try:
        try:
            render(directory)
        except Exception as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1
        server = cli._make_server(directory, HOST, 0)
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        env = dict(os.environ)
        env[URL_ENV] = f"http://{HOST}:{port}"
        try:
            return subprocess.run(command, cwd=str(REPO_ROOT), env=env, check=False).returncode
        except OSError as exc:
            print(f"error: cannot run {command[0]}: {exc}", file=sys.stderr)
            return 1
    finally:
        if server is not None:
            if thread is not None:
                server.shutdown()
            server.server_close()
        shutil.rmtree(directory, ignore_errors=True)


if __name__ == "__main__":
    raise SystemExit(main())
