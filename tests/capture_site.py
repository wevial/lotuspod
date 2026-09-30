"""Capture fixture: a served sample site around one command.

Renders a fixed sample site with this checkout's own CLI into a fresh
temporary directory, serves it with the site's own allow-list server on
127.0.0.1 and a free port, runs the command it was given with the site's URL
in LOTUSPOD_URL, then stops the server, removes the directory and exits with
the command's code. The site trusts the test Access key
(tests/fixtures/access/), and LOTUSPOD_TEST_ASSERTION holds an assertion it
accepts, for a browser check to send as Cf-Access-Jwt-Assertion. Answers and
comments go to a database in the same temporary directory, beside the
rendered site and never in it; it also holds the credential that lets the
comments page name `hermes` as its owner. It never reads or writes the operator's
artifacts/ and never binds the tailnet address.

Run from the repo root:

    python -m tests.capture_site COMMAND [ARG...]

The fixture always renders this checkout: the repo's src/ directory is put at
the front of sys.path, so an ambient lotuspod install (editable or not)
can never shadow the code under capture.
"""

from __future__ import annotations

import datetime
import os
import shutil
import subprocess
import sys
import tempfile
import threading
import types
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

REPO_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO_ROOT / "src"))

from lotuspod import access, cli, db, machine  # noqa: E402
from tests import access_keys  # noqa: E402


HOST = "127.0.0.1"
URL_ENV = "LOTUSPOD_URL"
ASSERTION_ENV = "LOTUSPOD_TEST_ASSERTION"
# How long the fixture's assertion stays valid: longer than any capture run.
ASSERTION_LIFETIME = 24 * 3600
# A fixed date, so every run renders the same bytes.
SAMPLE_DATE = "2026-01-01"
# The owner the comments page names, and the credential allowed to name it.
OWNER = "hermes"


class _SampleDay(datetime.date):
    @classmethod
    def today(cls) -> datetime.date:
        return cls.fromisoformat(SAMPLE_DATE)


def _sample_clock() -> types.ModuleType:
    """The datetime module as cli.py reads it, with today() held at SAMPLE_DATE.

    `index` has no --date: it stamps the page with date.today().
    """
    clock = types.ModuleType("datetime")
    clock.__dict__.update(vars(datetime))
    clock.date = _SampleDay
    return clock


# Only the diagram page has a mermaid block: its page loads Mermaid from
# jsDelivr, which a browser check answers from the copy pinned in e2e/.
ARTICLE_BODY = """\
<p>A sample article for captures: two sections.</p>
<h2>First section</h2>
<p>The outline links here.</p>
<h2>Second section</h2>
<p>Rendered with the article variant.</p>
"""

REPORT_BODY = """\
<p>A sample report for captures: the denser reading surface.</p>
<h2>Findings</h2>
<p>The outline sits in the left rail.</p>
<h2>Method</h2>
<p>Rendered with the report variant.</p>
"""

HIDDEN_BODY = "<p>A hidden page: rendered, never listed, never served.</p>\n"

DIAGRAM_BODY = """\
<p>A sample diagram, drawn by the pinned Mermaid under the page policy.</p>
<pre class="mermaid">graph LR
  A[Write] --> B[Publish] --> C[Read]</pre>
"""

# Every script here is refused by the page policy: the page shows
# "Nothing written." twice, before and after its button is pressed.
SCRIPTS_BODY = """\
<p>A sample page whose body holds scripts. None of them runs.</p>
<p id="inline-output">Nothing written.</p>
<script>document.getElementById("inline-output").textContent = "The inline script ran.";</script>
<script src="https://scripts.example.com/widget.js"></script>
<p><button type="button" onclick="document.getElementById('handler-output').textContent = 'The handler ran.'">Press me</button></p>
<p id="handler-output">Nothing written.</p>
"""

# A plan page ending in a decisions table: render makes each row a form the
# page script answers. No diagram, so the page needs no network.
DECISIONS_BODY = """\
<p>A sample plan for captures: two questions for the maintainer.</p>
<h2>Plan</h2>
<p>The responder needs a model, and the archive needs a rule.</p>
<h2>Decisions for the maintainer</h2>
<table>
<thead><tr><th>#</th><th>Question</th><th>Options</th><th>Default</th><th>Why it matters</th></tr></thead>
<tbody>
<tr><td>1</td><td>Which model replies?</td><td>Sonnet / Opus</td><td>Sonnet</td><td>Replies run on every comment.</td></tr>
<tr><td>2</td><td>Keep the archive?</td><td>Yes / No</td><td>Yes</td><td>Old pages stay linkable.</td></tr>
</tbody>
</table>
"""

# A plan page with a comment box ending each of its three sections, owned by
# OWNER. No diagram, so the page needs no network.
COMMENTS_BODY = """\
<p>A sample plan for captures: every section takes comments.</p>
<h2>Findings</h2>
<p>The pond freezes in January, and the pump stops with it.</p>
<h2>Risks</h2>
<p>A frozen pump may crack before anyone notices.</p>
<h2>Next steps</h2>
<p>Fit a heater before the first frost.</p>
"""

SAMPLE_PAGES = (
    ("capture-article", "Capture article", ARTICLE_BODY, ()),
    ("capture-report", "Capture report", REPORT_BODY, ("--variant", "report")),
    ("capture-hidden", "Capture hidden", HIDDEN_BODY, ("--hidden",)),
    ("capture-diagram", "Capture diagram", DIAGRAM_BODY, ()),
    ("capture-scripts", "Capture body scripts", SCRIPTS_BODY, ()),
    ("capture-decisions", "Capture decisions", DECISIONS_BODY, ()),
    ("capture-comments", "Capture comments", COMMENTS_BODY,
     ("--comments", "--owner", OWNER)),
)


def render(out_dir: Path, db_path: Path) -> None:
    """Render the sample pages and then the index into out_dir.

    Makes OWNER's publishing credential in the database at db_path first, its
    token beside the database. Calls the CLI in process, the same code the
    installed `lotuspod` command runs. Raises RuntimeError naming the step
    that failed.
    """
    token = db_path.with_name(f"{OWNER}.token")
    machine.create_credential(db.Database(db_path), OWNER, [OWNER], ["publish"], token)
    steps = [
        (
            f"render {name}",
            [
                "render", "--name", name, "--title", title, "--body", body,
                "--date", SAMPLE_DATE, "--out-dir", str(out_dir),
                "--credential", str(token), "--db", str(db_path), *extra,
            ],
        )
        for name, title, body, extra in SAMPLE_PAGES
    ]
    steps.append(("index", ["index", "--out-dir", str(out_dir)]))
    for step, argv in steps:
        # The CLI reports on stdout; keep that stream for COMMAND alone.
        with redirect_stdout(sys.stderr), mock.patch.object(cli, "_dt", _sample_clock()):
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
    site = directory / "site"
    server = None
    thread = None
    try:
        try:
            site.mkdir()
            render(site, directory / db.DEFAULT_NAME)
        except Exception as exc:
            print(f"error: {exc}", file=sys.stderr)
            return 1
        verifier = access.Verifier(access.parse_config(access_keys.config_section()))
        server = cli._make_server(
            site, HOST, 0, verifier=verifier, db_path=directory / db.DEFAULT_NAME
        )
        port = server.server_address[1]
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        env = dict(os.environ)
        env[URL_ENV] = f"http://{HOST}:{port}"
        env[ASSERTION_ENV] = access_keys.assertion(lifetime=ASSERTION_LIFETIME)
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
